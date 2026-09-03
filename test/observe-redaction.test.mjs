// Proves redaction is CLOSED on the export path: observe() redacts by default, so raw peer ids,
// signalling tokens and payloads never reach the exporter (hub / .p2plog). The CONTROL
// (redact:false) shows the same data leaking unredacted — redaction is load-bearing.
//
// The second half is the part that matters. This suite used to assert ONLY on a hand-built row
// carrying a `body` key — a key NO producer in this repo ever emits. It therefore passed while
// every real RPC argument and response shipped in the clear, and it was twice cited as proof that
// bodies were summarised. So: drive a REAL wrapClient call and assert the literal secret string is
// absent from the serialized bytes. Asserting on the raw bytes rather than on a field name is
// deliberate — it keeps this test meaningful when a producer adds a fourth payload key.

import { observe } from '../src/observe.ts';
import { StreamFramer } from 'hrpc-inspector-probe/transport/framing';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

console.log('observe-redaction.test.mjs — redaction on the export path (G2 wired)\n');

const collect = () => {
  let wire = new Uint8Array(0);
  return {
    stream: { write(b) { const n = new Uint8Array(wire.length + b.length); n.set(wire); n.set(b, wire.length); wire = n; return true; } },
    first() { return this.all()[0]; },
    all() { const out = []; new StreamFramer((m) => out.push(JSON.parse(new TextDecoder().decode(m)))).push(wire); return out; },
  };
};

// A row carrying exactly the things that must not leave the device raw.
const RAW_PEER = 'peer-abcdef0123456789';
const RAW_URL = 'wss://signal.example.com/room/42?token=SUPERSECRET';
const sensitive = () => ({ type: 'ws.open', corrId: 'c1', method: 'sig.connect',
  peerId: RAW_PEER, url: RAW_URL, body: { secret: 'do-not-leak' }, t: 0 });

// --- default: redaction ON ---
const on = collect();
const obs = observe({ stream: on.stream, autoSwarm: false });
const input = sensitive();
obs.sink.emit(input);
obs.flusher.flushNow();
obs.stop();
const red = on.first();

check('redactor present by default', obs.redactor !== null);
check('peerId is HASHED, not raw', typeof red.peerId === 'string' && red.peerId.startsWith('ph_') && red.peerId !== RAW_PEER, red.peerId);
check('URL stripped to host — token GONE', red.url === 'wss://signal.example.com' && !JSON.stringify(red).includes('SUPERSECRET'), red.url);
check('body summarised (byteLength/hash/shape), not raw', red.body && typeof red.body === 'object' && 'byteLength' in red.body && !('secret' in red.body), JSON.stringify(red.body));
check('input row NOT mutated (live view keeps raw)', input.peerId === RAW_PEER && input.url === RAW_URL);
// method+corrId (needed for the timeline) still present — redaction removes secrets, not structure.
check('non-sensitive fields preserved (method, corrId)', red.method === 'sig.connect' && red.corrId === 'c1');

// --- CONTROL: redaction OFF (local-only view) → data leaks, proving the default is load-bearing ---
const off = collect();
const obs2 = observe({ stream: off.stream, autoSwarm: false, redact: false });
obs2.sink.emit(sensitive());
obs2.flusher.flushNow();
obs2.stop();
const rawOut = off.first();
check('CONTROL: redactor null when redact:false', obs2.redactor === null);
check('CONTROL: raw peerId reaches exporter when OFF', rawOut.peerId === RAW_PEER, rawOut.peerId);
check('CONTROL: token-bearing URL reaches exporter when OFF', rawOut.url === RAW_URL && JSON.stringify(rawOut).includes('SUPERSECRET'));


// ---------------------------------------------------------------------------
// The real producer path: wrapClient emits args / response / item, NOT `body`.
// ---------------------------------------------------------------------------
const SECRET_ARG = 'MY-PRIVATE-MESSAGE-TEXT';
const SECRET_RESP = 'RESPONSE-SECRET-TOKEN';
const SECRET_ITEM = 'STREAM-ITEM-SECRET';

const makeClient = () => ({
  chat: {
    send: async (_room, _text) => ({ ok: true, secretToken: SECRET_RESP }),
  },
});

// --- default (hub path): redaction ON ---
const wc = collect();
const obs3 = observe({ stream: wc.stream, autoSwarm: false });
const client = obs3.wrapClient(makeClient());
await client.chat.send('room-1', SECRET_ARG);
obs3.flusher.flushNow();
obs3.stop();
const wireText = JSON.stringify(wc.all());

check('wrapClient ARGS do not reach the exporter raw', !wireText.includes(SECRET_ARG),
  wireText.slice(0, 200));
check('wrapClient RESPONSE does not reach the exporter raw', !wireText.includes(SECRET_RESP),
  wireText.slice(0, 200));

const startRow = wc.all().find((r) => r.type === 'request.start');
const endRow = wc.all().find((r) => r.type === 'request.end');
check('args summarised to byteLength/hash/shape', !!startRow && startRow.args
  && typeof startRow.args === 'object' && 'byteLength' in startRow.args,
  JSON.stringify(startRow && startRow.args));
check('response summarised to byteLength/hash/shape', !!endRow && endRow.response
  && typeof endRow.response === 'object' && 'byteLength' in endRow.response,
  JSON.stringify(endRow && endRow.response));
// The timeline must survive redaction — a summarised row is still a usable row.
check('endpoint + corrId + duration still present', !!startRow && startRow.method === 'chat.send'
  && !!startRow.corrId && !!endRow && typeof endRow.dur === 'number');

// --- stream.data carries `item` on the same path ---
const sc = collect();
const obs4 = observe({ stream: sc.stream, autoSwarm: false });
const streamClient = obs4.wrapClient({
  notes: {
    subscribe: () => {
      const handlers = {};
      const st = { on: (ev, fn) => { handlers[ev] = fn; return st; } };
      setTimeout(() => handlers.data && handlers.data({ text: SECRET_ITEM }), 0);
      return st;
    },
  },
});
streamClient.notes.subscribe();
await new Promise((r) => setTimeout(r, 10));
obs4.flusher.flushNow();
obs4.stop();
check('stream.data ITEM does not reach the exporter raw',
  !JSON.stringify(sc.all()).includes(SECRET_ITEM), JSON.stringify(sc.all()).slice(0, 200));

// --- CONTROL: the same call with redaction OFF must leak, or the assertions above are vacuous ---
const wcOff = collect();
const obs5 = observe({ stream: wcOff.stream, autoSwarm: false, redact: false });
const clientOff = obs5.wrapClient(makeClient());
await clientOff.chat.send('room-1', SECRET_ARG);
obs5.flusher.flushNow();
obs5.stop();
const offText = JSON.stringify(wcOff.all());
check('CONTROL: args DO reach the exporter when redact:false', offText.includes(SECRET_ARG));
check('CONTROL: response DOES reach the exporter when redact:false', offText.includes(SECRET_RESP));

console.log(failures === 0 ? '\nAll observe-redaction claims verified.' : `\n${failures} claim(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
