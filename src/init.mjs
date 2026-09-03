// Pure planner for `hrpc-inspector init`. Given a host project's package.json (and a
// file-existence probe), it decides the project type and returns a PLAN of actions.
// Pure + injectable so it is unit-tested without touching a real filesystem.
//
// Design choice (deliberate): there is NO postinstall that silently edits a host's
// metro/babel/pear config. Auto-mutating build config on install is fragile and a
// supply-chain-trust smell. `init` is one explicit command, and it DEFAULTS TO A
// DRY RUN — nothing is written without `--write`.

/** @typedef {{ path: string, kind: 'create', reason: string, contents: string }} PlanAction */

const WORKLET_SCAFFOLD = `// hrpc-inspector.worklet.mjs — runs INSIDE a react-native-bare-kit Worklet (Bare runtime).
// The observability core (probe + collector + hyperswarm export) lives here, NOT on the
// RN JS thread. The RN side pipes its transport handles in over the worklet IPC.
//
// UNVERIFIED on-device: needs react-native-bare-kit + a device/simulator to run
// (no React Native toolchain in this environment). Verify the bare-kit Worklet API against
// current Holepunch docs before shipping.
import { observe } from 'hrpc-inspector';

// Replay (the GUI re-running a call the app already made) is OPT-IN and off by default: pass
// allowInvoke: true ONLY in a dev build, and only with a 'websocket:' viewer. Leaving it out is
// what keeps a shipped release from exposing an inbound execution surface.
const obs = observe(); // detects Bare → auto-dials the hub topic over Hyperswarm
// Receive transport events from the RN side over IPC and feed obs.sink, e.g.:
//   BareKit.IPC.on('data', (buf) => obs.sink.emit(JSON.parse(buf.toString())));
// or instrument a transport opened inside the worklet directly.
`;

const RN_SNIPPET = `// RN JS side — start the worklet (react-native-bare-kit):
//   import { Worklet } from 'react-native-bare-kit';
//   import source from './hrpc-inspector.worklet.mjs';   // bundled by bare-kit
//   const worklet = new Worklet();
//   worklet.start('/hrpc-inspector.worklet.mjs', source);
//   // pipe your transport's events to worklet.IPC`;

const DESKTOP_SNIPPET = `// Desktop (Electron main / Node) — the core runs in-process:
//   import { observe, instrumentHyperswarmStream } from 'hrpc-inspector';
//   const obs = observe({
//     websocket: 'ws://127.0.0.1:9420/ws', // stream to the local GUI (npx hrpc-inspector gui)
//     allowInvoke: true,                   // REPLAY IS OPT-IN. Dev builds only — it lets the GUI
//   });                                    // re-run a call the app already made. Never ship it.
//   instrumentHyperswarmStream(conn, obs.sink, { });
//   // Omit 'websocket' instead and, under Bare/Pear, observe() auto-dials the Hyperswarm hub.`;

const PEAR_SNIPPET = `// Pear / Bare app — nothing to configure; observe() auto-dials the hub:
//   import { observe } from 'hrpc-inspector';
//   const obs = observe();                 // detects Pear/Bare → joins hub topic`;

/**
 * @param {{ pkg?: any, hasFile?: (p: string) => boolean }} input
 * @returns {{ runtime: string, actions: PlanAction[], notes: string[] }}
 */
export function planInit({ pkg = {}, hasFile = () => false } = {}) {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const has = (name) => Object.prototype.hasOwnProperty.call(deps, name);

  let runtime;
  if (has('react-native') || has('expo')) runtime = 'react-native';
  else if (pkg.pear || has('pear') || has('bare') || has('hyperswarm')) runtime = 'pear';
  else if (has('electron')) runtime = 'electron';
  else runtime = 'node';

  /** @type {PlanAction[]} */
  const actions = [];
  const notes = [];

  if (runtime === 'react-native') {
    if (!hasFile('hrpc-inspector.worklet.mjs')) {
      actions.push({
        path: 'hrpc-inspector.worklet.mjs',
        kind: 'create',
        reason: 'Bare worklet that runs the observability core inside react-native-bare-kit',
        contents: WORKLET_SCAFFOLD,
      });
    }
    notes.push('Install peers: npm i react-native-bare-kit hyperswarm hypercore-crypto');
    notes.push(RN_SNIPPET);
  } else if (runtime === 'pear') {
    notes.push('No files needed — observe() auto-dials the hub under Pear/Bare.');
    notes.push('Ensure hyperswarm + hypercore-crypto are dependencies.');
    notes.push(PEAR_SNIPPET);
  } else {
    notes.push('Desktop/Node: observe() runs in-process. Under Node (not Bare), attach() a hub stream.');
    notes.push(DESKTOP_SNIPPET);
  }

  return { runtime, actions, notes };
}
