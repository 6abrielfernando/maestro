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
const { exec } = require('child_process');

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
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

// Estado que informa el reproductor y que ven las tabletas
let state = { file: null, title: null, status: 'stopped', position: 0, duration: 0, volume: 1, nextIndex: -1 };
const clients = { control: new Set(), player: new Set() };

function listSongs() {
  if (!fs.existsSync(SONGS_DIR)) fs.mkdirSync(SONGS_DIR, { recursive: true });
  return fs.readdirSync(SONGS_DIR)
    .filter((f) => AUDIO_RE.test(f) && !f.startsWith('.'))
    .sort((a, b) => a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' }))
    .map((file) => ({ file, title: file.replace(/\.[^.]+$/, '').replace(/^\d+[\s._-]+/, '') }));
}

function sse(set, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(msg);
}

let songsVersion = 1;
function broadcastState() {
  sse(clients.control, 'state', { ...state, players: clients.player.size, songsVersion, appVersion: VERSION });
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
  const file = path.basename(decodeURIComponent(name));
  const fp = path.join(SONGS_DIR, file);
  if (!AUDIO_RE.test(file) || !fs.existsSync(fp)) { res.writeHead(404); return res.end(); }
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
    if (role === 'control') res.write(`event: state\ndata: ${JSON.stringify({ ...state, players: clients.player.size, songsVersion, appVersion: VERSION })}\n\n`);
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
    fs.writeFile(SHOW_FILE, showJson, () => {});
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

  // ----- Gestión de la carpeta de canciones: solo desde este mismo ordenador -----
  if (p === '/api/folder' && req.method === 'GET') {
    const local = isLocal(req);
    const songs = listSongs().map((s) => { let size = 0; try { size = fs.statSync(path.join(SONGS_DIR, s.file)).size; } catch {} return { ...s, size }; });
    return json(res, 200, { dir: local ? SONGS_DIR : null, local, songs });
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

const LOG_FILE = path.join(__dirname, 'maestro-errores.log');
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
  const cmd = process.platform === 'darwin' ? `open "${dir}"` : process.platform === 'win32' ? `explorer "${dir}"` : `xdg-open "${dir}"`;
  exec(cmd, () => {});
}

// Si cambian los archivos de la carpeta, avisar al reproductor y a los controles
let watchT = null;
function watchSongs() {
  let watcher = null;
  const changed = () => {
    clearTimeout(watchT);
    watchT = setTimeout(() => { songsVersion++; sse(clients.player, 'cmd', { cmd: 'reloadSongs' }); sse(clients.player, 'songs', { songsVersion }); broadcastState(); }, 700);
  };
  const start = () => {
    try {
      watcher = fs.watch(SONGS_DIR, changed);
      watcher.on('error', (e) => { logError('vigilancia de la carpeta', e); try { watcher.close(); } catch {} setTimeout(start, 2000); });
    } catch (e) { setTimeout(start, 5000); }
  };
  start();
  // Respaldo: comprobar cada 5 s por si el sistema no avisa de algún cambio
  let lastList = JSON.stringify(listSongs());
  setInterval(() => { try { const now = JSON.stringify(listSongs()); if (now !== lastList) { lastList = now; changed(); } } catch {} }, 5000);
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? `open "${url}"` : process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

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
  const songs = listSongs();
  watchSongs();
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
