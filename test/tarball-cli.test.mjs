// Proves the PUBLISHED artifact works — not the worktree.
//
// bin/hrpc-inspector.mjs imports ../src/init.mjs at the top level, so dropping src/ from `files`
// shipped a tarball where both CLI verbs died with ERR_MODULE_NOT_FOUND — invisible to every other
// suite, which all run against the worktree where src/ exists. So: pack for real, unpack, run it.
//
// SKIPs when npm is absent (keeps the suite dependency-free). --ignore-scripts, so this checks
// REACHABILITY of what ships, not bundle contents.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); fail++; }
};
const skip = (why) => { console.log(`  SKIP: ${why}`); process.exit(0); };

console.log('tarball-cli.test.mjs — the PUBLISHED artifact, not the worktree\n');

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

try { run('npm', ['--version']); } catch { skip('npm not available (packaging check needs it)'); }

let dir;
try {
  dir = mkdtempSync(join(tmpdir(), 'bni-tarball-'));

  // 1. pack exactly what `npm publish` would ship
  let packed;
  try {
    packed = run('npm', ['pack', PKG, '--ignore-scripts'], { cwd: dir }).trim().split('\n').pop();
  } catch (err) {
    check('npm pack succeeds', false, String(err.stderr || err.message).slice(0, 200));
    throw err;
  }
  check('npm pack produced a tarball', !!packed && packed.endsWith('.tgz'), packed);

  run('tar', ['xzf', packed], { cwd: dir });
  const root = join(dir, 'package');
  const cli = join(root, 'bin', 'hrpc-inspector.mjs');

  // 2. the CLI must RESOLVE from the tarball — this is the assertion that was missing
  let usage = '';
  let resolved = true;
  try {
    usage = run(process.execPath, [cli], { cwd: dir });
  } catch (err) {
    // the CLI exits 1 on no-args; only a module-resolution failure is a real failure here
    usage = String(err.stdout || '') + String(err.stderr || '');
    if (/ERR_MODULE_NOT_FOUND|Cannot find module/.test(usage)) resolved = false;
  }
  check('CLI resolves its imports from the tarball', resolved,
    resolved ? '' : usage.split('\n').find((l) => /ERR_MODULE_NOT_FOUND|Cannot find/.test(l)) || '');
  check('CLI prints its usage line', /Usage: hrpc-inspector/.test(usage), usage.slice(0, 120));

  // 3. `init` is the command that needs src/init.mjs — run it for real (dry run writes nothing)
  let init = '';
  let initOk = true;
  try {
    init = run(process.execPath, [cli, 'init'], { cwd: dir });
  } catch (err) {
    init = String(err.stdout || '') + String(err.stderr || '');
    initOk = false;
  }
  check('`init` runs from the tarball (dry run)', initOk && /detected runtime:/.test(init),
    init.split('\n')[0] || '');
  check('`init` is a dry run by default (says so, writes nothing)',
    /dry run/i.test(init) && !readdirSync(dir).some((f) => f.includes('worklet')), init.slice(0, 120));

  // 4. the bin entry must survive npm's manifest normalisation. npm 11 REMOVES a bin whose path
  //    starts with "./" ('"bin[x]" script name … was invalid and removed'), which silently ships a
  //    package with no CLI at all. Assert on the packed manifest, not on ours.
  const manifest = JSON.parse(run('node', ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(root, 'package.json'))},'utf8'))`]));
  check('packed manifest still declares the bin', !!(manifest.bin && manifest.bin['hrpc-inspector']),
    JSON.stringify(manifest.bin));
  check('bin path has no leading "./" (npm strips such entries)',
    !!manifest.bin && !String(manifest.bin['hrpc-inspector'] || '').startsWith('./'),
    JSON.stringify(manifest.bin));

  // 5. CONTROL — the check must be able to fail. Prove it by pointing the same resolution logic at
  //    a file the tarball does NOT contain: if this "succeeded", the test above would be vacuous.
  let controlFailed = false;
  try {
    run(process.execPath, [join(root, 'src', 'observe.ts')], { cwd: dir });
  } catch {
    controlFailed = true;
  }
  check('CONTROL: a file excluded from the tarball is genuinely absent', controlFailed,
    'src/observe.ts should not be in the tarball');

  // 6. license text must actually ship, not just the SPDX id in the manifest
  check('LICENSE ships in the tarball', readdirSync(root).includes('LICENSE'));
} finally {
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
