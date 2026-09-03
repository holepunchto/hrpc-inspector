// Runtime detection — the basis of "plug and play". The SAME observability core
// runs in every target; only the host that hosts it differs:
//
//   plain Pear app      → Bare runtime (Pear global present)
//   plain Bare app      → Bare runtime
//   React Native app    → a react-native-bare-kit WORKLET, which is Bare again
//   Electron / Node CLI → Node
//   browser / RN JS side → no Bare; export over a bridge instead
//
// Because RN runs the core inside a Bare worklet, `detectRuntime()` called from
// INSIDE that worklet returns 'bare' — which is exactly right: the hyperswarm
// auto-swarm path applies there just as it does for a plain Pear app.

export type Runtime = 'pear' | 'bare' | 'react-native' | 'electron' | 'node' | 'browser' | 'unknown';

export interface RuntimeInfo {
  runtime: Runtime;
  /** Bare is available (Pear, plain Bare, or an RN bare-kit worklet) → hyperswarm can run in-process. */
  isBareRuntime: boolean;
  /** A browser/RN JS context where we must export over a bridge, not a socket. */
  isBridgeOnly: boolean;
}

/** Pure and injectable (pass a fake global in tests). Order matters: most specific first. */
export function detectRuntime(env: any = globalThis): RuntimeInfo {
  const has = (v: unknown) => typeof v !== 'undefined' && v !== null;

  // Pear implies Bare, but is more specific — report it distinctly.
  if (has(env.Pear)) return { runtime: 'pear', isBareRuntime: true, isBridgeOnly: false };
  if (has(env.Bare)) return { runtime: 'bare', isBareRuntime: true, isBridgeOnly: false };

  // React Native JS side (Hermes/JSC). Not Bare — the core belongs in a worklet.
  const rn =
    env.navigator?.product === 'ReactNative' ||
    has(env.__fbBatchedBridge) ||
    has(env.HermesInternal);
  if (rn) return { runtime: 'react-native', isBareRuntime: false, isBridgeOnly: true };

  if (has(env.process?.versions?.electron)) {
    return { runtime: 'electron', isBareRuntime: false, isBridgeOnly: false };
  }
  if (has(env.process?.versions?.node)) {
    return { runtime: 'node', isBareRuntime: false, isBridgeOnly: false };
  }
  if (has(env.window) && has(env.document)) {
    return { runtime: 'browser', isBareRuntime: false, isBridgeOnly: true };
  }
  return { runtime: 'unknown', isBareRuntime: false, isBridgeOnly: false };
}
