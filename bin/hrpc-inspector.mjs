#!/usr/bin/env node
// bare-observe CLI. One command, dry-run by default.
//
//   npx hrpc-inspector init            # detect project + PREVIEW the plan (writes nothing)
//   npx hrpc-inspector init --write    # apply the plan (never overwrites existing files)
//   npx hrpc-inspector gui [--port N]  # launch the inspector GUI (http://localhost:9420)
//
// Deliberately NOT a postinstall — see src/init.mjs for why.

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { planInit } from '../src/init.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const write = args.includes('--write');
const cwd = process.cwd();

function loadPkg() {
  const p = resolve(cwd, 'package.json');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function runInit() {
  const pkg = loadPkg();
  const { runtime, actions, notes } = planInit({
    pkg,
    hasFile: (rel) => existsSync(resolve(cwd, rel)),
  });

  console.log(`hrpc-inspector init — detected runtime: ${runtime}`);
  console.log(write ? '(writing changes)\n' : '(dry run — pass --write to apply)\n');

  for (const a of actions) {
    if (write) {
      const target = resolve(cwd, a.path);
      if (existsSync(target)) {
        console.log(`  skip   ${a.path} (exists, not overwriting)`);
      } else {
        writeFileSync(target, a.contents);
        console.log(`  create ${a.path} — ${a.reason}`);
      }
    } else {
      console.log(`  would create ${a.path} — ${a.reason}`);
    }
  }
  if (actions.length === 0) console.log('  (no files needed for this runtime)');

  if (notes.length) {
    console.log('\nNext:');
    for (const n of notes) console.log(n.includes('\n') || n.startsWith('//') ? `\n${n}` : `  - ${n}`);
  }
}

if (cmd === 'init') {
  runInit();
} else if (cmd === 'gui') {
  const i = args.indexOf('--port');
  const port = i >= 0 ? Number(args[i + 1]) : Number(process.env.OBSERVE_PORT || 9420);
  const hostIdx = args.indexOf('--host');
  const { startGui } = await import('../gui/server.mjs');
  startGui({
    port,
    demo: args.includes('--demo'),
    ...(hostIdx >= 0 ? { host: args[hostIdx + 1] } : {}),
    // Escape hatch for a runtime whose WebSocket really does send `Origin: null`. Off by default:
    // 'null' is a BROWSER value (a sandboxed or redirected page), so allowing it lets any page the
    // developer visits read the capture and drive replay.
    allowNullOrigin: args.includes('--allow-null-origin'),
  });
} else {
  console.log('Usage: hrpc-inspector <init [--write] | gui [--port N] [--host H] [--demo] [--allow-null-origin]>');
  process.exit(cmd ? 1 : 0);
}
