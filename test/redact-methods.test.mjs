// Proves `redactMethods` keeps a call VISIBLE while removing its values.
//
// The distinction that matters: a skipped method would vanish entirely, losing the fact that it
// ran. Here the GUI still shows the call, its timing, its status and the SHAPE of the payload —
// only the values are replaced by a content summary. Everything not listed stays fully readable,
// which is the whole point of the local viewer.

import { observe } from '../src/observe.ts';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

console.log('redact-methods.test.mjs — listed methods keep keys, lose values\n');

const SECRET = 'ripple lunar velvet oak';
const exported = [];
const exporter = { export: (rows) => exported.push(...rows), close() {} };

const makeClient = () => ({
  core: {
    async getRecoveryPhrase() { return { phrase: SECRET, createdAt: 1730000000 }; },
    async getRoomInfo() { return { title: 'General' }; },
  },
});

const obs = observe({
  exporter,
  redact: false,                                  // local viewer: everything readable by default
  redactMethods: ['core.getRecoveryPhrase'],      // ...except this one
  intervalMs: 200,
});
const client = obs.wrapClient(makeClient());

await client.core.getRecoveryPhrase();
await client.core.getRoomInfo();
obs.flusher.flushNow();

const bySecret = exported.filter((e) => e.method === 'core.getRecoveryPhrase');
const byRoom = exported.filter((e) => e.method === 'core.getRoomInfo');
const end = bySecret.find((e) => e.type === 'request.end');
const blob = JSON.stringify(exported);

// --- the call is still observable ---
check('the listed call is STILL reported (not skipped)', bySecret.length > 0, `${bySecret.length} events`);
check('it still carries timing', end && typeof end.dur === 'number');
check('it still carries status', end && end.status === 'ok', String(end && end.status));

// --- but its values are gone, and its keys survive ---
check('the secret VALUE is absent', !blob.includes(SECRET));
check('the response became a content summary',
  end && end.response && typeof end.response === 'object' && 'byteLength' in end.response,
  JSON.stringify(end && end.response));
check('the KEYS survive in the shape', 
  end && end.response && end.response.shape && 'phrase' in end.response.shape
    && 'createdAt' in end.response.shape,
  JSON.stringify(end && end.response && end.response.shape));

// --- everything else is untouched ---
const roomEnd = byRoom.find((e) => e.type === 'request.end');
check('an UNLISTED method keeps its real values',
  roomEnd && roomEnd.response && roomEnd.response.title === 'General',
  JSON.stringify(roomEnd && roomEnd.response));

// --- CONTROL: without the list, the secret IS exported (so the test is not vacuous) ---
{
  const seen = [];
  const obs2 = observe({
    exporter: { export: (rows) => seen.push(...rows), close() {} },
    redact: false,
    intervalMs: 200,
  });
  const c2 = obs2.wrapClient(makeClient());
  await c2.core.getRecoveryPhrase();
  obs2.flusher.flushNow();
  check('CONTROL: unlisted, the secret IS exported', JSON.stringify(seen).includes(SECRET));
  obs2.stop();
}

obs.stop();
console.log(failures === 0 ? '\nAll redact-methods claims verified.' : `\n${failures} claim(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
