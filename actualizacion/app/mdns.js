// Mini anunciador mDNS (Bonjour) sin dependencias.
// Hace que "maestro.local" apunte a la IP de este ordenador dentro de la red local,
// para no tener que escribir números en la tableta. Funciona sin internet.

const dgram = require('dgram');
const os = require('os');

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

function lanInterfaces() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal);
}

function ipToInt(ip) { return ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0; }

// Elige la IP de este ordenador que está en la misma red que quien pregunta
function pickIP(remote) {
  const ifs = lanInterfaces();
  if (remote && /^\d+\.\d+\.\d+\.\d+$/.test(remote)) {
    const r = ipToInt(remote);
    const hit = ifs.find((i) => { const m = ipToInt(i.netmask); return (ipToInt(i.address) & m) === (r & m); });
    if (hit) return hit.address;
  }
  return ifs[0] && ifs[0].address;
}

function readName(buf, off) {
  const labels = []; let jumped = false; let end = off; let guard = 0;
  while (guard++ < 64) {
    const len = buf[off];
    if (len === undefined) throw new Error('nombre truncado');
    if (len === 0) { off += 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) end = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1]; jumped = true; continue;
    }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len)); off += 1 + len;
  }
  return { name: labels.join('.').toLowerCase(), next: jumped ? end : off };
}

function encodeName(name) {
  const parts = name.split('.').map((l) => { const b = Buffer.from(l); return Buffer.concat([Buffer.from([b.length]), b]); });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

function aRecord(name, ip, cacheFlush) {
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(1, 0);                              // tipo A
  fixed.writeUInt16BE(cacheFlush ? 0x8001 : 0x0001, 2);   // clase IN
  fixed.writeUInt32BE(120, 4);                            // TTL
  fixed.writeUInt16BE(4, 8);
  return Buffer.concat([encodeName(name), fixed, Buffer.from(ip.split('.').map(Number))]);
}

function response(id, name, ip, question, legacy) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(legacy ? id : 0, 0);
  h.writeUInt16BE(0x8400, 2);                 // respuesta con autoridad
  h.writeUInt16BE(question ? 1 : 0, 4);
  h.writeUInt16BE(1, 6);
  const parts = [h];
  if (question) parts.push(question);
  parts.push(aRecord(name, ip, !legacy));
  return Buffer.concat(parts);
}

function start(hostname, log = console.log) {
  const name = hostname.toLowerCase().endsWith('.local') ? hostname.toLowerCase() : hostname.toLowerCase() + '.local';
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('error', (e) => { log(`  (Aviso: no se pudo anunciar ${name}: ${e.message}. Usa la IP o el QR.)`); try { sock.close(); } catch {} });

  sock.on('message', (msg, rinfo) => {
    try {
      if (msg.length < 12 || (msg.readUInt16BE(2) & 0x8000)) return; // solo preguntas
      const id = msg.readUInt16BE(0);
      const qd = msg.readUInt16BE(4);
      let off = 12;
      for (let i = 0; i < qd; i++) {
        const q = readName(msg, off);
        const type = msg.readUInt16BE(q.next);
        const qEnd = q.next + 4;
        if (q.name === name && (type === 1 || type === 255)) {
          const ip = pickIP(rinfo.address);
          if (!ip) return;
          const legacy = rinfo.port !== MDNS_PORT; // consultas "normales" (no mDNS) esperan respuesta directa
          const question = legacy ? Buffer.concat([encodeName(name), msg.subarray(q.next, qEnd)]) : null;
          const out = response(id, name, ip, question, legacy);
          if (legacy) sock.send(out, rinfo.port, rinfo.address);
          else sock.send(out, MDNS_PORT, MDNS_ADDR);
        }
        off = qEnd;
      }
    } catch { /* paquete raro: se ignora */ }
  });

  sock.bind(MDNS_PORT, () => {
    for (const i of lanInterfaces()) { try { sock.addMembership(MDNS_ADDR, i.address); } catch {} }
    try { sock.setMulticastTTL(255); sock.setMulticastLoopback(true); } catch {}
    // Anuncio inicial (dos veces, como pide el estándar)
    const announce = () => { const ip = pickIP(); if (ip) sock.send(response(0, name, ip, null, false), MDNS_PORT, MDNS_ADDR, () => {}); };
    announce(); setTimeout(announce, 1000);
  });

  return name;
}

module.exports = { start };
