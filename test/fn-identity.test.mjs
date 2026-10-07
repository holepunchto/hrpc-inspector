// Proves the tap preserves each method's identity.
//
// The regression: the wrapper was `function observed(...)`, so every wrapped method reported
// `name === 'observed'`. keet's System Log builds its entries with `method: apiFn.name`, so the
// whole log read "observed" instead of the endpoint — the tap destroyed the app's own debugging.
// `length` is preserved for the same reason: arity is the other thing reflection reads.

import { wrapClient } from '../src/wrap-client.ts';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

console.log('fn-identity.test.mjs — wrapping must not rename a method\n');

const makeClient = () => ({
  core: {
    subscribeRoomInfo (roomId, opts) { return { roomId, opts }; },
    getRecentRooms () { return []; },
  },
  ping (a, b, c) { return [a, b, c]; },
});

const before = makeClient();
const names = {
  subscribeRoomInfo: before.core.subscribeRoomInfo.name,
  getRecentRooms: before.core.getRecentRooms.name,
  ping: before.ping.name,
};
const arity = { subscribeRoomInfo: before.core.subscribeRoomInfo.length, ping: before.ping.length };

const client = makeClient();
wrapClient(client, () => {});

check('a namespaced method keeps its name',
  client.core.subscribeRoomInfo.name === names.subscribeRoomInfo,
  `${client.core.subscribeRoomInfo.name} (expected ${names.subscribeRoomInfo})`);
check('a second namespaced method keeps its name',
  client.core.getRecentRooms.name === names.getRecentRooms, client.core.getRecentRooms.name);
check('a top-level function keeps its name', client.ping.name === names.ping, client.ping.name);

check('arity is preserved (namespaced)',
  client.core.subscribeRoomInfo.length === arity.subscribeRoomInfo,
  `${client.core.subscribeRoomInfo.length} (expected ${arity.subscribeRoomInfo})`);
check('arity is preserved (top-level)', client.ping.length === arity.ping,
  `${client.ping.length} (expected ${arity.ping})`);

check('no wrapped method is named "observed"',
  client.core.subscribeRoomInfo.name !== 'observed' && client.ping.name !== 'observed');

// the exact expression keet's System Log uses
check('keet\'s `method: apiFn.name` yields the endpoint',
  client.core.subscribeRoomInfo.name === 'subscribeRoomInfo', client.core.subscribeRoomInfo.name);

// the tap must still work
{
  const events = [];
  const c = makeClient();
  wrapClient(c, (e) => events.push(e));
  c.core.getRecentRooms();
  check('CONTROL: the method is still observed under its endpoint',
    events.some((e) => e.method === 'core.getRecentRooms'),
    [...new Set(events.map((e) => e.method))].join(', '));
  check('CONTROL: the call still returns correctly',
    JSON.stringify(c.core.subscribeRoomInfo('r1', { a: 1 })) === JSON.stringify({ roomId: 'r1', opts: { a: 1 } }));
}

console.log(failures === 0 ? '\nAll fn-identity claims verified.' : `\n${failures} claim(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
