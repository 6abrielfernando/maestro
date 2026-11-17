// Maestro — actualizaciones automáticas
// Busca en internet si hay una versión nueva, la descarga, comprueba cada archivo
// (huella SHA-256 y sintaxis), guarda una copia de la versión actual y la sustituye.
// No toca: canciones, guion.json, registro de errores ni el Node.js incluido.
// Si la versión nueva no arranca 3 veces seguidas, vuelve sola a la anterior.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const MANIFEST_URL = process.env.MAESTRO_UPDATE_URL ||
  'https://raw.githubusercontent.com/6abrielfernando/maestro/main/actualizacion/version.json';
const WORK = path.join(ROOT, '.actualizacion');
const BACKUP = path.join(WORK, 'anterior');
const STAGE = path.join(WORK, 'nueva');
const PENDING = path.join(WORK, 'pendiente.json');
// Solo se pueden sustituir estos archivos (nunca los scripts de inicio ni el runtime)
const ALLOWED = /^(server\.js|mdns\.js|actualizar\.js|version\.txt|LEEME\.txt|public\/[A-Za-z0-9._-]+)$/;

function currentVersion() {
  try { return fs.readFileSync(path.join(ROOT, 'version.txt'), 'utf8').trim(); } catch { return '0.0.0'; }
}

function newer(a, b) { // ¿a es más nueva que b?
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

async function getUrl(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  } finally { clearTimeout(t); }
}

let last = null; // último resultado de la comprobación
async function check() {
  const current = currentVersion();
  try {
    const m = JSON.parse((await getUrl(MANIFEST_URL, 8000)).toString('utf8'));
    last = { ok: true, current, latest: m.version, available: newer(m.version, current), notes: m.notas || '', checkedAt: Date.now(), manifest: m };
  } catch (e) {
    last = { ok: false, current, available: false, error: 'Sin conexión a internet o servidor de actualizaciones no disponible', checkedAt: Date.now() };
  }
  return publicInfo();
}
function publicInfo() { if (!last) return { current: currentVersion(), available: false }; const { manifest, ...rest } = last; return rest; }

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
function copyInto(src, dst) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }

let installing = false;
async function install(progress = () => {}) {
  if (installing) throw new Error('Ya se está actualizando');
  installing = true;
  try {
    await check();
    if (!last.ok) throw new Error(last.error);
    if (!last.available) throw new Error('Ya tienes la última versión');
    const m = last.manifest;
    const files = Object.entries(m.files || {});
    if (!files.length || files.some(([f]) => !ALLOWED.test(f))) throw new Error('Actualización no válida');
    const base = m.base || MANIFEST_URL.replace(/[^/]+$/, 'app/');

    // 1) Descargar y comprobar todo antes de tocar nada
    rmrf(STAGE); fs.mkdirSync(STAGE, { recursive: true });
    let n = 0;
    for (const [f, hash] of files) {
      progress(`Descargando ${++n} de ${files.length}…`);
      const buf = await getUrl(base + f.split('/').map(encodeURIComponent).join('/'), 30000);
      if (sha(buf) !== hash) throw new Error('Un archivo llegó dañado (' + f + '). Vuelve a intentarlo.');
      fs.mkdirSync(path.dirname(path.join(STAGE, f)), { recursive: true });
      fs.writeFileSync(path.join(STAGE, f), buf);
    }
    progress('Comprobando…');
    for (const [f] of files) {
      if (f.endsWith('.js')) execFileSync(process.execPath, ['--check', path.join(STAGE, f)], { stdio: 'ignore' });
    }

    // 2) Copia de seguridad de la versión actual
    progress('Guardando copia de la versión actual…');
    rmrf(BACKUP);
    for (const [f] of files) { const cur = path.join(ROOT, f); if (fs.existsSync(cur)) copyInto(cur, path.join(BACKUP, f)); }
    fs.writeFileSync(path.join(BACKUP, 'lista.json'), JSON.stringify(files.map(([f]) => f)));

    // 3) Sustituir
    progress('Instalando…');
    for (const [f] of files) copyInto(path.join(STAGE, f), path.join(ROOT, f));
    fs.writeFileSync(PENDING, JSON.stringify({ from: last.current, to: m.version, tries: 0 }));
    rmrf(STAGE);
    return { ok: true, from: last.current, to: m.version };
  } finally { installing = false; }
}

// Al arrancar: si la versión recién instalada falla varias veces, volver a la anterior
function logError(where, e) {
  try { fs.appendFileSync(path.join(ROOT, 'maestro-errores.log'), `[${new Date().toISOString()}] ${where}: ${(e && (e.stack || e.message)) || e}\n`); } catch {}
}
function startupGuard() {
  if (!fs.existsSync(PENDING)) return;
  let p; try { p = JSON.parse(fs.readFileSync(PENDING, 'utf8')); } catch { p = { tries: 0 }; }
  p.tries = (p.tries || 0) + 1;
  if (p.tries > 3) {
    try {
      const list = JSON.parse(fs.readFileSync(path.join(BACKUP, 'lista.json'), 'utf8'));
      for (const f of list) { const b = path.join(BACKUP, f); if (fs.existsSync(b)) copyInto(b, path.join(ROOT, f)); }
      logError('actualización', `La versión ${p.to} no arrancaba; se ha vuelto a la ${p.from}`);
      console.log(`\n  La versión ${p.to} no arrancaba. Vuelvo a la ${p.from}…\n`);
    } catch (e) { logError('volver a la versión anterior', e); }
    rmrf(PENDING);
    process.exit(1); // el script de inicio vuelve a abrir Maestro con la versión anterior
  }
  fs.writeFileSync(PENDING, JSON.stringify(p));
  // Si aguanta 30 s en marcha, la actualización se da por buena
  setTimeout(() => rmrf(PENDING), 30000).unref();
}

module.exports = { check, install, publicInfo, currentVersion, startupGuard, MANIFEST_URL };
