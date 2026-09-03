// replay.test.mjs — GUI-driven REPLAY of a logged RPC call (dev-only capability).
// Proves: enforced replay re-runs the app's OWN logged method+args referenced by corrId; the
// re-run is tagged origin:'gui'+replayOf with a fresh corrId; announce advertises caps.invoke.
// Controls: unknown corrId is rejected and invokes nothing; allowInvoke:false AND the DEFAULT (no
// allowInvoke at all — the capability fails closed) install NO inbound handler and advertise no
// caps; canReplay gate blocks; the gui-tag never leaks onto a later organic call.
// Uses an injected fake WebSocket (no real network).

import { observe } from '../src/observe.ts';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('replay.test.mjs — GUI replay / invoke\n');

class FakeWS {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWS.last = this; }
  send(s) { this.sent.push(s); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  open() { this.readyState = 1; if (this.onopen) this.onopen(); }         // test helper
  fire(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); } // inbound frame
}
globalThis.WebSocket = FakeWS;

const frames = (ws) => ws.sent.map((s) => JSON.parse(s));
const evs = (ws) => frames(ws).filter((f) => !f.__source);
// Force staged events out synchronously (flusher interval must stay in the 100-250ms window, so
// we drive it manually rather than wait). settle() lets a promise .then emit request.end first.
const settle = () => new Promise((r) => setTimeout(r, 5));
// Bring a reporter's socket up: an organic export constructs it (lazy), then open() flushes.
async function boot(obs, client) {
  obs.wrapClient(client);
  await client.core[Object.keys(client.core)[0]]('__boot__').catch(() => {});
  obs.flusher.flushNow();            // constructs the FakeWS (queues while closed)
  const ws = FakeWS.last;
  ws.open();                          // flush the queue
  return ws;
}

// ---- (A) enforced replay: re-runs the SAME method+args, tagged origin:'gui' ----
{
  const calls = [];
  const client = { core: { getVersion: (...a) => { calls.push(a); return Promise.resolve({ v: 1 }); } } };
  const obs = observe({ websocket: 'ws://x/ws', allowInvoke: true, source: { deviceId: 'd1', appId: 'a1' } });
  const ws = await boot(obs, client);
  check('inbound handler installed when allowInvoke:true', typeof ws.onmessage === 'function');
  await client.core.getVersion('X');
  await settle(); obs.flusher.flushNow();
  const start = evs(ws).find((e) => e.type === 'request.start' && e.method === 'core.getVersion' && e.args && JSON.stringify(e.args).includes('X'));
  check('organic call emitted request.start with a corrId', !!start && !!start.corrId, start && start.corrId);
  check('CONTROL: organic call NOT tagged origin', !!start && start.origin === undefined);
  const corrId = start.corrId;
  const before = calls.length;
  ws.fire({ __invoke: { corrId, invokeId: 'i1' } });
  await settle(); obs.flusher.flushNow();
  check('enforced replay re-ran the SAME method+args', calls.length === before + 1 && JSON.stringify(calls.at(-1)) === JSON.stringify(['X']));
  const guiStart = evs(ws).find((e) => e.type === 'request.start' && e.origin === 'gui');
  check('replay events tagged origin:gui + replayOf + invokeId', !!guiStart && guiStart.replayOf === corrId && guiStart.invokeId === 'i1');
  check('replay got a NEW corrId (not the original)', !!guiStart && guiStart.corrId !== corrId);
  obs.stop();
}

// ---- (B) CONTROL: unknown corrId rejected, invokes nothing ----
{
  const calls = [];
  const client = { core: { getVersion: (...a) => { calls.push(a); return Promise.resolve(1); } } };
  const obs = observe({ websocket: 'ws://x/ws', allowInvoke: true, source: { deviceId: 'd2', appId: 'a' } });
  const ws = await boot(obs, client);
  const before = calls.length;
  ws.fire({ __invoke: { corrId: 'does-not-exist', invokeId: 'i9' } });
  await settle(); obs.flusher.flushNow();
  check('CONTROL: unknown corrId invoked nothing', calls.length === before);
  const err = evs(ws).find((e) => e.type === 'invoke.error');
  check('CONTROL: unknown corrId → invoke.error(unknown-corrId)', !!err && err.error === 'unknown-corrId' && err.invokeId === 'i9');
  obs.stop();
}

// ---- (C) CONTROL: disabled → NO inbound handler, NO caps advertised ----
{
  const client = { core: { getVersion: () => Promise.resolve(1) } };
  const obs = observe({ websocket: 'ws://x/ws', allowInvoke: false, source: { deviceId: 'd3', appId: 'a' } });
  const ws = await boot(obs, client);
  check('CONTROL: allowInvoke:false installs NO inbound handler', ws.onmessage == null);
  const ann = frames(ws).find((f) => f.__source);
  check('CONTROL: disabled announce advertises no caps.invoke', !!ann && !(ann.__source.caps && ann.__source.caps.invoke));
  obs.stop();
}

// ---- (D) enabled announce advertises caps.invoke ----
{
  const obs = observe({ websocket: 'ws://x/ws', allowInvoke: true, source: { deviceId: 'd4', appId: 'a' } });
  const ws = await boot(obs, { core: { ping: () => Promise.resolve(1) } });
  const ann = frames(ws).find((f) => f.__source);
  check('enabled announce advertises caps.invoke:true', !!ann && !!ann.__source.caps && ann.__source.caps.invoke === true);
  obs.stop();
}

// ---- (E) CONTROL: canReplay gate blocks a replay ----
{
  const calls = [];
  const client = { core: { send: (...a) => { calls.push(a); return Promise.resolve(1); } } };
  const obs = observe({ websocket: 'ws://x/ws', allowInvoke: true, canReplay: (m) => m !== 'core.send', source: { deviceId: 'd5', appId: 'a' } });
  const ws = await boot(obs, client);
  await client.core.send('hi');
  await settle(); obs.flusher.flushNow();
  const corrId = evs(ws).find((e) => e.type === 'request.start' && e.method === 'core.send' && JSON.stringify(e.args).includes('hi')).corrId;
  const before = calls.length;
  ws.fire({ __invoke: { corrId, invokeId: 'i2' } });
  await settle(); obs.flusher.flushNow();
  check('CONTROL: canReplay:false blocked the replay (not re-run)', calls.length === before);
  const err = evs(ws).find((e) => e.type === 'invoke.error' && e.error === 'blocked-by-canReplay');
  check('CONTROL: blocked replay → invoke.error(blocked-by-canReplay)', !!err);
  obs.stop();
}

// ---- (F) CONTROL: the gui tag does not leak onto a later organic call ----
{
  const client = { core: { a: () => Promise.resolve(1), b: () => Promise.resolve(2) } };
  const obs = observe({ websocket: 'ws://x/ws', allowInvoke: true, source: { deviceId: 'd6', appId: 'a' } });
  const ws = await boot(obs, client);
  await client.core.a('A');
  await settle(); obs.flusher.flushNow();
  const aStart = evs(ws).find((e) => e.type === 'request.start' && e.method === 'core.a' && JSON.stringify(e.args).includes('A'));
  ws.fire({ __invoke: { corrId: aStart.corrId, invokeId: 'i3' } }); // replay a
  await settle(); obs.flusher.flushNow();
  await client.core.b('B'); // organic b afterwards
  await settle(); obs.flusher.flushNow();
  const bStart = evs(ws).filter((e) => e.type === 'request.start' && e.method === 'core.b').pop();
  check('CONTROL: later organic call is NOT tagged origin:gui', !!bStart && bStart.origin === undefined);
  obs.stop();
}

// ---- (G) edit-and-replay: SAME method, EDITED args ----
{
  const calls = [];
  const client = { core: { echo: (...a) => { calls.push(a); return Promise.resolve(a); } } };
  const obs = observe({ websocket: 'ws://x/ws', allowInvoke: true, source: { deviceId: 'd7', appId: 'a' } });
  const ws = await boot(obs, client);
  await client.core.echo('orig');
  await settle(); obs.flusher.flushNow();
  const corrId = evs(ws).find((e) => e.type === 'request.start' && e.method === 'core.echo').corrId;
  const before = calls.length;
  ws.fire({ __invoke: { corrId, invokeId: 'e1', args: ['edited', 42] } });
  await settle(); obs.flusher.flushNow();
  check('edit-replay ran the SAME method with the EDITED args', calls.length === before + 1 && JSON.stringify(calls.at(-1)) === JSON.stringify(['edited', 42]));
  const guiStart = evs(ws).find((e) => e.type === 'request.start' && e.origin === 'gui');
  check('edited replay is tagged origin:gui + replayOf', !!guiStart && guiStart.replayOf === corrId);
  obs.stop();
}

// ---- (H) CONTROL: non-array edited args rejected, method locked ----
{
  const calls = [];
  // Even if a hostile frame adds a `method` field, the app ignores it (uses rec.method); a
  // non-array `args` is rejected outright.
  const client = { core: { echo: (...a) => { calls.push(['echo', ...a]); return Promise.resolve(1); }, danger: (...a) => { calls.push(['danger', ...a]); return Promise.resolve(1); } } };
  const obs = observe({ websocket: 'ws://x/ws', allowInvoke: true, source: { deviceId: 'd8', appId: 'a' } });
  const ws = await boot(obs, client);
  await client.core.echo('x');
  await settle(); obs.flusher.flushNow();
  const corrId = evs(ws).find((e) => e.type === 'request.start' && e.method === 'core.echo').corrId;
  const before = calls.length;
  ws.fire({ __invoke: { corrId, invokeId: 'e2', args: { not: 'array' } } });
  await settle(); obs.flusher.flushNow();
  check('CONTROL: non-array edited args invoked nothing', calls.length === before);
  check('CONTROL: non-array edited args → invoke.error(bad-args)', !!evs(ws).find((e) => e.type === 'invoke.error' && e.error === 'bad-args'));
  // a crafted method field can't redirect the call — app runs rec.method (core.echo), never core.danger
  ws.fire({ __invoke: { corrId, invokeId: 'e3', method: 'core.danger', args: ['pwn'] } });
  await settle(); obs.flusher.flushNow();
  check('CONTROL: crafted method field ignored — locked to logged method', calls.length === before + 1 && calls.at(-1)[0] === 'echo' && !calls.some((c) => c[0] === 'danger'));
  obs.stop();
}

// ---- (I) default replay window keeps a call replayable well past the old 500 cap ----
// (regression: a chatty app evicted an older-but-still-visible row → replay failed 'unknown-corrId')
{
  const calls = [];
  const client = { core: { getVersion: (...a) => { calls.push(a); return Promise.resolve(1); } } };
  const obs = observe({ websocket: 'ws://x/ws', allowInvoke: true, source: { deviceId: 'd9', appId: 'a' } }); // no replayLogMax → default
  const ws = await boot(obs, client);
  await client.core.getVersion('first');
  await settle(); obs.flusher.flushNow();
  const firstCorr = evs(ws).find((e) => e.type === 'request.start' && JSON.stringify(e.args).includes('first')).corrId;
  for (let i = 0; i < 600; i++) client.core.getVersion('flood-' + i);   // 600 more calls — old 500 cap would evict 'first'
  const before = calls.length;
  ws.fire({ __invoke: { corrId: firstCorr, invokeId: 'iw' } });
  await settle(); obs.flusher.flushNow();
  check('default window replays a 600-calls-old row (would fail at the old 500 cap)',
    calls.length === before + 1 && JSON.stringify(calls.at(-1)) === JSON.stringify(['first']));
  obs.stop();
}

// ---- (J) CONTROL: the DEFAULT (no allowInvoke) fails CLOSED ----
// The gate used to fall back to a sniffed dev flag that returned true whenever neither
// globalThis.__DEV__ nor globalThis.process?.env existed — a production browser bundle and EVERY
// Bare/Pear build. This case pins the default: replay is off unless allowInvoke:true is explicit.
{
  const calls = [];
  const client = { core: { getVersion: (...a) => { calls.push(a); return Promise.resolve(1); } } };
  const obs = observe({ websocket: 'ws://x/ws', source: { deviceId: 'dJ', appId: 'a' } }); // NO allowInvoke
  const ws = await boot(obs, client);
  check('CONTROL: default (no allowInvoke) installs NO inbound handler', ws.onmessage == null);
  const ann = frames(ws).find((f) => f.__source);
  check('CONTROL: default announce advertises NO caps.invoke', !!ann && !(ann.__source.caps && ann.__source.caps.invoke));
  // Even a well-formed frame delivered straight to the socket must do nothing.
  await client.core.getVersion('organic');
  await settle(); obs.flusher.flushNow();
  const start = evs(ws).find((e) => e.type === 'request.start' && e.method === 'core.getVersion');
  const before = calls.length;
  ws.fire({ __invoke: { corrId: start.corrId, invokeId: 'jd1', args: ['pwn'] } }); // no-op: nothing listening
  await settle(); obs.flusher.flushNow();
  check('CONTROL: default ignores a well-formed __invoke frame (nothing re-run)', calls.length === before);
  check('CONTROL: default emits no invoke.error either (frame never reached the app)',
    !evs(ws).some((e) => e.type === 'invoke.error'));
  obs.stop();
}

// ---- (K) the DEFAULT's positive counterpart: the SAME setup + allowInvoke:true still replays ----
// Without this, (J) could pass because replay is broken rather than because it is gated.
{
  const calls = [];
  const client = { core: { getVersion: (...a) => { calls.push(a); return Promise.resolve(1); } } };
  const obs = observe({ websocket: 'ws://x/ws', allowInvoke: true, source: { deviceId: 'dK', appId: 'a' } });
  const ws = await boot(obs, client);
  check('explicit allowInvoke:true installs the inbound handler', typeof ws.onmessage === 'function');
  const ann = frames(ws).find((f) => f.__source);
  check('explicit allowInvoke:true announce advertises caps.invoke', !!ann && ann.__source.caps?.invoke === true);
  await client.core.getVersion('organic');
  await settle(); obs.flusher.flushNow();
  const start = evs(ws).find((e) => e.type === 'request.start' && e.method === 'core.getVersion');
  const before = calls.length;
  ws.fire({ __invoke: { corrId: start.corrId, invokeId: 'k1' } });
  await settle(); obs.flusher.flushNow();
  check('explicit allowInvoke:true still replays the logged call', calls.length === before + 1);
  obs.stop();
}

console.log(failures === 0 ? '\nAll replay claims verified.' : `\n${failures} claim(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
