// wrapClient — the generic RPC/service-client tap. Proves it reports endpoint + request +
// response for promises, monitors subscription streams, preserves return value + `this`,
// and (control) does nothing when unwrapped / when stream monitoring is off.

import { EventEmitter } from 'node:events';
import { wrapClient } from '../src/wrap-client.ts';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

console.log('wrap-client.test.mjs — generic RPC/service tap\n');

const makeClient = () => ({
  core: {
    getVersion: async (x) => ({ v: 1, echo: x }),
    fail: async () => { throw new Error('boom'); },
    whoami() { return this === client.core; },
  },
  sub: { watch: () => new EventEmitter() },
});

// --- wrapped client ---
let events = [];
const report = (e) => events.push(e);
const client = makeClient();
wrapClient(client, report);

// (1) promise: request.start + request.end(ok) with response; return value preserved.
const res = await client.core.getVersion('a');
check('promise: return value preserved', JSON.stringify(res) === JSON.stringify({ v: 1, echo: 'a' }), JSON.stringify(res));
const start = events.find((e) => e.type === 'request.start' && e.method === 'core.getVersion');
const end = events.find((e) => e.type === 'request.end' && e.method === 'core.getVersion');
check('promise: request.start reported with args', !!start && JSON.stringify(start.args) === JSON.stringify(['a']));
check('promise: request.end ok with response', !!end && end.status === 'ok' && JSON.stringify(end.response) === JSON.stringify({ v: 1, echo: 'a' }));

// (2) `this` binding preserved.
check('this binding preserved (whoami === true)', client.core.whoami() === true);

// (3) rejection → request.end(error), and the app still sees the rejection.
let threw = false;
try { await client.core.fail(); } catch { threw = true; }
const failEnd = events.find((e) => e.type === 'request.end' && e.method === 'core.fail');
check('rejection: app still sees the error', threw);
check('rejection: reported as request.end error', !!failEnd && failEnd.status === 'error' && /boom/.test(failEnd.error));

// (4) subscription stream: stream.open + stream.data per item + request.end(closed) with count.
events = [];
const stream = client.sub.watch();
stream.emit('data', { n: 1 });
stream.emit('data', { n: 2 });
stream.emit('end');
check('stream: stream.open reported', events.some((e) => e.type === 'stream.open' && e.method === 'sub.watch'));
const datas = events.filter((e) => e.type === 'stream.data' && e.method === 'sub.watch');
check('stream: one stream.data per item, in order', datas.length === 2 && datas[0].seq === 1 && datas[1].seq === 2 && datas[1].item.n === 2);
const streamEnd = events.find((e) => e.type === 'request.end' && e.method === 'sub.watch');
check('stream: settles closed with count', !!streamEnd && streamEnd.status === 'closed' && streamEnd.count === 2);

// (CONTROL A) an UNWRAPPED client emits nothing — proves the tap is what produces events.
let ctlEvents = [];
const raw = makeClient();
await raw.core.getVersion('z');
raw.sub.watch().emit('data', { n: 9 });
check('CONTROL: unwrapped client produces zero events', ctlEvents.length === 0);

// (CONTROL B) monitorStreams:false → no stream.data (proves stream monitoring is load-bearing).
let noStreamEvents = [];
const c2 = makeClient();
wrapClient(c2, (e) => noStreamEvents.push(e), { monitorStreams: false });
c2.sub.watch().emit('data', { n: 1 });
check('CONTROL: monitorStreams:false emits no stream.data', !noStreamEvents.some((e) => e.type === 'stream.data'));

// (PREVIEW) large responses keep STRUCTURE so the GUI can tree them. Regression: a >4000B value
// used to be collapsed into a truncated STRING (rendered as a string, not JSON) — see the field bug.
{
  const big = { items: Array.from({ length: 400 }, (_, i) => ({ i, name: 'msg-' + i, text: 'x'.repeat(20) })) };
  let evs2 = [];
  const c = { core: { list: async () => big } };
  wrapClient(c, (e) => evs2.push(e));
  await c.core.list();
  const end = evs2.find((e) => e.type === 'request.end' && e.method === 'core.list');
  check('preview: >4000B response stays an OBJECT (tree-able), not a truncated string',
    !!end && typeof end.response === 'object' && Array.isArray(end.response.items) && end.response.items.length === 400,
    `bytes=${JSON.stringify(big).length}`);

  const huge = { blob: 'y'.repeat(70000) };
  let evs3 = [];
  const c2 = { core: { load: async () => huge } };
  wrapClient(c2, (e) => evs3.push(e));
  await c2.core.load();
  const end2 = evs3.find((e) => e.type === 'request.end' && e.method === 'core.load');
  check('preview: >64KB response → structured {__truncated} marker (object, not a raw string)',
    !!end2 && typeof end2.response === 'object' && end2.response.__truncated === true && typeof end2.response.bytes === 'number');
}

console.log(failures === 0 ? '\nAll wrap-client claims verified.' : `\n${failures} claim(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
