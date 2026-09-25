// Proves stream monitoring does not change delivery.
//
// The regression this guards: monitorStream used `stream.on('data', ...)`, which is NOT passive —
// it puts the stream into flowing mode at once, so everything emitted before the app attaches its
// own listener goes to the inspector and is LOST to the app. Silent, debug-only data loss.
// keet hits exactly this shape: RPC `subscribe*` returns its stream synchronously while the
// consumer attaches a tick later.
//
// Requires streamx (the runtime's stream implementation). SKIPs cleanly without it.

let Readable;
try {
  ({ Readable } = await import('streamx'));
} catch {
  console.log('  SKIP: streamx not installed (npm i -D streamx to run this)');
  process.exit(0);
}
const { wrapClient } = await import('../src/wrap-client.ts');

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('stream-passive.test.mjs — observing a stream must not consume it\n');

// A correct streamx producer: read(cb) must call cb, or the stream stalls and the test is vacuous.
const makeStream = () => {
  let i = 0;
  return new Readable({
    read(cb) {
      setTimeout(() => {
        if (++i > 3) this.push(null);
        else this.push(i);
        cb(null);
      }, 5);
    },
  });
};

// --- 0. the harness must actually work, or everything below is meaningless ---
{
  const got = [];
  for await (const d of makeStream()) got.push(d);
  check('CONTROL: the test stream delivers all items unmonitored',
    JSON.stringify(got) === '[1,2,3]', JSON.stringify(got));
}

// --- 1. a LATE consumer must still receive everything ---
{
  const events = [];
  const client = { core: { sub() { return makeStream(); } } };
  wrapClient(client, (e) => events.push(e));
  const stream = client.core.sub();

  check('no data listener is registered', stream.listenerCount('data') === 0,
    String(stream.listenerCount('data')));

  const got = [];
  await sleep(12);                        // the app attaches AFTER items began flowing
  stream.on('data', (d) => got.push(d));
  await sleep(150);

  check('a late consumer still receives every item', JSON.stringify(got) === '[1,2,3]',
    JSON.stringify(got));
  check('the inspector still observed the items',
    events.filter((e) => e.type === 'stream.data').length === 3,
    String(events.filter((e) => e.type === 'stream.data').length));
  check('the stream still settles', events.some((e) => e.type === 'request.end'));
  check('stream.open was reported', events.some((e) => e.type === 'stream.open'));
}

// --- 2. async iteration must still terminate ---
{
  const events = [];
  const client = { core: { sub() { return makeStream(); } } };
  wrapClient(client, (e) => events.push(e));
  const got = [];
  const done = await Promise.race([
    (async () => { for await (const d of client.core.sub()) got.push(d); return 'DONE'; })(),
    sleep(600).then(() => 'TIMEOUT'),
  ]);
  check('a for-await consumer completes', done === 'DONE', done);
  check('a for-await consumer receives every item', JSON.stringify(got) === '[1,2,3]',
    JSON.stringify(got));
}

// --- 3. an unconsumed stream must not be forced to flow ---
{
  const events = [];
  const client = { core: { sub() { return makeStream(); } } };
  wrapClient(client, (e) => events.push(e));
  client.core.sub();
  await sleep(80);
  check('an unconsumed stream reports no data (we do not drain it)',
    events.filter((e) => e.type === 'stream.data').length === 0,
    String(events.filter((e) => e.type === 'stream.data').length));
}

// --- 4. monitorStreams:false still opts out entirely ---
{
  const events = [];
  const client = { core: { sub() { return makeStream(); } } };
  wrapClient(client, (e) => events.push(e), { monitorStreams: false });
  const s = client.core.sub();
  const got = [];
  s.on('data', (d) => got.push(d));
  await sleep(150);
  check('monitorStreams:false emits no stream events',
    !events.some((e) => e.type === 'stream.data' || e.type === 'stream.open'));
  check('monitorStreams:false still delivers to the app', JSON.stringify(got) === '[1,2,3]',
    JSON.stringify(got));
}

console.log(failures === 0 ? '\nAll stream-passive claims verified.' : `\n${failures} claim(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
