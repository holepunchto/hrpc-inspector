// hrpc-inspector — the plug-and-play umbrella. Proves runtime detection, observe()
// wiring, the buffering->attach handoff, and the init planner. On-device RN /
// live two-peer swarm are UNVERIFIABLE HERE (C14/G4/C15) and not asserted.

import { detectRuntime } from '../src/detect.ts';
import { observe } from '../src/observe.ts';
import { planInit } from '../src/init.mjs';
import { StreamFramer } from 'hrpc-inspector-probe/transport/framing';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

console.log('observe.test.mjs — hrpc-inspector plug-and-play\n');

// --- (1) runtime detection across every target (injected fake globals) ---
const det = (env) => detectRuntime(env).runtime;
check('detect: Pear app -> pear (Bare)', det({ Pear: {}, Bare: {} }) === 'pear' && detectRuntime({ Pear: {} }).isBareRuntime);
check('detect: plain Bare -> bare (Bare)', det({ Bare: {} }) === 'bare' && detectRuntime({ Bare: {} }).isBareRuntime);
check('detect: React Native JS side -> react-native (bridge-only)',
  det({ navigator: { product: 'ReactNative' } }) === 'react-native' &&
  detectRuntime({ navigator: { product: 'ReactNative' } }).isBridgeOnly);
check('detect: Electron -> electron', det({ process: { versions: { node: '22', electron: '30' } } }) === 'electron');
check('detect: Node -> node', det({ process: { versions: { node: '22' } } }) === 'node');
check('detect: browser -> browser', det({ window: {}, document: {} }) === 'browser');
check('detect: empty env -> unknown (safe default)', det({}) === 'unknown');

// --- (2) observe({stream}) wires sink->flusher->exporter; frames decode on the hub side ---
const collect = () => {
  let wire = new Uint8Array(0);
  return {
    stream: { write(b) { const n = new Uint8Array(wire.length + b.length); n.set(wire); n.set(b, wire.length); wire = n; return true; } },
    decode() { const out = []; const f = new StreamFramer((m) => out.push(JSON.parse(new TextDecoder().decode(m)))); f.push(wire); return out; },
  };
};
const c1 = collect();
// redact:false → pure wiring/framing test with verbatim events (redaction fidelity is
// covered by observe-redaction.test.mjs; here we only prove the stream path is intact).
const obs1 = observe({ stream: c1.stream, autoSwarm: false, redact: false });
check('observe({stream}) -> mode "stream"', obs1.mode === 'stream', obs1.mode);
const evs = [
  { type: 'request.start', corrId: 'x1', method: 'blocks.fetch', peerId: 'pA', t: 0 },
  { type: 'request.end', corrId: 'x1', peerId: 'pA', t: 30 },
];
for (const e of evs) obs1.sink.emit(e);
obs1.flusher.flushNow();       // force a batch without waiting on the timer
obs1.stop();
const stripSrc = (e) => { const { src, ...rest } = e; return rest; };
const dec1 = c1.decode();
check('observe({stream}): every event carries a src stamp (device selector)', dec1.length === 2 && dec1.every((e) => typeof e.src === 'string'), JSON.stringify(dec1.map((e) => e.src)));
check('observe({stream}): hub decodes the emitted events (ignoring src stamp)', JSON.stringify(dec1.map(stripSrc)) === JSON.stringify(evs), `${dec1.length}/2`);

// --- (3) buffering mode (Node, no stream): events queue, then attach() drains them ---
const c2 = collect();
const obs2 = observe({ autoSwarm: false, redact: false }); // Node -> buffering; verbatim for the wiring check
check('observe() with no target -> mode "buffering"', obs2.mode === 'buffering', obs2.mode);
obs2.sink.emit(evs[0]);
obs2.flusher.flushNow();
check('buffering CONTROL: nothing written before attach()', c2.decode().length === 0, `${c2.decode().length}`);
obs2.attach(c2.stream);        // hub connects later -> buffered batches drain
obs2.stop();
check('attach() drains the buffered batch to the hub (ignoring src stamp)', JSON.stringify(c2.decode().map(stripSrc)) === JSON.stringify([evs[0]]), `${c2.decode().length}/1`);

// --- (4) init planner: right plan per project type, and it writes nothing (pure) ---
const rn = planInit({ pkg: { dependencies: { 'react-native': '0.76.0' } } });
// Freeze a snapshot NOW so the purity control below compares against an immutable string,
// not the live `rn` object (a shared-reference side effect would otherwise pass vacuously —
// Wave-B/C22 gate finding).
const rnSnap = JSON.stringify(rn);
check('init: react-native project -> rn runtime + worklet scaffold action',
  rn.runtime === 'react-native' && rn.actions.some((a) => a.path === 'hrpc-inspector.worklet.mjs'));
const pear = planInit({ pkg: { pear: { type: 'terminal' }, dependencies: { hyperswarm: '^4' } } });
check('init: pear project -> pear runtime, no file actions (auto-swarm)', pear.runtime === 'pear' && pear.actions.length === 0);
const node = planInit({ pkg: { dependencies: {} } });
check('init: plain project -> node runtime', node.runtime === 'node');
// CONTROL: planner is pure — a fresh call equals the FROZEN snapshot (catches value
// divergence AND reference-aliased side effects, unlike comparing against the live object).
check('init CONTROL: planner is pure (repeatable, no writes)',
  JSON.stringify(planInit({ pkg: { dependencies: { 'react-native': '0.76.0' } } })) === rnSnap);

console.log(failures === 0 ? '\nAll hrpc-inspector claims verified.' : `\n${failures} claim(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
