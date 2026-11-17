// Maestro — motor del show (compartido por el reproductor del ordenador y la app del móvil)
//
// El guion (show) es una lista de elementos:
//   { id, type: 'block',   title, note }                         → cabecera de bloque (no suena)
//   { id, type: 'song',    file, title?, note, after, fadeIn, fadeOut, startAt?, endAt?, loop }
//   { id, type: 'silence', seconds, note, after }
// after: 'wait'     → al terminar se queda listo el siguiente, esperando la orden
//        'continue' → al terminar arranca el siguiente sin parar
// show.gains[file] = volumen propio de cada canción (0..1)
//
// io (lo aporta cada plataforma):
//   songUrl(file), listSongs() → [{file,title}], loadShow() → show|null,
//   saveShow(show), pushState(state)

(function (global) {
  const uid = () => Math.random().toString(36).slice(2, 10);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const titleOf = (file) => String(file || '').replace(/\.[^.]+$/, '').replace(/^\d+[\s._-]+/, '');

  function normalize(show) {
    show = show && typeof show === 'object' ? show : {};
    const items = Array.isArray(show.items) ? show.items : [];
    return {
      name: show.name || 'Mi show',
      rev: show.rev || String(Date.now()),
      gains: show.gains && typeof show.gains === 'object' ? show.gains : {},
      items: items.filter((i) => i && ['block', 'song', 'silence'].includes(i.type)).map((i) => ({
        id: i.id || uid(),
        type: i.type,
        title: i.title || '',
        note: i.note || '',
        file: i.file || '',
        seconds: Number(i.seconds) > 0 ? Number(i.seconds) : 5,
        after: i.after === 'continue' ? 'continue' : 'wait',
        fadeIn: Math.max(0, Number(i.fadeIn) || 0),
        fadeOut: Math.max(0, Number(i.fadeOut) || 0),
        startAt: Math.max(0, Number(i.startAt) || 0),
        endAt: Math.max(0, Number(i.endAt) || 0),
        loop: !!i.loop,
      })),
    };
  }

  function Engine(io) {
    // Reproductor activo + uno de reserva con la siguiente canción ya cargada (arranque instantáneo)
    function makeAudio() {
      const a = new Audio();
      a.preload = 'auto';
      a.addEventListener('ended', () => { if (a === audio && current && current.kind === 'song' && !endHandled) { endHandled = true; onItemEnd(); } });
      return a;
    }
    let audio = makeAudio();
    let pre = null;   // { file, startAt, el }

    let show = normalize(null);
    let songs = [];
    const durations = {};
    let master = 1;               // volumen general 0..1
    let fadeK = 1;                // factor de fundido 0..1
    let current = null;           // { kind:'song'|'silence', item, index (-1 = libre) }
    let cueIndex = -1;            // último elemento disparado del guion
    let nextIndex = -1;           // lo que dispara SIGUIENTE
    let nextManual = false;       // true si el técnico eligió a mano la siguiente (ir a / saltar / atrás)
    let rampTimer = null, ramping = null;   // 'in' | 'out' | null
    let endHandled = false;
    let silence = { end: 0, total: 0, pausedLeft: 0 };
    let standbySince = Date.now();
    let showStartedAt = null;
    let lastPush = 0;

    const gainOf = (file) => (file && typeof show.gains[file] === 'number' ? clamp(show.gains[file], 0, 1) : 1);
    const itemTitle = (it) => !it ? '' : it.type === 'silence' ? (it.title || 'Silencio ' + it.seconds + ' s') : (it.title || titleOf(it.file) || 'Bloque');
    const playable = (it) => it && (it.type === 'song' || it.type === 'silence');

    function nextPlayable(i) { for (let k = Math.max(0, i); k < show.items.length; k++) if (playable(show.items[k])) return k; return -1; }
    function prevPlayable(i) { for (let k = Math.min(i, show.items.length - 1); k >= 0; k--) if (playable(show.items[k])) return k; return -1; }

    function applyVol() {
      const g = current && current.kind === 'song' ? gainOf(current.item.file) : 1;
      audio.volume = clamp(master * g * fadeK, 0, 1);
    }

    function stopRamp() { if (rampTimer) clearInterval(rampTimer); rampTimer = null; ramping = null; }
    function ramp(to, seconds, done, kind) {
      stopRamp();
      if (!(seconds > 0)) { fadeK = to; applyVol(); done && done(); return; }
      ramping = kind || (to < fadeK ? 'out' : 'in');
      const from = fadeK, steps = Math.max(1, Math.round(seconds * 20)); let i = 0;
      rampTimer = setInterval(() => {
        i++; fadeK = from + (to - from) * (i / steps); applyVol();
        if (i >= steps) { stopRamp(); done && done(); }
      }, 50);
      push(true);
    }

    function stopAudio() {
      stopRamp(); endHandled = true;
      audio.pause(); audio.loop = false;
      audio.removeAttribute('src'); audio.load();
    }

    function clearSilence() { silence = { end: 0, total: 0, pausedLeft: 0 }; }

    function goIdle() { stopAudio(); clearSilence(); current = null; standbySince = Date.now(); push(true); }

    function markStart(index) { if (index >= 0 && !showStartedAt) showStartedAt = Date.now(); }

    // Cuando un elemento del guion termina por sí solo
    function onItemEnd() {
      const wasCue = current && current.index >= 0;
      const it = current && current.item;
      stopAudio(); clearSilence(); current = null; standbySince = Date.now();
      if (wasCue && it && it.after === 'continue' && nextIndex >= 0) fire(nextIndex);
      else push(true);
    }

    // Sale lo que esté sonando (fundido corto) y luego ejecuta fn
    function clearThen(fn) {
      if (current && current.kind === 'song' && !audio.paused) { endHandled = true; ramp(0, 0.4, () => { stopAudio(); fn(); }, 'out'); }
      else { stopAudio(); clearSilence(); fn(); }
    }

    function startSong(item, index) {
      clearThen(() => {
        clearSilence();
        current = { kind: 'song', item, index };
        endHandled = false;
        const startAt = item.startAt || 0;
        if (pre && pre.el && pre.file === item.file && pre.startAt === startAt) {
          audio = pre.el; pre = null;                 // ya estaba cargada: arranque instantáneo
          if (startAt > 0 && audio.readyState > 0 && Math.abs(audio.currentTime - startAt) > 0.3) { try { audio.currentTime = startAt; } catch {} }
        } else {
          audio = makeAudio();
          audio.src = io.songUrl(item.file);
          if (startAt > 0) { const a = audio; a.addEventListener('loadedmetadata', () => { try { a.currentTime = startAt; } catch {} }, { once: true }); }
        }
        audio.loop = !!item.loop;
        fadeK = item.fadeIn > 0 ? 0 : 1; applyVol();
        audio.play().catch(() => {});
        if (item.fadeIn > 0) ramp(1, item.fadeIn, null, 'in');
        if (index >= 0) { cueIndex = index; nextIndex = nextPlayable(index + 1); nextManual = false; markStart(index); }
        push(true);
      });
    }

    function startSilence(item, index) {
      clearThen(() => {
        current = { kind: 'silence', item, index };
        silence = { end: Date.now() + item.seconds * 1000, total: item.seconds, pausedLeft: 0 };
        if (index >= 0) { cueIndex = index; nextIndex = nextPlayable(index + 1); nextManual = false; markStart(index); }
        push(true);
      });
    }

    function fire(index) {
      const it = show.items[index];
      if (!it) return;
      if (it.type === 'block') { const n = nextPlayable(index + 1); if (n >= 0) fire(n); return; }
      if (it.type === 'song') startSong(it, index); else startSilence(it, index);
    }

    // Vigilancia: final de canción (corte o fundido de salida) y final de silencio
    setInterval(() => {
      if (!current) return;
      if (current.kind === 'silence') {
        if (!silence.pausedLeft && Date.now() >= silence.end) onItemEnd();
        else push();
        return;
      }
      const it = current.item;
      if (audio.paused || endHandled || ramping === 'out') { push(); return; }
      const dur = isFinite(audio.duration) ? audio.duration : 0;
      const end = it.endAt > 0 ? it.endAt : (it.loop ? 0 : dur);
      if (end > 0 && audio.currentTime >= end - (it.fadeOut || 0)) {
        endHandled = true;
        if (it.fadeOut > 0) ramp(0, it.fadeOut, onItemEnd, 'out'); else onItemEnd();
      }
      push();
    }, 100);

    // ---------- precarga de la siguiente canción del guion ----------
    function nextSongItem() {
      if (nextIndex < 0) return null;
      for (let k = nextIndex; k < show.items.length; k++) if (show.items[k].type === 'song') return show.items[k];
      return null;
    }
    function dropPre() { if (pre) { if (pre.el) { pre.el.removeAttribute('src'); pre.el.load(); } pre = null; } }
    function preloadNext() {
      const it = nextSongItem();
      if (!it || !it.file) { dropPre(); return; }
      const startAt = it.startAt || 0;
      if (pre && pre.file === it.file && pre.startAt === startAt) return;
      if (current && current.kind === 'song' && current.item.file === it.file) return; // es la misma que suena
      dropPre();
      const mine = { file: it.file, startAt, el: null };
      pre = mine;
      const attach = (url) => {
        if (pre !== mine || !url) return;
        const el = makeAudio();
        el.src = url;
        if (startAt > 0) el.addEventListener('loadedmetadata', () => { try { el.currentTime = startAt; } catch {} }, { once: true });
        el.load();
        mine.el = el;
      };
      // Si la plataforma puede traer la canción entera a memoria (ordenador), se espera a tenerla
      if (io.prefetch) io.prefetch(it.file).then(attach, () => attach(io.songUrl(it.file)));
      else attach(io.songUrl(it.file));
    }

    // ---------- duraciones (para tiempos y hora de fin) ----------
    function probeDurations() {
      for (const s of songs) {
        if (durations[s.file]) continue;
        const a = new Audio(); a.preload = 'metadata';
        a.addEventListener('loadedmetadata', () => { if (isFinite(a.duration)) { durations[s.file] = Math.round(a.duration * 10) / 10; push(true); } a.removeAttribute('src'); });
        a.src = io.songUrl(s.file);
      }
    }

    function itemLength(it) {
      if (!it) return 0;
      if (it.type === 'silence') return it.seconds;
      if (it.type !== 'song') return 0;
      const d = durations[it.file] || 0;
      return Math.max(0, (it.endAt > 0 ? Math.min(it.endAt, d || it.endAt) : d) - (it.startAt || 0));
    }

    // ---------- estado para el control ----------
    function remainingNow() {
      if (!current) return 0;
      if (current.kind === 'silence') return silence.pausedLeft || Math.max(0, (silence.end - Date.now()) / 1000);
      const dur = isFinite(audio.duration) ? audio.duration : (durations[current.item.file] || 0);
      const end = current.item.endAt > 0 ? current.item.endAt : dur;
      return Math.max(0, end - (audio.currentTime || 0));
    }

    function state() {
      const it = current && current.item;
      const status = !current ? 'stopped' : current.kind === 'silence' ? (silence.pausedLeft ? 'paused' : 'silence')
        : ramping === 'out' ? 'fading' : audio.paused ? 'paused' : 'playing';
      const dur = current && current.kind === 'song' ? (current.item.endAt > 0 ? current.item.endAt : (isFinite(audio.duration) ? audio.duration : 0)) : silence.total;
      const pos = current && current.kind === 'song' ? (audio.currentTime || 0) : current ? silence.total - remainingNow() : 0;
      let est = remainingNow();
      if (nextIndex >= 0) for (let k = nextIndex; k < show.items.length; k++) est += itemLength(show.items[k]);
      const nx = nextIndex >= 0 ? show.items[nextIndex] : null;
      return {
        status, kind: current ? current.kind : null, mode: current ? (current.index >= 0 ? 'guion' : 'libre') : null,
        file: it && it.file || null, title: it ? itemTitle(it) : null, note: it ? it.note : '',
        itemId: it ? it.id : null, after: it ? it.after : null,
        cueIndex, nextIndex, nextTitle: nx ? itemTitle(nx) : null, nextNote: nx ? nx.note : '', nextAfter: nx ? nx.after : null,
        position: pos, duration: dur, remaining: remainingNow(),
        standbyElapsed: current ? 0 : (Date.now() - standbySince) / 1000,
        showElapsed: showStartedAt ? (Date.now() - showStartedAt) / 1000 : 0,
        estRemaining: est,
        volume: master, gain: it && it.type === 'song' ? gainOf(it.file) : null,
        showVersion: show.rev, showName: show.name, durations,
        players: 1,
      };
    }

    function push(force) {
      try { preloadNext(); } catch {}
      const now = Date.now();
      if (!force && now - lastPush < 450) return;
      lastPush = now;
      try { io.pushState(state()); } catch {}
    }
    setInterval(() => push(), 500);

    function saveShow() { show.rev = String(Date.now()) + uid(); try { io.saveShow(show); } catch {} push(true); }

    function setShow(s, persist) {
      const curId = current && current.item && current.item.id;
      const nextId = nextIndex >= 0 && show.items[nextIndex] ? show.items[nextIndex].id : null;
      show = normalize(s);
      // mantener posiciones por identificador
      if (current && current.index >= 0) { const k = show.items.findIndex((i) => i.id === curId); current.index = k; cueIndex = k; }
      const nk = nextId ? show.items.findIndex((i) => i.id === nextId) : -1;
      // Si la siguiente se eligió a mano, se respeta; si no, la siguiente es la que sigue en el guion nuevo
      nextIndex = nextManual && nk >= 0 ? nk : nextPlayable(cueIndex + 1);
      if (nextIndex !== nk) { try { dropPre(); preloadNext(); } catch {} }
      if (persist) { try { io.saveShow(show); } catch {} }
      push(true);
    }

    async function refreshSongs() {
      try { songs = await io.listSongs(); } catch { songs = []; }
      probeDurations();
      // Si no hay guion, se crea uno con todas las canciones (cada una espera la orden)
      if (!show.items.length && songs.length) {
        show.items = songs.map((s) => ({ id: uid(), type: 'song', file: s.file, title: '', note: '', after: 'wait', fadeIn: 0, fadeOut: 0, startAt: 0, endAt: 0, loop: false, seconds: 5 }));
        show = normalize(show); nextIndex = nextPlayable(0); saveShow();
      }
      push(true);
    }

    async function init() {
      try { const s = await io.loadShow(); if (s) setShow(s, false); } catch {}
      if (nextIndex < 0) nextIndex = nextPlayable(0);
      await refreshSongs();
    }

    // ---------- órdenes ----------
    function handle(cmd) {
      switch (cmd.cmd) {
        case 'go': if (nextIndex >= 0) fire(nextIndex); break;
        case 'fire': fire(Number(cmd.index)); break;
        case 'goto': { const k = Number(cmd.index); nextIndex = playable(show.items[k]) ? k : nextPlayable(k); nextManual = true; push(true); break; }
        case 'skip': nextIndex = nextIndex >= 0 ? nextPlayable(nextIndex + 1) : -1; nextManual = true; push(true); break;
        case 'back': nextIndex = prevPlayable((nextIndex >= 0 ? nextIndex : show.items.length) - 1); if (nextIndex < 0) nextIndex = nextPlayable(0); nextManual = true; push(true); break;
        case 'restart': goIdle(); cueIndex = -1; nextIndex = nextPlayable(0); nextManual = false; showStartedAt = null; push(true); break;
        case 'play': { // reproducción libre, fuera del guion
          const s = songs.find((x) => x.file === cmd.file) || (cmd.file ? { file: cmd.file } : null);
          if (s) startSong({ id: 'libre', type: 'song', file: s.file, title: '', note: '', after: 'wait', fadeIn: 0, fadeOut: 0, startAt: 0, endAt: 0, loop: false }, -1);
          break;
        }
        case 'toggle':
          if (!current) break;
          if (current.kind === 'silence') {
            if (silence.pausedLeft) { silence.end = Date.now() + silence.pausedLeft * 1000; silence.pausedLeft = 0; }
            else silence.pausedLeft = Math.max(0.1, (silence.end - Date.now()) / 1000);
          } else if (audio.paused) { stopRamp(); fadeK = 1; applyVol(); audio.play().catch(() => {}); }
          else audio.pause();
          push(true); break;
        case 'stop': goIdle(); break;
        // endHandled = true: si la canción termina sola durante el fundido, NO se encadena lo siguiente
        case 'fade': if (current && current.kind === 'song' && !audio.paused) { endHandled = true; ramp(0, Number(cmd.value) || 3, goIdle, 'out'); } else goIdle(); break;
        case 'panic': if (current && current.kind === 'song' && !audio.paused) { endHandled = true; ramp(0, 1.5, goIdle, 'out'); } else goIdle(); break;
        case 'volume': master = clamp(Number(cmd.value), 0, 1); applyVol(); push(true); break;
        case 'volstep': master = clamp(Math.round(master * 100 + Number(cmd.value || 0)) / 100, 0, 1); applyVol(); push(true); break;
        case 'gain': {
          const file = cmd.file || (current && current.item && current.item.file);
          if (!file) break;
          const base = typeof show.gains[file] === 'number' ? show.gains[file] : 1;
          const v = cmd.delta !== undefined ? Math.round(base * 100 + Number(cmd.delta)) / 100 : Number(cmd.value);
          show.gains[file] = clamp(v, 0, 1); applyVol(); saveShow(); break;
        }
        case 'seek': if (current && current.kind === 'song' && isFinite(audio.duration)) audio.currentTime = clamp(Number(cmd.value) || 0, 0, audio.duration - 0.1); push(true); break;
        case 'setShow': setShow(cmd.show, true); break;
        case 'reloadSongs': refreshSongs(); break;
      }
    }

    return { init, handle, refreshSongs, setShow, state, get show() { return show; }, get preloaded() { return pre ? pre.file : null; }, resetPreload() { dropPre(); preloadNext(); }, get playingEl() { return audio; } };
  }

  global.EscenarioEngine = { Engine, normalize, titleOf };
})(typeof window !== 'undefined' ? window : globalThis);
