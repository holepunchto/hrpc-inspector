// testnet-capture.test.mjs — PHASE 1: deterministic multi-peer capture (integration test).
//
// Proves: two INDEPENDENT bare-observe instances (one per peer), each tapping its own RPC boundary,
// both capture their end of an exchange that crosses a REAL Hyperswarm connection — with distinct
// source ids. Control: un-tapped services capture nothing (the tap is what produces events).
//
// This is an INTEGRATION test (real udx/UDP peer transport), not a unit test. It is OPTIONAL and
// self-skipping, so `run-all.sh` stays green on a bare checkout and in environments without a
// working udx peer transport:
//   • SKIP if @hyperswarm/testnet / hyperswarm / hypercore-crypto aren't installed
//       (to run it:  npm i -D @hyperswarm/testnet hyperswarm hypercore-crypto)
//   • SKIP if two peers cannot establish a connection within the timeout — UNLESS
//       TESTNET_MUST_CONNECT=1 (set it in real CI on a udx host, so a failed connection FAILs
//       loudly instead of silently skipping; a bare checkout / this sandbox leaves it unset).
//       (this sandbox: the testnet DHT forms, but udx peer connections do not complete —
//        verified swarm↔swarm 20s and direct HyperDHT 15s timeouts, sandbox on and off.
//        UNVERIFIABLE HERE; run on a dev machine / CI with working udx.)
//
// The connected-path assertions are therefore UNVERIFIED in this sandbox; the setup + skip + teardown
// paths ARE verified here (the test exits cleanly with SKIP).

import { observe } from '../src/observe.ts';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};
const skip = (why) => { console.log(`  SKIP: ${why}`); process.exit(0); };

console.log('testnet-capture.test.mjs — multi-peer capture over a real Hyperswarm hop\n');

// Optional deps — skip cleanly if absent (same pattern as cbor-selfcheck).
let createTestnet, Hyperswarm, crypto;
try {
  createTestnet = (await import('@hyperswarm/testnet')).default;
  Hyperswarm = (await import('hyperswarm')).default;
  crypto = (await import('hypercore-crypto')).default;
} catch {
  skip('@hyperswarm/testnet / hyperswarm / hypercore-crypto not installed (npm i -D them to run this)');
}

// CI on a udx-capable host sets TESTNET_MUST_CONNECT=1 → a connection failure is a hard FAIL, not a
// silent SKIP, so a broken transport (or a masked capture regression) can't hide behind the skip.
// Unset (bare checkouts, this sandbox) → SKIP is allowed, with a shorter timeout so run-all stays fast.
const MUST_CONNECT = process.env.TESTNET_MUST_CONNECT === '1';
const CONNECT_TIMEOUT_MS = MUST_CONNECT ? 15000 : 4000;
const testnet = await createTestnet(3);
const topic = crypto.discoveryKey(crypto.randomBytes(32));
const a = new Hyperswarm({ bootstrap: testnet.bootstrap });
const b = new Hyperswarm({ bootstrap: testnet.bootstrap });

// A bare-observe instance per peer, each with a distinct source; collect events locally (custom
// exporter, redaction OFF so we can assert on the raw src id) instead of shipping to a GUI.
const evA = [], evB = [];
const obsA = observe({ exporter: { export: (batch) => evA.push(...batch) }, redact: false, source: { deviceId: 'peerA', appId: 'demo' } });
const obsB = observe({ exporter: { export: (batch) => evB.push(...batch) }, redact: false, source: { deviceId: 'peerB', appId: 'demo' } });

// Each peer's "service" is tapped. The real Hyperswarm connection triggers a call on each side.
const svcA = obsA.wrapClient({ net: { send: async (msg) => ({ sent: msg }) } });
const svcB = obsB.wrapClient({ net: { recv: async (msg) => ({ handled: msg }) } });
// Control: an identical service that is NOT tapped must produce no events.
const ctlEv = [];
let ctlRuns = 0;
const obsC = observe({ exporter: { export: (batch) => ctlEv.push(...batch) }, redact: false, source: { deviceId: 'ctl', appId: 'demo' } });
const svcCtlRaw = { net: { recv: async (m) => { ctlRuns++; return { handled: m }; } } }; // never passed to wrapClient

const teardown = async () => {
  obsA.stop(); obsB.stop(); obsC.stop();
  try { await a.destroy(); } catch {}
  try { await b.destroy(); } catch {}
  try { await testnet.destroy(); } catch {}
};

let connected = false;
a.on('connection', (conn) => {
  conn.on('error', () => {});
  connected = true;
  svcA.net.send('hello-from-A');           // A makes a tapped call, then sends over the real hop
  try { conn.write(Buffer.from('hello-from-A')); } catch {}
});
b.on('connection', (conn) => {
  conn.on('error', () => {});
  connected = true;
  conn.on('data', (d) => { svcB.net.recv(d.toString()); svcCtlRaw.net.recv(d.toString()); }); // B handles it (tapped) + control (untapped)
});

a.join(topic); b.join(topic);
await a.flush(); await b.flush();

// Wait for a connection, or SKIP if this environment can't establish one.
await new Promise((res) => {
  const started = Date.now();
  const i = setInterval(() => {
    if (connected) { clearInterval(i); res(); }
    else if (Date.now() - started > CONNECT_TIMEOUT_MS) { clearInterval(i); res(); }
  }, 100);
});

if (!connected) {
  await teardown();
  if (MUST_CONNECT) { // a host that is SUPPOSED to connect but didn't → loud failure, never a silent skip
    check(`connection established within ${CONNECT_TIMEOUT_MS}ms (TESTNET_MUST_CONNECT=1)`, false, 'no udx peer connection — transport broken on a must-connect host');
    console.log(`\n${failures} claim(s) FAILED.`);
    process.exit(1);
  }
  skip(`no udx peer connection within ${CONNECT_TIMEOUT_MS}ms — this environment can't establish a Hyperswarm hop (run where udx works; set TESTNET_MUST_CONNECT=1 to make this a hard failure in CI)`);
}

// Connected: let B's data handler + both flushers run, then assert capture on BOTH ends.
await new Promise((r) => setTimeout(r, 400));
obsA.flusher.flushNow(); obsB.flusher.flushNow(); obsC.flusher.flushNow();

const aSent = evA.find((e) => e.type === 'request.start' && e.method === 'net.send');
const bRecv = evB.find((e) => e.type === 'request.start' && e.method === 'net.recv');
check('peer A captured its own call (net.send) with src=peerA', !!aSent && String(aSent.src).includes('peerA'));
check('peer B captured its own call (net.recv) with src=peerB across the real hop', !!bRecv && String(bRecv.src).includes('peerB'));
check('CONTROL: un-tapped service RAN but produced zero events (0 = tap off, not control-never-ran)', ctlRuns > 0 && ctlEv.length === 0, `ctlRuns=${ctlRuns}`);

await teardown();
console.log(failures === 0 ? '\nAll testnet-capture claims verified.' : `\n${failures} claim(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
