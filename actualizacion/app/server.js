// Maestro — servidor
// Sin dependencias: solo necesita Node.js (Mac, Windows o Linux).
// Sirve la página de control (tableta) y la del reproductor (ordenador),
// y reenvía las órdenes de una a otra por la red local.

// Lo primero: si una actualización recién instalada no arranca, volver a la versión anterior
require('./actualizar').startupGuard();

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execFile } = require('child_process');

const mdns = require('./mdns');
const upd = require('./actualizar');
const VERSION = upd.currentVersion();

const PORT = Number(process.env.PORT) || 8080;
const HOSTNAME = (process.env.NOMBRE || 'maestro').replace(/\.local$/i, '');
const SONGS_DIR = process.env.SONGS_DIR || path.join(__dirname, 'canciones');
const PUBLIC_DIR = path.join(__dirname, 'public');
const AUDIO_RE = /\.(mp3|wav|m4a|aac|ogg|flac|aiff?)$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.aif': 'audio/aiff', '.aiff': 'audio/aiff',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

// Estado que informa el reproductor y que ven las tabletas
let state = { file: null, title: null, status: 'stopped', position: 0, duration: 0, volume: 1, nextIndex: -1 };
const clients = { control: new Set(), player: new Set() };

// ====================== Biblioteca: varias carpetas de música ======================
// La carpeta «canciones» siempre está; además se pueden vincular otras carpetas del ordenador.
// Cada canción tiene una clave: en «canciones» es su ruta (p. ej. «Tema.mp3»);
// en una carpeta vinculada es «@<id>/<ruta dentro de la carpeta>».
const DATA_DIR = path.dirname(path.resolve(process.env.SHOW_FILE || path.join(__dirname, 'guion.json')));
const CONFIG_FILE = path.join(DATA_DIR, 'maestro-config.json');
let config = { folders: [], activeShow: null };
try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch {}
function saveConfig() { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 1)); } catch (e) { logError('guardar configuración', e); } }

const MAX_FILES = 60000, MAX_DEPTH = 10;
function folderId(dir) { let h = 0; for (const c of dir) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h.toString(36); }
function sources() {
  return [{ id: '', name: 'canciones', path: SONGS_DIR, fixed: true },
    ...config.folders.map((f) => ({ id: f.id, name: f.name || path.basename(f.path), path: f.path, fixed: false }))];
}
const titleOf = (f) => path.basename(f).replace(/\.[^.]+$/, '').replace(/^\d+[\s._-]+/, '');
function walk(root, rel, depth, out) {
  let ents; try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (out.length >= MAX_FILES || e.name.startsWith('.') || e.name.startsWith('$')) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { if (depth < MAX_DEPTH) walk(root, r, depth + 1, out); }
    else if (AUDIO_RE.test(e.name)) out.push(r);
  }
}
let library = null, folderStatus = {};
function buildLibrary() {
  if (!fs.existsSync(SONGS_DIR)) try { fs.mkdirSync(SONGS_DIR, { recursive: true }); } catch {}
  const list = []; folderStatus = {};
  for (const src of sources()) {
    const files = []; const ok = fs.existsSync(src.path);
    if (ok) walk(src.path, '', 0, files);
    folderStatus[src.id] = { ok, count: files.length };
    files.sort((a, b) => a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' }));
    for (const r of files) {
      const dir = r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : '';
      list.push({ file: src.id ? '@' + src.id + '/' + r : r, title: titleOf(r), folder: src.name, dir });
    }
  }
  library = list;
  return list;
}
function listSongs() { return library || buildLibrary(); }
// Ruta real de una canción a partir de su clave (sin salirse nunca de su carpeta)
function songPath(key) {
  let src = sources()[0], rel = key;
  const m = /^@([^/]+)\/(.+)$/.exec(key);
  if (m) { src = sources().find((s) => s.id === m[1]); rel = m[2]; if (!src) return null; }
  const base = path.resolve(src.path), fp = path.resolve(base, rel);
  if (fp !== base && !fp.startsWith(base + path.sep)) return null;
  return fp;
}

function sse(set, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(msg);
}

let songsVersion = 1;
function broadcastState() {
  sse(clients.control, 'state', { ...state, players: clients.player.size, songsVersion, appVersion: VERSION, showsVersion, activeShow: config.activeShow });
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

// Audio con soporte de rangos (necesario para Safari y para saltar dentro de la canción)
function serveAudio(req, res, name) {
  let key; try { key = decodeURIComponent(name); } catch { res.writeHead(400); return res.end(); }
  let fp = songPath(key);
  if (!fp || !AUDIO_RE.test(fp) || !fs.existsSync(fp)) {
    // Show hecho en otro ordenador o carpeta movida: buscar una canción con el mismo nombre de archivo
    const base = key.split('/').pop().toLowerCase();
    const alt = listSongs().find((x) => x.file.split('/').pop().toLowerCase() === base);
    fp = alt ? songPath(alt.file) : null;
    if (!fp || !fs.existsSync(fp)) { res.writeHead(404); return res.end(); }
  }
  let size;
  try { size = fs.statSync(fp).size; } catch { res.writeHead(404); return res.end(); }
  const type = MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    if (start < 0) start = 0;
    if (end >= size) end = size - 1;
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' });
    pipeSafe(fs.createReadStream(fp, { start, end }), res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    pipeSafe(fs.createReadStream(fp), res);
  }
}

const COMMANDS = new Set(['go', 'fire', 'goto', 'skip', 'back', 'restart', 'play', 'toggle', 'stop', 'fade', 'panic',
  'volume', 'volstep', 'gain', 'seek', 'reloadSongs', 'next', 'prev']);
const SHOW_FILE = process.env.SHOW_FILE || path.join(__dirname, 'guion.json');
let showJson = fs.existsSync(SHOW_FILE) ? fs.readFileSync(SHOW_FILE, 'utf8') : 'null';

// Un archivo bloqueado, borrado o a medio guardar no debe tumbar el programa
function pipeSafe(stream, res) {
  stream.on('error', () => { try { res.destroy(); } catch {} });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

const server = http.createServer((req, res) => {
  handler(req, res).catch((e) => {
    logError('petición ' + req.url, e);
    try { if (!res.headersSent) res.writeHead(500); res.end(); } catch {}
  });
});

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/' || p === '/control') return serveFile(res, path.join(PUBLIC_DIR, 'control.html'));
  if (p === '/player') return serveFile(res, path.join(PUBLIC_DIR, 'player.html'));

  if (p === '/events') {
    const role = url.searchParams.get('role') === 'player' ? 'player' : 'control';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 1000\n\n');
    clients[role].add(res);
    if (role === 'control') res.write(`event: state\ndata: ${JSON.stringify({ ...state, players: clients.player.size, songsVersion, appVersion: VERSION, showsVersion, activeShow: config.activeShow })}\n\n`);
    if (role === 'player') res.write(`event: update\ndata: ${JSON.stringify(upd.publicInfo())}\n\n`);
    broadcastState();
    req.on('close', () => { clients[role].delete(res); broadcastState(); });
    return;
  }

  if (p === '/api/songs' && req.method === 'GET') return json(res, 200, listSongs());

  if (p === '/api/info' && req.method === 'GET') {
    return json(res, 200, { sse: true, version: VERSION, port: PORT, name: `${HOSTNAME}.local`, ips: lanIPs(),
      urls: [`http://${HOSTNAME}.local:${PORT}`, ...lanIPs().map((ip) => `http://${ip}:${PORT}`)] });
  }

  if (p === '/qrcode.js' || p === '/engine.js') return serveFile(res, path.join(PUBLIC_DIR, p.slice(1)));
  // Fuentes incluidas (funcionan sin internet)
  if (/^\/[a-z0-9-]+\.woff2$/.test(p)) return serveFile(res, path.join(PUBLIC_DIR, p.slice(1)));
  // Iconos (pestaña del navegador y pantalla de inicio del móvil)
  if (p === '/avi.png' || p === '/favicon.ico' || p === '/favicon.png' || p === '/icono-180.png' || p === '/icono-512.png') return serveFile(res, path.join(PUBLIC_DIR, p.slice(1)));
  if (p === '/apple-touch-icon.png' || p === '/apple-touch-icon-precomposed.png') return serveFile(res, path.join(PUBLIC_DIR, 'icono-180.png'));

  if (p === '/api/cmd' && req.method === 'POST') {
    const body = await readBody(req);
    if (!COMMANDS.has(body.cmd)) return json(res, 400, { ok: false, error: 'Orden desconocida' });
    if (body.cmd === 'play' && !listSongs().some((s) => s.file === body.file)) return json(res, 404, { ok: false, error: 'Canción no encontrada' });
    if (body.cmd === 'next') body.cmd = 'go';      // compatibilidad con la versión anterior
    if (body.cmd === 'prev') body.cmd = 'back';
    if (clients.player.size === 0) return json(res, 409, { ok: false, error: 'No hay reproductor conectado' });
    sse(clients.player, 'cmd', body);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/show' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    return res.end(showJson);
  }

  if (p === '/api/show' && req.method === 'PUT') {
    const body = await readBody(req);
    if (!body || !Array.isArray(body.items)) return json(res, 400, { ok: false, error: 'Guion no válido' });
    showJson = JSON.stringify(body);
    try { writeShow(config.activeShow, body); } catch (e) { logError('guardar show', e); }
    fs.writeFile(SHOW_FILE, showJson, () => {});   // copia del show activo (compatibilidad)
    if (body.name !== undefined) showsVersion++;
    // Si lo manda el control, se lo pasamos al reproductor; si lo guarda el reproductor, no hace falta
    if (url.searchParams.get('origin') !== 'player') sse(clients.player, 'cmd', { cmd: 'setShow', show: body });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/state' && req.method === 'POST') {
    const body = await readBody(req);
    state = { ...state, ...body };
    broadcastState();
    return json(res, 200, { ok: true });
  }

  if (p.startsWith('/audio/')) return serveAudio(req, res, p.slice(7));

  // ----- Actualizaciones: solo desde este mismo ordenador -----
  if (p === '/api/update' && req.method === 'GET') {
    if (url.searchParams.get('check')) await upd.check();
    return json(res, 200, upd.publicInfo());
  }
  if (p === '/api/update/install' && req.method === 'POST') {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: 'Solo desde el ordenador del reproductor' });
    if (clients.player.size && state.status && state.status !== 'stopped') return json(res, 409, { ok: false, error: 'Para la reproducción antes de actualizar' });
    try {
      const r = await upd.install((msg) => sse(clients.player, 'update', { ...upd.publicInfo(), progress: msg }));
      json(res, 200, r);
      sse(clients.player, 'update', { ...upd.publicInfo(), progress: 'Reiniciando Maestro…', restarting: true });
      console.log(`\n  Actualizado a la versión ${r.to}. Reiniciando…\n`);
      setTimeout(() => process.exit(75), 800); // el script de inicio lo vuelve a abrir
    } catch (e) { return json(res, 200, { ok: false, error: e.message || String(e) }); }
    return;
  }

  // ----- Shows guardados -----
  if (p === '/api/shows' && req.method === 'GET') return json(res, 200, { active: config.activeShow, shows: listShows() });
  if (p === '/api/shows' && req.method === 'POST') {
    const b = await readBody(req);
    const name = String(b.name || '').trim().slice(0, 80);
    if (b.action === 'new' || b.action === 'duplicate') {
      const src = b.action === 'duplicate' ? readShow(b.id || config.activeShow) : null;
      const id = newShowId();
      const sh = src ? { ...src, name: name || (src.name || 'Show') + ' (copia)', rev: String(Date.now()) } : { name: name || 'Show nuevo', items: [], empty: true, rev: String(Date.now()) };
      writeShow(id, sh);
      if (b.activate !== false) activateShow(id); else { showsVersion++; broadcastState(); }
      return json(res, 200, { ok: true, id });
    }
    if (b.action === 'activate') { const ok = activateShow(b.id); return json(res, ok ? 200 : 404, { ok }); }
    if (b.action === 'rename') {
      const sh = readShow(b.id); if (!sh || !name) return json(res, 400, { ok: false, error: 'Nombre no válido' });
      sh.name = name; sh.rev = String(Date.now()); writeShow(b.id, sh);
      if (b.id === config.activeShow) activateShow(b.id); else { showsVersion++; broadcastState(); }
      return json(res, 200, { ok: true });
    }
    if (b.action === 'delete') {
      if (listShows().length <= 1) return json(res, 400, { ok: false, error: 'Tiene que quedar al menos un show' });
      try { fs.unlinkSync(showPath(b.id)); } catch { return json(res, 404, { ok: false, error: 'No existe' }); }
      if (b.id === config.activeShow) activateShow(listShows()[0].id); else { showsVersion++; broadcastState(); }
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { ok: false, error: 'Acción desconocida' });
  }

  // ----- Carpetas de música: verlas desde cualquiera, cambiarlas solo desde este ordenador -----
  if ((p === '/api/folder' || p === '/api/folders') && req.method === 'GET') {
    const local = isLocal(req);
    return json(res, 200, { local, folders: folderList().map((f) => local ? f : { ...f, path: null }), dir: local ? SONGS_DIR : null,
      songs: listSongs().length <= 400 ? listSongs() : null, total: listSongs().length });
  }
  if (p.startsWith('/api/folders/') && req.method === 'POST') {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: 'Solo desde el ordenador del reproductor' });
    const b = await readBody(req), action = p.slice(13);
    if (action === 'pick') {
      const r = await pickFolder();
      if (r.path) return json(res, 200, addFolder(r.path));
      return json(res, 200, { ok: false, cancelled: !!r.cancelled, unavailable: r.error === 'unavailable' });
    }
    if (action === 'add') return json(res, 200, addFolder(b.path));
    if (action === 'remove') {
      const n = config.folders.length; config.folders = config.folders.filter((f) => f.id !== b.id);
      if (config.folders.length === n) return json(res, 404, { ok: false, error: 'No existe' });
      saveConfig(); buildLibrary(); watchSongs(); libraryChanged();
      return json(res, 200, { ok: true });
    }
    if (action === 'open') { const src = sources().find((x) => x.id === (b.id || '')); if (src) openPath(src.path); return json(res, 200, { ok: !!src }); }
    return json(res, 400, { ok: false });
  }
  if (p === '/api/open-folder' && req.method === 'POST') {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: 'Solo desde el ordenador del reproductor' });
    openPath(SONGS_DIR);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/upload' && req.method === 'POST') {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: 'Solo desde el ordenador del reproductor' });
    const name = path.basename(url.searchParams.get('name') || '');
    if (!AUDIO_RE.test(name) || name.startsWith('.')) { req.resume(); return json(res, 400, { ok: false, error: 'Formato no admitido' }); }
    let target = path.join(SONGS_DIR, name), k = 2;
    while (fs.existsSync(target)) target = path.join(SONGS_DIR, name.replace(/(\.[^.]+)$/, ` (${k++})$1`));
    const tmp = target + '.subiendo';
    const out = fs.createWriteStream(tmp);
    req.pipe(out);
    out.on('finish', () => { fs.rename(tmp, target, (e) => json(res, e ? 500 : 200, e ? { ok: false, error: 'No se pudo guardar' } : { ok: true, file: path.basename(target) })); });
    out.on('error', () => { try { fs.unlinkSync(tmp); } catch {} json(res, 500, { ok: false, error: 'No se pudo guardar' }); });
    return;
  }

  res.writeHead(404); res.end('No encontrado');
}

// Mantener viva la conexión de eventos (algunas redes cortan conexiones inactivas)
setInterval(() => { for (const set of Object.values(clients)) for (const r of set) r.write(': ping\n\n'); }, 15000);

function lanIPs() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

const LOG_FILE = process.env.MAESTRO_LOG || path.join(__dirname, 'maestro-errores.log');
function logError(where, e) {
  const line = `[${new Date().toISOString()}] ${where}: ${(e && (e.stack || e.message)) || e}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}
process.on('uncaughtException', (e) => logError('error no controlado', e));
process.on('unhandledRejection', (e) => logError('promesa rechazada', e));
server.on('clientError', (e, socket) => { try { socket.destroy(); } catch {} });

function isLocal(req) {
  const a = (req.socket.remoteAddress || '').replace('::ffff:', '');
  return a === '127.0.0.1' || a === '::1';
}

function openPath(dir) {
  const app = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(app, [dir], () => {});
}

// Si cambian los archivos de alguna carpeta, avisar al reproductor y a los controles
let watchT = null, watchers = [], lastSig = '';
function libraryChanged() {
  clearTimeout(watchT);
  watchT = setTimeout(() => {
    const sig = JSON.stringify(buildLibrary().map((x) => x.file));
    if (sig === lastSig) return;
    lastSig = sig;
    songsVersion++; sse(clients.player, 'cmd', { cmd: 'reloadSongs' }); sse(clients.player, 'songs', { songsVersion }); broadcastState();
  }, 700);
}
function watchSongs() {
  for (const w of watchers) { try { w.close(); } catch {} }
  watchers = [];
  for (const src of sources()) {
    const start = () => {
      try {
        const w = fs.watch(src.path, { recursive: true }, libraryChanged);
        w.on('error', (e) => { try { w.close(); } catch {} setTimeout(() => { if (sources().some((x) => x.path === src.path)) start(); }, 5000); });
        watchers.push(w);
      } catch { try { const w = fs.watch(src.path, libraryChanged); w.on('error', () => {}); watchers.push(w); } catch {} }
    };
    start();
  }
}
// Respaldo: volver a leer las carpetas cada cierto tiempo por si el sistema no avisa de algún cambio
function pollLibrary() { libraryChanged(); setTimeout(pollLibrary, (library && library.length > 5000) ? 60000 : 5000); }

// Ventana del sistema para elegir una carpeta (Finder en Mac, Explorador en Windows)
function pickFolder() {
  return new Promise((resolve) => {
    let app, args;
    if (process.platform === 'darwin') {
      app = 'osascript'; args = ['-e', 'POSIX path of (choose folder with prompt "Elige una carpeta con música para Maestro")'];
    } else if (process.platform === 'win32') {
      app = 'powershell.exe';
      args = ['-NoProfile', '-STA', '-Command',
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; " +
        "$f=New-Object System.Windows.Forms.Form -Property @{TopMost=$true;ShowInTaskbar=$false;WindowState='Minimized'}; " +
        "$d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Elige una carpeta con música para Maestro'; $d.ShowNewFolderButton=$false; " +
        "if($d.ShowDialog($f) -eq 'OK'){[Console]::Out.Write($d.SelectedPath)}"];
    } else { app = 'zenity'; args = ['--file-selection', '--directory', '--title=Elige una carpeta con música']; }
    execFile(app, args, { windowsHide: false, timeout: 600000 }, (err, out) => {
      const dir = String(out || '').trim().replace(/[\\/]$/, '');
      if (dir) return resolve({ path: dir });
      if (err && err.code === 'ENOENT') return resolve({ error: 'unavailable' });
      resolve({ cancelled: true });
    });
  });
}
function addFolder(dir) {
  dir = path.resolve(String(dir || '').trim());
  let st; try { st = fs.statSync(dir); } catch { return { ok: false, error: 'Esa carpeta no existe' }; }
  if (!st.isDirectory()) return { ok: false, error: 'No es una carpeta' };
  if (sources().some((x) => path.resolve(x.path) === dir)) return { ok: false, error: 'Esa carpeta ya está vinculada' };
  let id = folderId(dir); while (config.folders.some((f) => f.id === id)) id += 'x';
  config.folders.push({ id, path: dir, name: path.basename(dir) || dir });
  saveConfig(); buildLibrary(); watchSongs(); libraryChanged();
  return { ok: true };
}
function folderList() {
  if (!library) buildLibrary();
  return sources().map((x) => ({ id: x.id, name: x.name, path: x.path, fixed: x.fixed, ok: (folderStatus[x.id] || {}).ok !== false, count: (folderStatus[x.id] || {}).count || 0 }));
}

// ====================== Shows: varios guiones guardados en este aparato ======================
const SHOWS_DIR = path.join(DATA_DIR, 'guiones');
let showsVersion = 1;
const newShowId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const showPath = (id) => path.join(SHOWS_DIR, String(id).replace(/[^a-z0-9]/gi, '') + '.json');
function readShow(id) { try { return JSON.parse(fs.readFileSync(showPath(id), 'utf8')); } catch { return null; } }
function writeShow(id, obj) { fs.mkdirSync(SHOWS_DIR, { recursive: true }); fs.writeFileSync(showPath(id), JSON.stringify(obj)); }
function listShows() {
  let files = []; try { files = fs.readdirSync(SHOWS_DIR).filter((f) => f.endsWith('.json')); } catch {}
  return files.map((f) => {
    const id = f.slice(0, -5), sh = readShow(id) || {};
    let mt = 0; try { mt = fs.statSync(showPath(id)).mtimeMs; } catch {}
    return { id, name: sh.name || 'Sin nombre', items: Array.isArray(sh.items) ? sh.items.length : 0, songs: Array.isArray(sh.items) ? sh.items.filter((i) => i.type === 'song').length : 0, updated: mt };
  }).sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' }));
}
// Arranque: si aún no hay shows, el guion de siempre (guion.json) pasa a ser el primero
function initShows() {
  if (!listShows().length) {
    const id = newShowId();
    let first = null; try { first = JSON.parse(fs.readFileSync(SHOW_FILE, 'utf8')); } catch {}
    // Primera vez: un show con las canciones de «canciones», cada una esperando la orden
    const auto = buildLibrary().filter((x) => !x.file.startsWith('@')).slice(0, 300).map((x, k) => ({ id: 'a' + k + Date.now().toString(36), type: 'song', file: x.file, title: '', note: '', after: 'wait', fadeIn: 0, fadeOut: 0, startAt: 0, endAt: 0, loop: false, seconds: 5 }));
    writeShow(id, first && Array.isArray(first.items) ? first : { name: 'Mi show', items: auto, rev: String(Date.now()) });
    config.activeShow = id; saveConfig();
  }
  if (!config.activeShow || !readShow(config.activeShow)) { config.activeShow = listShows()[0].id; saveConfig(); }
  showJson = JSON.stringify(readShow(config.activeShow));
}
function activateShow(id) {
  const sh = readShow(id); if (!sh) return false;
  config.activeShow = id; saveConfig();
  showJson = JSON.stringify(sh);
  try { fs.writeFileSync(SHOW_FILE, showJson); } catch {}
  sse(clients.player, 'cmd', { cmd: 'setShow', show: sh });
  showsVersion++; broadcastState();
  return true;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? `open "${url}"` : process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

initShows();

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`\n  Maestro ya está abierto en este ordenador (puerto ${PORT} ocupado).`);
    console.log('  Abro el reproductor que ya está en marcha. Puedes cerrar esta ventana.\n');
    if (!process.env.NO_OPEN) openBrowser(`http://localhost:${PORT}/player`);
    setTimeout(() => process.exit(0), 500);
  } else { logError('servidor', e); process.exit(1); }
});
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

server.listen(PORT, '0.0.0.0', () => {
  const songs = buildLibrary(); lastSig = JSON.stringify(songs.map((x) => x.file));
  watchSongs(); setTimeout(pollLibrary, 5000);
  console.log(`\n  MAESTRO ${VERSION} en marcha\n`);
  console.log(`  Canciones: ${songs.length} en ${SONGS_DIR}`);
  console.log(`  Reproductor (este ordenador): http://localhost:${PORT}/player`);
  const ips = lanIPs();
  if (ips.length) {
    const name = mdns.start(HOSTNAME);
    console.log(`  Control (abrir en la tableta):  http://${name}:${PORT}`);
    ips.forEach((ip) => console.log(`  …o si ese nombre no funciona:  http://${ip}:${PORT}`));
    console.log('  También puedes escanear el código QR que aparece en el reproductor.');
  } else console.log('  ¡Ojo! No se detecta red. Conecta el ordenador a la wifi o al router.');
  console.log('\n  Para cerrar: cierra esta ventana o pulsa Ctrl+C\n');
  if (!process.env.NO_OPEN) openBrowser(`http://localhost:${PORT}/player`);
  // Buscar actualizaciones al arrancar y cada 6 horas (si no hay internet, no pasa nada)
  const look = () => upd.check().then((i) => { sse(clients.player, 'update', i); if (i.available) console.log(`  Hay una versión nueva de Maestro: ${i.latest}. Actualiza desde el reproductor.`); }).catch(() => {});
  if (!process.env.NO_UPDATE_CHECK) { setTimeout(look, 4000); setInterval(look, 6 * 3600e3).unref(); }
});
