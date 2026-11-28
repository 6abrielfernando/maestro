'use strict';
// =====================================================================================
//  Cuenta AVI (BSM) para Maestro — OPCIONAL.
//  Sin cuenta, Maestro funciona exactamente igual que siempre.
//  Con cuenta vinculada:
//    · Los shows de BSM aparecen en Maestro y se mantienen al día en tiempo real.
//    · Lo que cambias en Maestro en un show vinculado vuelve a BSM.
//    · Si llega un cambio mientras suena algo, se aplica al parar (nunca en pleno show).
//    · Sin internet sigue con lo último recibido y envía lo pendiente al volver.
//  No usa dependencias: fetch y WebSocket nativos (Node 22 / Electron).
// =====================================================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SB_URL = process.env.BSM_URL || 'https://aohmgjhvprayalrozrxn.supabase.co';
const SB_KEY = process.env.BSM_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFvaG1namh2cHJheWFscm96cnhuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxMDQ2NDYsImV4cCI6MjA5OTY4MDY0Nn0.M0mbLSviO5LdP0JMjhYX6Ud04-yhkeoFuy6dNYXWvUM';
const BSM_WEB = 'https://bsm.avimusica.com';

let H = null;            // funciones del servidor (show, biblioteca, avisos)
let FILE = null;         // datos de la cuenta en disco
let C = { session: null, deviceId: null, pendientes: {}, firmas: {} };
let estado = { conectado: false, tiempoReal: false, error: null, ultimo: null, codigo: null, vinculando: false };
let canciones = [];      // caché de canciones de BSM (con versiones)
let ws = null, wsRef = 0, wsLatido = null, wsReintento = 1000, refrescoT = null;
let aplicandoRemoto = false;
const diferidos = new Map();   // showBsmId -> registro remoto pendiente (llegó mientras sonaba)
const subidaT = new Map();     // showLocalId -> temporizador de subida

// ---------------------------------- utilidades ----------------------------------
function guardar() { try { fs.writeFileSync(FILE, JSON.stringify(C)); } catch (e) { H.log('cuenta: guardar', e); } }
function aviso() { H.onChange(publico()); }
function publico() {
  return {
    vinculada: !!C.session, email: C.session ? C.session.user.email : null, ...estado,
    shows: H.listShows().filter((s) => s.bsm).length, web: BSM_WEB, diferidos: diferidos.size, pendientes: Object.keys(C.pendientes).length,
  };
}
const normTit = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\.[a-z0-9]{2,4}$/, '').replace(/^\d+[\s._-]+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const base = (f) => String(f || '').split('/').pop();
const uuid = () => crypto.randomUUID();
const quien = () => 'maestro:' + C.deviceId;

// ---------------------------------- autenticación ----------------------------------
async function auth(ruta, body) {
  const r = await fetch(SB_URL + '/auth/v1/' + ruta, { method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.msg || j.message || ('error ' + r.status));
  return j;
}
function tomarSesion(j) {
  C.session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600), user: { id: j.user.id, email: j.user.email } };
  guardar();
}
async function renovar() {
  if (!C.session) return false;
  try { tomarSesion(await auth('token?grant_type=refresh_token', { refresh_token: C.session.refresh_token })); return true; }
  catch (e) {
    // Sesión revocada o caducada del todo: hay que volver a vincular
    if (/refresh token|invalid|not found|revoked/i.test(e.message)) { estado.error = 'La sesión caducó. Vuelve a vincular Maestro.'; C.session = null; guardar(); cerrarWs(); aviso(); }
    return false;
  }
}
function programarRenovacion() {
  clearTimeout(refrescoT);
  if (!C.session) return;
  const ms = Math.max(30e3, (C.session.expires_at * 1000 - Date.now()) - 5 * 60e3);
  refrescoT = setTimeout(async () => { if (await renovar()) { enviarWs('realtime:maestro', 'access_token', { access_token: C.session.access_token }); programarRenovacion(); } else setTimeout(programarRenovacion, 60e3); }, ms);
  refrescoT.unref && refrescoT.unref();
}

// ---------------------------------- REST (PostgREST) ----------------------------------
async function rest(metodo, ruta, body, extra = {}) {
  if (!C.session) throw new Error('sin cuenta');
  if (C.session.expires_at * 1000 < Date.now() + 60e3) await renovar();
  const hacer = () => fetch(SB_URL + '/rest/v1/' + ruta, { method: metodo, headers: { apikey: SB_KEY, Authorization: 'Bearer ' + C.session.access_token, 'Content-Type': 'application/json', Prefer: 'return=representation', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  let r = await hacer();
  if (r.status === 401 && await renovar()) r = await hacer();
  const txt = await r.text();
  if (!r.ok) throw new Error('BSM ' + r.status + ': ' + txt.slice(0, 200));
  return txt ? JSON.parse(txt) : null;
}

// ---------------------------------- vincular ----------------------------------
async function conPassword(email, password) {
  tomarSesion(await auth('token?grant_type=password', { email, password }));
  await alVincular();
}
async function conCodigo() {
  if (estado.vinculando) return { codigo: estado.codigo };
  const r = await fetch(SB_URL + '/functions/v1/maestro-vincular', { method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ accion: 'iniciar', dispositivo: nombreEquipo() }) });
  const j = await r.json();
  if (!j.codigo) throw new Error('No se pudo pedir un código');
  estado.codigo = j.codigo; estado.vinculando = true; estado.error = null; aviso();
  const limite = new Date(j.expira).getTime();
  (async function esperar() {
    while (estado.vinculando && Date.now() < limite) {
      await new Promise((ok) => setTimeout(ok, 3000));
      try {
        const q = await (await fetch(SB_URL + '/functions/v1/maestro-vincular', { method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ accion: 'consultar', codigo: j.codigo, secreto: j.secreto }) })).json();
        if (q.estado === 'aprobado' && q.token_hash) {
          tomarSesion(await auth('verify', { type: 'magiclink', token_hash: q.token_hash }));
          estado.vinculando = false; estado.codigo = null; await alVincular(); return;
        }
        if (q.estado === 'rechazado' || q.estado === 'caducado' || q.error) break;
      } catch { /* sin internet un momento: seguimos esperando */ }
    }
    if (estado.vinculando) { estado.vinculando = false; estado.codigo = null; estado.error = 'El código caducó o se rechazó. Pide otro.'; aviso(); }
  })();
  return { codigo: j.codigo, enlace: BSM_WEB + '/maestro?codigo=' + j.codigo };
}
function cancelarCodigo() { estado.vinculando = false; estado.codigo = null; aviso(); }
function nombreEquipo() { return (os.hostname() || 'Maestro').replace(/\.local$/i, '').slice(0, 60); }

async function alVincular() {
  estado.error = null;
  try { await rest('POST', 'maestro_dispositivos?on_conflict=id', { id: C.deviceId, user_id: C.session.user.id, nombre: nombreEquipo(), visto: new Date().toISOString(), revocado: false }, { Prefer: 'resolution=merge-duplicates,return=minimal' }); } catch (e) { H.log('cuenta: registrar dispositivo', e); }
  programarRenovacion();
  await sincronizarTodo();
  abrirWs();
}
function desvincular() {
  const s = C.session; C.session = null; C.pendientes = {}; guardar();
  cerrarWs(); clearTimeout(refrescoT);
  // Los shows quedan en Maestro como shows normales (no se borra nada)
  for (const it of H.listShows()) { const sh = H.readShow(it.id); if (sh && sh.bsm_show_id) { delete sh.bsm_show_id; delete sh.bsm_updated_at; sh.origen = 'bsm-copia'; aplicandoRemoto = true; try { H.writeShow(it.id, sh); } finally { aplicandoRemoto = false; } } }
  if (s) fetch(SB_URL + '/auth/v1/logout', { method: 'POST', headers: { apikey: SB_KEY, Authorization: 'Bearer ' + s.access_token } }).catch(() => {});
  estado = { conectado: false, tiempoReal: false, error: null, ultimo: null, codigo: null, vinculando: false };
  H.showsChanged(); aviso();
}

// ---------------------------------- BSM → Maestro ----------------------------------
function buscarArchivo(titulo, archivo) {
  const lib = H.listSongs();
  if (archivo) {
    const b = base(archivo).toLowerCase();
    const x = lib.find((s) => s.file === archivo) || lib.find((s) => base(s.file).toLowerCase() === b);
    if (x) return x.file;
  }
  const t = normTit(titulo); if (!t) return '';
  const exacta = lib.find((s) => normTit(s.title || s.file) === t); if (exacta) return exacta.file;
  const parecidas = lib.filter((s) => { const n = normTit(s.title || s.file); return n.length > 3 && (n.includes(t) || t.includes(n)); });
  return parecidas.length === 1 ? parecidas[0].file : '';
}
function aItems(guion, previos) {
  const prev = new Map((previos || []).map((i) => [i.id, i]));
  const porCancion = new Map(canciones.map((c) => [c.id, c]));
  return (Array.isArray(guion) ? guion : []).map((e) => {
    const p = prev.get(e.id) || {};
    const after = e.despues === 'seguir' ? 'continue' : 'wait';
    if (e.tipo === 'bloque' || e.tipo === 'nota') return { ...p, id: e.id, type: 'block', title: e.titulo || (e.tipo === 'nota' ? 'Nota' : 'Bloque'), note: e.nota || '', bsm: { tipo: e.tipo } };
    if (e.tipo === 'silencio') return { ...p, id: e.id, type: 'silence', seconds: e.segundos || 5, note: e.nota || '', after, bsm: { tipo: 'silencio' } };
    const c = porCancion.get(e.cancion_id);
    const vs = c ? [...(c.canciones_versiones || [])].sort((a, b) => a.orden - b.orden) : [];
    const v = vs.find((x) => x.id === e.version_id) || vs[0];
    const titulo = c ? (v && v.nombre !== 'Estudio' ? c.titulo + ' (' + v.nombre + ')' : c.titulo) : (e.titulo || 'Canción');
    const archivoBsm = v && v.master && v.master.archivo;
    // Si en este ordenador ya se eligió un archivo para este tema, se respeta
    const file = (p.file && p.bsm && p.bsm.cancion_id === e.cancion_id && p.bsm.version_id === (v && v.id)) ? p.file : buscarArchivo(c ? c.titulo : titulo, archivoBsm);
    return { fadeIn: 0, fadeOut: 0, startAt: 0, endAt: 0, loop: false, ...p, id: e.id, type: 'song', file, title: titulo, note: e.nota || '', after,
      bsm: { tipo: 'cancion', cancion_id: e.cancion_id || null, version_id: v ? v.id : (e.version_id || null), cancion: c ? c.titulo : titulo, version: v ? v.nombre : null } };
  });
}
function localDe(bsmId) { return H.listShows().find((s) => s.bsm === bsmId); }
function sonando() { const st = H.getState(); return st && st.status && st.status !== 'stopped'; }

function aplicarShow(reg) {
  const loc = localDe(reg.id);
  if (loc && loc.id === H.activeShow() && sonando()) { diferidos.set(reg.id, reg); aviso(); return; }
  const previo = loc ? H.readShow(loc.id) : null;
  if (previo && C.pendientes[loc.id] && previo.bsm_updated_at && reg.updated_at <= previo.bsm_updated_at) return; // lo nuestro es más nuevo
  const sh = { ...(previo || {}), name: [reg.nombre, reg.fecha].filter(Boolean).join(' · '), items: aItems(reg.guion, previo && previo.items), rev: String(Date.now()),
    origen: 'bsm', bsm_show_id: reg.id, bsm_updated_at: reg.updated_at, bsm_nombre: reg.nombre, bsm_fecha: reg.fecha || null };
  delete sh.empty;
  const id = loc ? loc.id : H.newShowId();
  aplicandoRemoto = true;
  try { H.writeShow(id, sh); } finally { aplicandoRemoto = false; }
  C.firmas[id] = firma(sh); guardar();
  if (id === H.activeShow()) H.activateShow(id); else H.showsChanged();
}
function borrarShowRemoto(bsmId) {
  const loc = localDe(bsmId); if (!loc) return;
  const sh = H.readShow(loc.id); if (!sh) return;
  // No se borra nada en Maestro: queda como copia local
  delete sh.bsm_show_id; delete sh.bsm_updated_at; sh.origen = 'bsm-copia'; sh.name = (sh.name || 'Show') + ' (borrado en BSM)';
  aplicandoRemoto = true; try { H.writeShow(loc.id, sh); } finally { aplicandoRemoto = false; }
  H.showsChanged();
}
function alParar() {
  if (sonando() || !diferidos.size) return;
  const regs = [...diferidos.values()]; diferidos.clear();
  for (const r of regs) aplicarShow(r);
  aviso();
}

async function cargarCanciones() {
  canciones = await rest('GET', 'canciones?select=id,titulo,artista,user_id,managed_artist_id,updated_at,canciones_versiones(id,nombre,orden,master,tempo,tono,duracion_segundos)&order=titulo') || [];
}
async function sincronizarTodo() {
  if (!C.session) return;
  try {
    await subirPendientes();
    await cargarCanciones();
    const shows = await rest('GET', 'shows?select=*&order=fecha.desc.nullslast') || [];
    const vivos = new Set(shows.map((s) => s.id));
    for (const reg of shows) aplicarShow(reg);
    for (const it of H.listShows()) if (it.bsm && !vivos.has(it.bsm)) borrarShowRemoto(it.bsm);
    await subirArchivosResueltos();
    estado.conectado = true; estado.error = null; estado.ultimo = new Date().toISOString();
  } catch (e) {
    estado.conectado = false; if (!/fetch failed|ENOTFOUND|ECONN|network/i.test(String(e.message))) estado.error = String(e.message).slice(0, 160);
    H.log('cuenta: sincronizar', e);
  }
  aviso();
}

// ---------------------------------- Maestro → BSM ----------------------------------
function firma(sh) { return JSON.stringify((sh.items || []).map((i) => [i.id, i.type, i.file, i.title, i.note, i.after, i.seconds])) + '|' + (sh.bsm_nombre || sh.name); }
async function asegurarCancion(it) {
  if (it.bsm && it.bsm.cancion_id && canciones.some((c) => c.id === it.bsm.cancion_id)) return it.bsm;
  const titulo = String(it.title || '').trim() || (it.file ? require('path').basename(it.file).replace(/\.[^.]+$/, '').replace(/^\d+[\s._-]+/, '') : 'Canción');
  const t = normTit(titulo);
  let c = canciones.find((x) => normTit(x.titulo) === t);
  if (!c) {
    // Tema nuevo desde Maestro: se crea su ficha en BSM con el nombre del archivo
    const [nueva] = await rest('POST', 'canciones', { user_id: C.session.user.id, titulo, artista: '', editado_por: quien() });
    const [ver] = await rest('POST', 'canciones_versiones', { cancion_id: nueva.id, nombre: 'Estudio', orden: 0, master: it.file ? { instrumento: 'Máster', archivo: base(it.file) } : null, pistas: [], editado_por: quien() });
    c = { ...nueva, canciones_versiones: [ver] }; canciones.push(c);
  }
  const v = [...(c.canciones_versiones || [])].sort((a, b) => a.orden - b.orden)[0];
  return { tipo: 'cancion', cancion_id: c.id, version_id: v ? v.id : null, cancion: c.titulo, version: v ? v.nombre : null };
}
async function aGuion(items) {
  const out = [];
  for (const it of items || []) {
    const despues = it.after === 'continue' ? 'seguir' : 'esperar';
    if (it.type === 'block') out.push({ id: it.id, tipo: it.bsm && it.bsm.tipo === 'nota' ? 'nota' : 'bloque', titulo: it.title || '', nota: it.note || '' });
    else if (it.type === 'silence') out.push({ id: it.id, tipo: 'silencio', segundos: Number(it.seconds) || 5, nota: it.note || '', despues });
    else if (it.type === 'song') { const b = await asegurarCancion(it); it.bsm = b; out.push({ id: it.id, tipo: 'cancion', cancion_id: b.cancion_id, version_id: b.version_id, nota: it.note || '', despues }); }
  }
  return out;
}
// Lo llama el servidor cada vez que se guarda un show en este aparato
function alGuardarLocal(id, sh) {
  if (aplicandoRemoto || !C.session || !sh) return;
  if (!sh.bsm_show_id && !(sh.origen === 'local-subir')) return;   // shows que no son de BSM: no se tocan
  if (C.firmas[id] === firma(sh)) return;                         // nada que BSM necesite saber
  C.pendientes[id] = Date.now(); guardar();
  clearTimeout(subidaT.get(id));
  subidaT.set(id, setTimeout(() => subirShow(id).catch((e) => H.log('cuenta: subir', e)), 1500));
}
async function subirShow(id) {
  const sh = H.readShow(id); if (!sh || !C.session) return;
  try {
    const guion = await aGuion(sh.items);
    const datos = { guion, editado_por: quien() };
    if (sh.bsm_nombre !== undefined) {
      const visible = [sh.bsm_nombre, sh.bsm_fecha].filter(Boolean).join(' · ');
      if (sh.name && sh.name !== visible) { datos.nombre = sh.name.replace(/\s·\s\d{4}-\d{2}-\d{2}$/, '').trim(); sh.bsm_nombre = datos.nombre; }
    }
    let reg;
    if (sh.bsm_show_id) [reg] = await rest('PATCH', 'shows?id=eq.' + sh.bsm_show_id, datos);
    else [reg] = await rest('POST', 'shows', { ...datos, nombre: sh.name || 'Show', user_id: C.session.user.id, estado: 'borrador' });
    if (!reg) throw new Error('BSM no devolvió el show');
    sh.bsm_show_id = reg.id; sh.bsm_updated_at = reg.updated_at; sh.origen = 'bsm';
    aplicandoRemoto = true; try { H.writeShow(id, sh); } finally { aplicandoRemoto = false; }
    C.firmas[id] = firma(sh); delete C.pendientes[id]; guardar();
    estado.ultimo = new Date().toISOString(); estado.conectado = true; aviso();
  } catch (e) { estado.conectado = false; aviso(); throw e; }
}
async function subirPendientes() { for (const id of Object.keys(C.pendientes)) { try { await subirShow(id); } catch (e) { H.log('cuenta: pendiente ' + id, e); } } }
// Metadatos portables: si Maestro encontró el archivo de un tema y BSM no lo tenía, se apunta en BSM
async function subirArchivosResueltos() {
  const hechos = new Set();
  for (const it of H.listShows()) {
    if (!it.bsm) continue;
    const sh = H.readShow(it.id); if (!sh) continue;
    for (const i of sh.items || []) {
      if (i.type !== 'song' || !i.file || !i.bsm || !i.bsm.version_id || hechos.has(i.bsm.version_id)) continue;
      const c = canciones.find((x) => x.id === i.bsm.cancion_id); const v = c && (c.canciones_versiones || []).find((x) => x.id === i.bsm.version_id);
      if (v && !(v.master && v.master.archivo)) {
        hechos.add(v.id);
        try { await rest('PATCH', 'canciones_versiones?id=eq.' + v.id, { master: { instrumento: 'Máster', archivo: base(i.file) }, editado_por: quien() }); v.master = { instrumento: 'Máster', archivo: base(i.file) }; } catch (e) { H.log('cuenta: archivo', e); }
      }
    }
  }
}

// ---------------------------------- Tiempo real ----------------------------------
function enviarWs(topic, event, payload) { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ topic, event, payload, ref: String(++wsRef) })); }
function cerrarWs() { clearInterval(wsLatido); if (ws) { try { ws.onclose = null; ws.close(); } catch {} } ws = null; estado.tiempoReal = false; }
function abrirWs() {
  cerrarWs();
  if (!C.session || typeof WebSocket === 'undefined') return;
  ws = new WebSocket(SB_URL.replace(/^http/, 'ws') + '/realtime/v1/websocket?apikey=' + SB_KEY + '&vsn=1.0.0');
  ws.onopen = () => {
    wsReintento = 1000;
    enviarWs('realtime:maestro', 'phx_join', { config: { broadcast: { self: false }, presence: { key: '' }, private: false,
      postgres_changes: ['shows', 'canciones', 'canciones_versiones', 'maestro_dispositivos'].map((table) => ({ event: '*', schema: 'public', table })) },
      access_token: C.session.access_token });
    wsLatido = setInterval(() => enviarWs('phoenix', 'heartbeat', {}), 25e3);
  };
  ws.onmessage = (m) => {
    let d; try { d = JSON.parse(m.data); } catch { return; }
    if (d.event === 'phx_reply' && d.payload && d.payload.status === 'ok' && d.topic === 'realtime:maestro') { estado.tiempoReal = true; aviso(); }
    if (d.event === 'postgres_changes' && d.payload && d.payload.data) alCambio(d.payload.data).catch((e) => H.log('cuenta: cambio', e));
  };
  ws.onclose = () => {
    estado.tiempoReal = false; clearInterval(wsLatido); aviso();
    if (!C.session) return;
    setTimeout(() => { if (C.session) { sincronizarTodo().then(abrirWs); } }, wsReintento);   // al volver: ponerse al día
    wsReintento = Math.min(wsReintento * 2, 60e3);
  };
  ws.onerror = () => {};
}
async function alCambio(d) {
  const reg = d.record || {}, viejo = d.old_record || {};
  if (reg.editado_por === quien()) return;   // eco de lo que acabamos de subir
  if (d.table === 'maestro_dispositivos') { if (reg.id === C.deviceId && reg.revocado) { desvincular(); estado.error = 'Este Maestro se desvinculó desde BSM.'; aviso(); } return; }
  if (d.table === 'shows') {
    if (d.type === 'DELETE') return borrarShowRemoto(viejo.id);
    aplicarShow(reg); estado.ultimo = new Date().toISOString(); aviso(); return;
  }
  // Cambió una canción: recargar y volver a resolver los shows que la usan
  await cargarCanciones();
  const cid = d.table === 'canciones' ? (reg.id || viejo.id) : (reg.cancion_id || viejo.cancion_id);
  for (const it of H.listShows()) {
    if (!it.bsm) continue;
    const sh = H.readShow(it.id);
    if (sh && (sh.items || []).some((i) => i.bsm && i.bsm.cancion_id === cid)) {
      try { const [r] = await rest('GET', 'shows?select=*&id=eq.' + it.bsm); if (r) aplicarShow(r); } catch {}
    }
  }
}

// ---------------------------------- arranque ----------------------------------
function init(helpers) {
  H = helpers;
  FILE = path.join(H.dataDir, 'maestro-cuenta.json');
  try { C = { ...C, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
  if (!C.deviceId) { C.deviceId = crypto.randomBytes(8).toString('hex'); guardar(); }
  if (C.session) { programarRenovacion(); setTimeout(() => sincronizarTodo().then(abrirWs), 1500); }
  // Reintentar lo pendiente y ponerse al día cada minuto (por si se perdió algún aviso)
  setInterval(() => { if (C.session && (!estado.tiempoReal || Object.keys(C.pendientes).length)) sincronizarTodo().then(() => { if (!estado.tiempoReal) abrirWs(); }); }, 60e3).unref();
}

module.exports = { init, publico, conPassword, conCodigo, cancelarCodigo, desvincular, sincronizarTodo, alGuardarLocal, alParar, subirShow,
  _test: { aItems, aGuion, firma, normTit, setCanciones: (x) => { canciones = x; }, C: () => C } };
