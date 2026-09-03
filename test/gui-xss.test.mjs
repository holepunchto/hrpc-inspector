// Guards the GUI against the XSS that actually happened: interpolating a numeric-by-convention
// wire field into innerHTML unescaped, because "it's a number".
//
// `${r.dur ?? ''}` and two siblings shipped dur/count raw. Those fields come from whatever reporter
// is connected and nothing validates their type, so dur:'<img src=x onerror=…>' executed script in
// the inspector page (CodeQL js/xss, reproduced with a PoC). That page holds the whole capture and
// can drive replay into the app.
//
// Static, not DOM-based: verification/ is dependency-free (no jsdom), and a bare `${r.dur}` is
// wrong regardless. Section 3 is the control — the scanner MUST flag the original line.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUI = resolve(HERE, '../gui/index.html');

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

console.log('gui-xss.test.mjs — no wire field reaches innerHTML unescaped\n');

// Fields that arrive over the wire from a reporter. Anything here is attacker-influenced as far as
// the GUI is concerned: an app can emit arbitrary values via obs.sink.emit, native/bridge.ts passes
// unknown fields through untouched, and any local process can connect to the GUI socket.
const WIRE_FIELDS = [
  'dur', 'count', 'seq', 'lag', 'args', 'response', 'error', 'method', 'src', 'corrId',
  'status', 'replayOf', 'className', 'item', 'thread', 'event', 'label', 'runtime', 'appId',
  'deviceId', 'busyPct', 'windowMs', 'maxLag', 'objProps', 'data', 'blame',
];

// Wrappers that make an interpolation safe. esc() escapes & < > " '; num() coerces or escapes;
// jsonTree/jsonScalar/fmt escape every key and value; statusPill escapes; time() can only ever
// yield digits, "Invalid Date" or "NaN"; encodeURIComponent and Math.* cannot yield markup.
const SAFE = ['esc(', 'num(', 'fmt(', 'jsonTree(', 'jsonScalar(', 'statusPill(', 'time(',
  'encodeURIComponent(', 'Math.', 'briefSnippet('];

const src = readFileSync(GUI, 'utf8');

// Reviewed individually and safe: each interpolates into an INTERMEDIATE string that is escaped at
// its point of use, or into something that is not a DOM sink at all. The reason matters more than
// the entry — and section 5 below asserts each justification still holds, so removing a downstream
// esc() breaks this suite instead of quietly widening the allowlist.
const REVIEWED_SAFE = new Map([
  ["s.windowMs ?? '?'",    'builds `title`, rendered as esc(title) in the threads strip'],
  ["s.maxLag ?? '?'",      'builds `title`, rendered as esc(title) in the threads strip'],
  ['ev.seq',               'builds childId, a Map key / corrId — not a DOM sink; seq renders via esc(String(r.seq))'],
  ["r.stall.lag ?? '?'",   'builds `respSize`, rendered as esc(respSize)'],
  ['r.count || 0',         'builds `respSize`, rendered as esc(respSize)'],
  ['r.method || r.corrId', 'passed to toast(), which assigns textContent — not innerHTML'],
]);

/** Find `${...}` interpolations mentioning a wire field but using no safe wrapper. */
function findUnsafe(text) {
  const out = [];
  const interp = /\$\{([^}]*)\}/g;
  let m;
  while ((m = interp.exec(text)) !== null) {
    const expr = m[1];
    const touchesWire = WIRE_FIELDS.some((f) => new RegExp(`\\b[a-zA-Z_$][\\w$]*\\.${f}\\b`).test(expr));
    if (!touchesWire) continue;
    if (SAFE.some((w) => expr.includes(w))) continue;
    // A comparison or a bare existence test renders nothing itself, e.g.
    // `${r.response === undefined ? '<pre>…</pre>' : jsonTree(...)}` — the branches are what matter,
    // and any interpolation inside them is matched separately by this same scan.
    const rendersOnlyLiterals = /^[^'"`]*\?[^'"`]*(['"`]).*\1[^'"`]*:[^'"`]*(['"`]).*\2[^'"`]*$/.test(expr);
    if (rendersOnlyLiterals) continue;
    const trimmed = expr.trim();
    if (REVIEWED_SAFE.has(trimmed)) continue;
    const line = text.slice(0, m.index).split('\n').length;
    out.push({ line, expr: trimmed.slice(0, 90) });
  }
  return out;
}

// --- 1. the live file must be clean ---
const unsafe = findUnsafe(src);
check('no wire field is interpolated without a safe wrapper', unsafe.length === 0,
  unsafe.map((u) => `line ${u.line}: \${${u.expr}}`).join(' | '));

// --- 2. the three sites that were exploited are explicitly guarded ---
check('table MS column uses num(r.dur)', src.includes('${num(r.dur)}'));
check('detail header uses num() for dur and count',
  src.includes("num(r.dur) + ' ms'") && src.includes("num(r.count) + ' msgs'"));
check('stream heading uses num(r.count)', /\$\{num\(r\.count\s*\?\?\s*0\)\}/.test(src));
// Unconditional: a typeof fast path leaves a String(v) path static analysis treats as tainted.
check('num() escapes unconditionally (no typeof/isFinite fast path)',
  /const num = \(v\) => \(v == null \? '' : esc\(String\(v\)\)\)/.test(src));
check('num() has no unsanitised String(v) branch',
  !/const num = [^;]*Number\.isFinite/.test(src) && !/const num = [^;]*\?\s*String\(v\)\s*:/.test(src));

// --- 3. CONTROL: the scanner must catch the ORIGINAL vulnerable code ---
// Without this, section 1 could be passing because the scan matches nothing at all.
const vulnerable = src.replace('${num(r.dur)}', "${r.dur ?? ''}");
const caught = findUnsafe(vulnerable);
check('CONTROL: scanner flags the original `${r.dur ?? \'\'}`',
  caught.some((u) => u.expr.includes('r.dur')),
  caught.length ? caught.map((u) => u.expr).join(' | ') : 'flagged nothing — the scan is vacuous');

// A second control with a blatant payload, in case the first is ever "fixed" into triviality.
const blatant = src.replace('${num(r.dur)}', '${r.count}');
check('CONTROL: scanner flags a bare `${r.count}`',
  findUnsafe(blatant).some((u) => u.expr === 'r.count'));

// --- 4. the escaper itself must cover the characters that matter ---
for (const ch of ['&', '<', '>', '"', "'"]) {
  check(`esc() handles ${ch}`, new RegExp(`'\\${ch}'\\s*:`).test(src) || src.includes(`[&<>"']`));
}

// --- 5. the allowlist is only valid while its justifications hold ---
check('threads `title` is still escaped at use (esc(title))', src.includes('title="${esc(title)}"'));
check('`respSize` is still escaped at use (esc(respSize))', src.includes('${esc(respSize)}'));
check('toast() still assigns textContent, not innerHTML',
  /function toast\([^)]*\)\s*\{[^}]*textContent\s*=\s*msg/s.test(src) && !/function toast\([^)]*\)\s*\{[^}]*innerHTML/s.test(src));
check('stream-item seq is still escaped at use', src.includes('esc(String(r.seq))'));

console.log(failures === 0 ? '\nAll gui-xss claims verified.' : `\n${failures} claim(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
