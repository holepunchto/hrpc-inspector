// Source identity: id derivation is INJECTIVE (tier-tagged + escaped — no collisions), and
// source fields are REDACTED on the export path. Both were protocol-architect "fix-before-ship"
// items; these lock them in.

import { observe } from '../src/observe.ts';
import { StreamFramer } from 'hrpc-inspector-probe/transport/framing';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

console.log('source.test.mjs — source identity derivation + redaction\n');

const idOf = (source) => { const o = observe({ redact: false, autoSwarm: false, source }); const id = o.source.id; o.stop(); return id; };

// --- (1) id derivation: tier-tagged, escaped, injective ---
check('deviceId+appId → d=<dev>;a=<app>', idOf({ deviceId: 'd1', appId: 'a1' }) === 'd=d1;a=a1', idOf({ deviceId: 'd1', appId: 'a1' }));
check('deviceId only → d=<dev>', idOf({ deviceId: 'd1' }) === 'd=d1');
check('appId only → a=<app>', idOf({ appId: 'a1' }) === 'a=a1');
// CONTROL: cross-tier values that DID collide before the fix must now be distinct.
check('CONTROL: deviceId "x" and appId "x" do NOT collide', idOf({ deviceId: 'x' }) !== idOf({ appId: 'x' }), `${idOf({ deviceId: 'x' })} vs ${idOf({ appId: 'x' })}`);
// CONTROL: a value containing the separator can't forge another source (escaping).
check('CONTROL: separator in a value is escaped (no forge)', idOf({ deviceId: 'a:b', appId: 'c' }) !== idOf({ deviceId: 'a', appId: 'b:c' }),
  `${idOf({ deviceId: 'a:b', appId: 'c' })} vs ${idOf({ deviceId: 'a', appId: 'b:c' })}`);
check('empty-string id is ignored (falls through to derivation)', idOf({ id: '', deviceId: 'd1' }) === 'd=d1', idOf({ id: '', deviceId: 'd1' }));
check('explicit non-empty id wins', idOf({ id: 'EXPLICIT', deviceId: 'd1' }) === 'EXPLICIT');

// --- (2) source redaction on the export path ---
const collect = () => {
  let wire = new Uint8Array(0);
  return {
    stream: { write(b) { const n = new Uint8Array(wire.length + b.length); n.set(wire); n.set(b, wire.length); wire = n; return true; } },
    text() { return new TextDecoder().decode(wire); },
    first() { let out = []; new StreamFramer((m) => out.push(JSON.parse(new TextDecoder().decode(m)))).push(wire); return out[0]; },
  };
};
const sensitiveSource = { deviceId: 'device-uuid-123', appId: 'com.keet.app', label: "Ari's iPhone", secretExtra: 'leak-me' };

// redact ON (export path default for stream mode)
const on = collect();
const oOn = observe({ stream: on.stream, redact: true, autoSwarm: false, source: sensitiveSource });
oOn.sink.emit({ type: 'request.start', corrId: 'c1', method: 'm', t: 0 });
oOn.flusher.flushNow(); oOn.stop();
const evOn = on.first();
check('redact ON: event src is HASHED (ph_…), not the raw id', typeof evOn.src === 'string' && evOn.src.startsWith('ph_') && evOn.src !== oOn.source.id, evOn.src);
check('redact ON: no raw device id / human label / extra field on the wire',
  !on.text().includes('device-uuid-123') && !on.text().includes("Ari's iPhone") && !on.text().includes('leak-me'));
check('redact ON: handle.source keeps the ORIGINAL for the app', oOn.source.label === "Ari's iPhone");

// CONTROL: redact OFF (local WS viewer) → raw id reaches the wire (proves redaction is load-bearing)
const off = collect();
const oOff = observe({ stream: off.stream, redact: false, autoSwarm: false, source: sensitiveSource });
oOff.sink.emit({ type: 'request.start', corrId: 'c2', method: 'm', t: 0 });
oOff.flusher.flushNow(); oOff.stop();
check('CONTROL: redact OFF → raw device id present on the wire', off.text().includes('device-uuid-123'), off.first().src);

console.log(failures === 0 ? '\nAll source claims verified.' : `\n${failures} claim(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
