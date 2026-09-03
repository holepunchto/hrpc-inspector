// GUI server — DEPENDENCY-FREE (no `ws`), so `npx hrpc-inspector gui` needs zero install.
// Serves the inspector and accepts events over a hand-rolled RFC6455 WebSocket at /ws.
// Apps stream events in; browsers (identified by a {__hello:'browser'} frame) get history +
// live fan-out. Node built-ins only: http + crypto.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// CSRF / cross-origin guard for the WS upgrade. A browser WebSocket ALWAYS sends an Origin header,
// so this stops a random page you're visiting from opening ws://127.0.0.1:PORT and driving replay
// (the 127.0.0.1 bind is NOT an access boundary — any local page can reach it). App reporters
// (Node/RN, non-browser) send NO Origin header at all and are allowed. Allowed: absent Origin,
// loopback Origin, or same-host as the served page (covers a deliberate LAN --host bind).
//
// Origin: null is REJECTED. It is not a non-browser marker: a sandboxed or cross-origin-redirected
// browsing context serializes its OPAQUE origin as exactly the string "null", so allowing it lets
// any page a developer visits open ws://127.0.0.1:PORT inside a sandboxed iframe and read the whole
// unredacted history, drive replay, and send __clear. Absent-Origin already covers real reporters.
// `allowNullOrigin` exists only for a runtime whose WebSocket client genuinely sends "null"; it
// re-opens the hole for browsers too, so it is off by default and warns loudly when on.
export function originAllowed(req, { allowNullOrigin = false } = {}) {
  const origin = req.headers['origin'];
  if (!origin) return true;                                       // non-browser client (app reporter)
  if (origin === 'null') return allowNullOrigin === true;         // opaque origin — a browser, unless opted in
  let host;
  try { host = new URL(origin).hostname; } catch { return false; } // malformed → reject
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
  const reqHost = String(req.headers['host'] || '').split(':')[0];
  return host === reqHost;                                        // same-origin as the page we served
}

// ---- minimal WebSocket frame codec (text frames; masks client→server; handles ping/close) ----
function encodeFrame(payload, opcode = 0x1) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

function wsConnection(socket, onText, onClose) {
  let buf = Buffer.alloc(0);
  let closed = false;
  const done = () => { if (!closed) { closed = true; onClose(); } };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
      const need = offset + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      const mask = masked ? buf.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(buf.subarray(offset + (masked ? 4 : 0), need)); // copy out before advancing
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(need);
      if (opcode === 0x8) { try { socket.end(); } catch {} done(); return; }      // close
      else if (opcode === 0x9) { try { socket.write(encodeFrame(payload, 0xA)); } catch {} } // ping → pong
      else if (opcode === 0x1 || opcode === 0x0) onText(payload.toString('utf8')); // text / continuation
      // binary (0x2) and others ignored — this tool speaks JSON text only
    }
  });
  socket.on('close', done);
  socket.on('error', done);
  return { send(str) { try { socket.write(encodeFrame(Buffer.from(str, 'utf8'), 0x1)); } catch {} } };
}

export function startGui({ port = 9420, demo = false, host = '127.0.0.1', allowNullOrigin = false } = {}) {
  const DIR = dirname(fileURLToPath(import.meta.url));
  const HISTORY = [];
  const MAX_HISTORY = 2000;
  // Source announces are ONE-TIME frames; if kept in the rolling HISTORY they get evicted after
  // MAX_HISTORY events, and late-connecting browsers then never learn a source's label (the chip
  // falls back to the raw, URL-encoded id — "%2F…"). Keep the latest announce per id here instead,
  // unbounded by event volume, and replay them before the event history on every browser connect.
  const sources = new Map();      // source id -> the {__source} frame
  const sourceRefs = new Map();   // source id -> # of open emitter connections announcing it
  const sourceConns = new Map();  // source id -> Set<emitter conn> (for routing GUI replays back)
  const browsers = new Set();

  // Single ingest path for both app frames and --demo: announces are sticky (sources map),
  // everything else is bounded event history. Both fan out to connected browsers.
  const ingest = (ev) => {
    if (ev && ev.__source) { if (ev.__source.id) sources.set(ev.__source.id, ev); }
    else { HISTORY.push(ev); if (HISTORY.length > MAX_HISTORY) HISTORY.shift(); }
    for (const b of browsers) b.send(JSON.stringify(ev));
  };

  const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(readFileSync(join(DIR, 'index.html')));
    } else { res.writeHead(404); res.end('not found'); }
  });

  server.on('upgrade', (req, socket) => {
    if (req.url !== '/ws' || !req.headers['sec-websocket-key']) { socket.destroy(); return; }
    if (!originAllowed(req, { allowNullOrigin })) { socket.destroy(); return; } // reject cross-origin browser pages (CSRF)
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    let isBrowser = false;
    const announced = new Set();   // source ids THIS emitter connection announced
    const conn = wsConnection(socket, onText, onClose);
    function onClose() {
      browsers.delete(conn);
      // An emitter went away → drop the sources it announced so the chip stops lingering, and tell
      // viewers to remove them. Refcounted so a reconnect that re-announces before this close fires
      // (TCP can deliver the new socket's announce first) doesn't evict a live source.
      for (const id of announced) {
        const set = sourceConns.get(id); if (set) { set.delete(conn); if (set.size === 0) sourceConns.delete(id); }
        const n = (sourceRefs.get(id) || 1) - 1;
        if (n > 0) { sourceRefs.set(id, n); continue; }
        sourceRefs.delete(id); sources.delete(id);
        for (const b of browsers) b.send(JSON.stringify({ __source_gone: id }));
      }
    }
    function onText(text) {
      let ev; try { ev = JSON.parse(text); } catch { return; }
      if (ev && ev.__hello === 'browser') {           // a viewer: replay sources, then history, then live
        isBrowser = true; browsers.add(conn);
        for (const s of sources.values()) conn.send(JSON.stringify(s)); // labels first, never evicted
        for (const e of HISTORY) conn.send(JSON.stringify(e));
        return;
      }
      // A viewer replaying a logged call: route {__invoke:{corrId,target,invokeId,args?}} to ONE
      // live emitter for the target source — but only if that source advertised caps.invoke.
      // Boundary, precisely: the METHOD is not on the wire — the app resolves it from its own log
      // for that corrId, so a viewer cannot redirect the replay to a different method. The `args`
      // ARE viewer-supplied (the GUI's edit-and-replay sends them) and this server does not
      // inspect them; the app only checks that they are a JSON array. So an opted-in app can be
      // asked to re-run a method it already called, with arbitrary arguments. The app's
      // `canReplay(method, args)` hook is the only argument check in the system.
      if (isBrowser) {
        // A viewer purging server-side history so a Clear actually sticks across reconnect/refresh
        // (browsers replay HISTORY on connect). scope 'all' wipes everything; 'device' wipes one
        // source's events. Source announces (chips) are left intact — the devices are still live.
        // The purge is broadcast to ALL browsers so every open viewer clears in lockstep.
        if (ev && ev.__clear) {
          const scope = ev.__clear.scope, src = ev.__clear.src;
          if (scope === 'device' && src) {
            for (let k = HISTORY.length - 1; k >= 0; k--) { const e = HISTORY[k]; if (e && e.src === src) HISTORY.splice(k, 1); }
            for (const b of browsers) b.send(JSON.stringify({ __cleared: { scope: 'device', src } }));
          } else {
            HISTORY.length = 0;
            for (const b of browsers) b.send(JSON.stringify({ __cleared: { scope: 'all' } }));
          }
          return;
        }
        if (ev && ev.__invoke && ev.__invoke.target) {
          const t = ev.__invoke.target, iid = ev.__invoke.invokeId;
          const set = sourceConns.get(t);
          const src = sources.get(t);
          if (!set || set.size === 0 || !src?.__source?.caps?.invoke) {
            conn.send(JSON.stringify({ type: 'invoke.error', invokeId: iid, replayOf: ev.__invoke.corrId, origin: 'gui', error: 'target-not-invocable', t: Date.now() }));
          } else {
            [...set].at(-1).send(JSON.stringify(ev)); // most-recent connection; avoids double-exec across reconnect sockets
          }
        }
        return;                                         // browsers never inject events into history
      }
      if (ev && ev.__source && ev.__source.id && !announced.has(ev.__source.id)) {
        announced.add(ev.__source.id);
        sourceRefs.set(ev.__source.id, (sourceRefs.get(ev.__source.id) || 0) + 1);
        (sourceConns.get(ev.__source.id) ?? sourceConns.set(ev.__source.id, new Set()).get(ev.__source.id)).add(conn);
      }
      ingest(ev);
    }
  });

  server.listen(port, host, () => {
    console.log(`observe-gui: http://localhost:${port}  (ws://…:${port}/ws)  bound ${host}`);
    console.log('Android: `adb reverse tcp:%d tcp:%d`; iOS sim: 127.0.0.1.', port, port);
    // Default localhost keeps the replay/invoke channel off the LAN (privacy-reviewer #1). Only a
    // deliberate --host 0.0.0.0 exposes it — and then any LAN host can reach a dev build's core.
    if (host !== '127.0.0.1' && host !== 'localhost') {
      console.log('⚠️  bound %s (not localhost): the GUI — including replay into a running dev app — is reachable from the LAN. Prefer `adb reverse`/a tunnel and keep 127.0.0.1.', host);
    }
    if (allowNullOrigin) {
      console.log('⚠️  allowNullOrigin: WS upgrades with `Origin: null` are accepted. A sandboxed cross-origin iframe on ANY page you visit sends exactly that origin, so it can read this GUI\'s full unredacted history, drive replay into your dev app, and clear it. Only use this for a non-browser client that insists on sending "null".');
    }
    if (demo) startDemo(ingest);
  });
  return server;
}

// --demo: synthetic events (incl. multiple sources + a subscription stream) so the GUI is
// visible without an app. `emit` fans a single event out to browsers + history.
function startDemo(emit) {
  const eps = ['core.getVersion', 'notes.create', 'swarm.ready', 'feedback.send', 'notes.send'];
  const sources = [
    { id: 'd=devA;a=sample-app', deviceId: 'devA', device: 'devA', appId: 'sample-app', label: 'sample-app · devA', runtime: 'react-native' },
    { id: 'd=devB;a=sample-app', deviceId: 'devB', device: 'Phone (sim)', appId: 'sample-app', label: 'sample-app · Phone (sim)', runtime: 'react-native' },
    { id: 'd=devA;a=sample-app-nightly', deviceId: 'devA', device: 'devA', appId: 'sample-app-nightly', label: 'sample-app-nightly · devA', runtime: 'react-native' },
  ];
  for (const s of sources) emit({ __source: s });
  const srcOf = (n) => sources[n % sources.length].id;
  let i = 0;
  emit({ type: 'request.start', method: 'notes.subscribe', corrId: 'demo-sub', args: [{ roomId: 'r-1' }], t: nowish(), src: 'd=devA;a=sample-app' });
  emit({ type: 'stream.open', method: 'notes.subscribe', corrId: 'demo-sub', t: nowish(), src: 'd=devA;a=sample-app' });
  let sseq = 0;
  setInterval(() => emit({ type: 'stream.data', method: 'notes.subscribe', corrId: 'demo-sub', seq: ++sseq, item: { revision: 100 + sseq }, t: nowish(), src: 'd=devA;a=sample-app' }), 1500);
  setInterval(() => {
    const method = eps[i % eps.length], corrId = 'demo-' + i++, src = srcOf(i), dur = 8 + (i % 5) * 22;
    emit({ type: 'request.start', method, corrId, args: [{ roomId: 'r-' + (i % 3) }], t: nowish(), src });
    const fail = method === 'feedback.send' && i % 4 === 0;
    setTimeout(() => emit(fail
      ? { type: 'request.end', method, corrId, status: 'error', error: 'timeout', dur, t: nowish(), src }
      : { type: 'request.end', method, corrId, status: 'ok', response: { ok: true, n: i }, dur, t: nowish(), src }), dur);
  }, 900);
}
function nowish() { return Date.now(); }

// Run directly for local debugging (equivalent to the old `node tools/observe-gui/server.mjs`):
//   node gui/server.mjs [--port N] [--demo] [--host 0.0.0.0] [--allow-null-origin]
// Default host is 127.0.0.1 (localhost-only). --host 0.0.0.0 opts into LAN exposure (warns).
// --allow-null-origin re-admits `Origin: null` WS upgrades — a browser CSRF hole, off by default.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const a = process.argv.slice(2);
  const i = a.indexOf('--port');
  const h = a.indexOf('--host');
  startGui({
    port: i >= 0 ? Number(a[i + 1]) : Number(process.env.OBSERVE_PORT || 9420),
    demo: a.includes('--demo'),
    host: h >= 0 ? a[h + 1] : (process.env.OBSERVE_HOST || '127.0.0.1'),
    allowNullOrigin: a.includes('--allow-null-origin'),
  });
}
