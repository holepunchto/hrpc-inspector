// inflight.test.mjs — handle.inflight() exposes the request/response calls currently in flight, so
// a thread-occupancy probe (hrpc-inspector-threads) can BLAME a stall on what was running.
//
// Proves: a pending promise call appears in inflight() and disappears once it settles; a settled
// call is gone; a stream's open subscription is NOT counted (by design). Controls: inflight() is
// empty before any call and empty again after settle — so a non-empty reading is real, not vacuous.

import { observe } from '../src/observe.ts';
import { EventEmitter } from 'node:events';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

console.log('inflight.test.mjs — handle.inflight() tracks in-flight request/response calls\n');

const obs = observe({ exporter: { export() {} }, redact: false, source: { deviceId: 'devX', appId: 'demo' } });

// CONTROL 1: nothing has been called yet → no in-flight calls. A non-empty reading later is therefore real.
check('CONTROL: inflight() empty before any call', obs.inflight().length === 0, `n=${obs.inflight().length}`);

// A promise-returning call we can hold open, a sync call, and a stream.
let resolvePending;
const svc = obs.wrapClient({
  db: { get: () => new Promise((res) => { resolvePending = res; }) },
  util: { now: () => 123 },                       // sync — starts and ends in the same turn
  room: { subscribe: () => new EventEmitter() },  // stream — announces via stream.open, not request.start
});

// A pending promise call is IN FLIGHT.
const p = svc.db.get();
const during = obs.inflight();
check('pending promise call appears in inflight()', during.length === 1 && during[0].method === 'db.get',
  JSON.stringify(during));
check('inflight entry carries method + corrId + t', !!during[0] && typeof during[0].corrId === 'string' && typeof during[0].t === 'number',
  during[0] && `corrId=${during[0].corrId} t=${typeof during[0].t}`);

// Settle it → request.end fires on the promise microtask → it leaves inflight().
resolvePending({ ok: true });
await p;
await tick();
check('settled promise call removed from inflight()', obs.inflight().length === 0, `n=${obs.inflight().length}`);

// A SYNC call is never left in flight (request.start and request.end fire in the same call).
svc.util.now();
await tick();
check('CONTROL: sync call not left in flight after return', obs.inflight().length === 0, `n=${obs.inflight().length}`);

// A subscription stream announces via stream.open (not request.start) → NOT counted as in-flight.
const stream = svc.room.subscribe();
await tick();
check('open subscription stream is NOT counted as in-flight (by design)', obs.inflight().length === 0,
  `n=${obs.inflight().length}`);
stream.emit('end'); // clean up (fires request.end; no-op for inflight since it was never added)

// Two concurrent pending calls → both in flight; independence check.
let r1, r2;
const s2 = obs.wrapClient({ a: { x: () => new Promise((r) => { r1 = r; }) }, b: { y: () => new Promise((r) => { r2 = r; }) } });
const pa = s2.a.x(); const pb = s2.b.y();
check('two concurrent pending calls → both in flight', obs.inflight().length === 2, `n=${obs.inflight().length}`);
r1(1); await pa; await tick();
check('resolving one leaves exactly the other in flight', obs.inflight().length === 1 && obs.inflight()[0].method === 'b.y',
  JSON.stringify(obs.inflight()));
r2(2); await pb; await tick();
check('resolving both → inflight() empty', obs.inflight().length === 0, `n=${obs.inflight().length}`);

obs.stop();
console.log(failures === 0 ? '\nAll inflight claims verified.' : `\n${failures} claim(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
