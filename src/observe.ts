// observe() — the zero-config entry point. One call wires:
//
//   your adapter → obs.sink → BatchFlusher(100-250ms) → exporter → hub
//
// and auto-selects the exporter for the detected runtime:
//   • explicit stream given            → write frames to it
//   • Bare/Pear (or RN bare-kit worklet) → auto-dial the hub topic over Hyperswarm,
//     buffering events until a peer (the hub) connects
//   • anything else                     → buffer safely and let the caller attach()
//
// The core is transport- and host-agnostic; this file is the only place that knows
// how to reach a hub in each environment.

import { BatchFlusher } from 'hrpc-inspector-probe/flush';
import { createHyperswarmExporter } from 'hrpc-inspector-probe/exporters/hyperswarm';
import type { WritableStreamLike, HyperswarmExporter } from 'hrpc-inspector-probe/exporters/hyperswarm';
import { Redactor } from 'hrpc-inspector-probe/redactor';
import type { EventSink, L2Event } from 'hrpc-inspector-probe/sink';
import { detectRuntime } from './detect.ts';
import type { Runtime } from './detect.ts';
import { createWebSocketReporter } from './reporters.ts';
import type { Reporter } from './reporters.ts';
import { wrapClient, setInvokeContext } from './wrap-client.ts';
import type { Report, WrapClientOptions } from './wrap-client.ts';

// NOTE: there is deliberately NO ambient "am I in dev?" signal here. The replay/invoke capability
// used to default to a sniffed dev flag, which returned true whenever neither globalThis.__DEV__ nor
// globalThis.process?.env existed — i.e. in a production browser bundle and in every Bare/Pear build
// (`bare -e 'typeof process'` → undefined). A shipped app therefore installed the inbound invoke
// handler. The capability now fails CLOSED: it requires an explicit `allowInvoke: true`.

export const DEFAULT_TOPIC = 'p2p-observability-hub:v0';

export interface SourceInfo {
  /** Stable id used to group/select this source in the GUI. */
  id: string;
  /** Human label shown in the selector. */
  label: string;
  /** Detected runtime (react-native | pear | bare | electron | node | browser). */
  runtime: string;
  /** Physical device id (client-supplied; e.g. an app's own options.deviceId). Lets the GUI select by device. */
  deviceId?: string;
  /** App / install instance id — distinguishes MULTIPLE apps sharing one package. */
  appId?: string;
  [extra: string]: unknown;
}

// Reuse the runtime's local storage for a STABLE id (survives restart, clears on delete-data).
// Only the browser has a synchronous, universal store (localStorage); RN/Bare/Node clients pass
// their own persistent deviceId (they own AsyncStorage / a file / a platform id).
function persistentId(runtime: string): string {
  try {
    const ls = (globalThis as any).localStorage;
    if (runtime === 'browser' && ls) {
      const KEY = 'hrpc-inspector:deviceId';
      let v = ls.getItem(KEY);
      if (!v) { v = Math.random().toString(36).slice(2, 10); ls.setItem(KEY, v); }
      return v;
    }
  } catch {
    /* storage blocked (private mode etc.) — fall through to a session id */
  }
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Auto-fill a source identity; the client overrides any field. The unique `id` is TIER-TAGGED
 * and component-ESCAPED so it is injective — a device id and an app id can never collide, and a
 * value containing the separator can't forge another source (protocol-architect review):
 *   explicit id → `d=<dev>;a=<app>` → `d=<dev>` → `a=<app>` → `r=<runtime>-<persistentOrSession>`.
 */
function resolveSource(s: string | Record<string, unknown> | undefined, runtime: string): SourceInfo {
  if (typeof s === 'string' && s) return { id: s, label: s, runtime };
  const p = (s ?? {}) as Record<string, unknown>;
  const deviceId = (p.deviceId as string | undefined) || undefined;
  const appId = ((p.appId as string | undefined) ?? (p.app as string | undefined)) || undefined;
  const enc = (v: string) => encodeURIComponent(v);
  const explicitId = typeof p.id === 'string' && p.id ? p.id : undefined; // ignore empty-string id
  const id =
    explicitId ??
    (deviceId && appId ? `d=${enc(deviceId)};a=${enc(appId)}`
      : deviceId ? `d=${enc(deviceId)}`
        : appId ? `a=${enc(appId)}`
          : `r=${runtime}-${persistentId(runtime)}`);
  const parts = [appId, (p.device as string) ?? deviceId, p.variant].filter(Boolean);
  const label = (typeof p.label === 'string' && p.label ? p.label : undefined) ?? (parts.length ? parts.join(' · ') : id);
  return { ...p, id, label, runtime, deviceId, appId } as SourceInfo;
}

/**
 * Redact a source for the EXPORT path (hub / .p2plog leave the device). Client-chosen labels
 * ("Ari's iPhone") and device ids are fingerprints, so hash the ids and drop free-text; keep
 * only non-personal structural fields. WHITELIST — arbitrary client `[extra]` fields are dropped.
 */
function redactSource(src: SourceInfo, redactor: Redactor): SourceInfo {
  const id = redactor.hashPeer(src.id);
  return {
    id,
    label: id, // no human name on the wire
    runtime: src.runtime,
    ...(src.deviceId ? { deviceId: redactor.hashPeer(src.deviceId) } : {}),
    ...(src.appId ? { appId: src.appId } : {}),         // a bundle id is not personal
    ...(src.variant ? { variant: src.variant } : {}),   // e.g. "nightly"
  };
}

export interface ObserveOptions {
  /** Flush cadence; must be in the collector's verified 100-250ms window. Default 200. */
  intervalMs?: number;
  /** Explicit hub connection (a NoiseSecretStream / socket). Skips auto-swarm. */
  stream?: WritableStreamLike;
  /** Fully custom exporter (e.g. Rozenite bridge, OTLP). Skips everything else. */
  exporter?: HyperswarmExporter;
  /** Hub topic string; must match the hub's. Default DEFAULT_TOPIC. */
  topic?: string;
  /** Set false to disable Bare/Pear auto-dial (then attach() a stream yourself). */
  autoSwarm?: boolean;
  /**
   * Send events to a local GUI over WebSocket instead of the Hyperswarm hub — the reliable
   * dev-viewer path for EVERY runtime (RN / Pear / desktop / browser),
   * e.g. 'ws://127.0.0.1:9420/ws'. When set, redaction defaults OFF (local viewing);
   * pass redact:true to force it. Takes precedence over stream/auto-swarm.
   */
  websocket?: string;
  /**
   * Redact every event on the way OUT (peer ids hashed, URLs host-only, bodies off)
   * — ON by default, because the export path (hub / .p2plog) leaves the device.
   * Set false ONLY for a purely-local view that never leaves the machine (F3/F4/F9).
   */
  redact?: boolean;
  /** Supply a shared Redactor (e.g. to reuse its local peer reverse-map). Default: a fresh one. */
  redactor?: Redactor;
  /** Per-`method` opt-in allowlist for full payload bodies (default: none — bodies summarised). */
  bodyAllowlist?: Iterable<string>;
  /**
   * Identity of THIS device/app, for the GUI's device & app selectors. A string label, or an
   * object `{ id?, label?, deviceId?, appId?, app?, device?, variant? }`.
   *   • deviceId — physical device (client-supplied; e.g. the app's own options.deviceId) → select by device
   *   • appId    — app/install instance → distinguishes MULTIPLE apps sharing one package
   * Omit → auto: browser reuses localStorage for a stable id (clears on delete-data); other
   * runtimes get a session id (pass deviceId/appId for stability). Only the client knows its
   * app name / device / variant, so it supplies those.
   */
  source?: string | Record<string, unknown>;
  /**
   * Allow the GUI to REPLAY a logged call back into this client (re-run a call the app already
   * made). Boundary: the GUI references a call by corrId and the METHOD is resolved from this
   * client's own call log — it never crosses the wire, so a replay cannot be redirected to a
   * method the app never called. The ARGS may be supplied by the GUI (edit-and-replay) and are
   * NOT validated here beyond "must be a JSON array"; use `canReplay` to check them.
   *
   * Fails CLOSED: must be set to `true` EXPLICITLY. There is no dev-detection default — omit it
   * and replay is off, so a shipped build never installs the inbound handler. Only meaningful
   * together with `websocket`.
   */
  allowInvoke?: boolean;
  /**
   * Optional gate consulted before a replay runs — return false to block (e.g. to refuse
   * re-running a mutating method like a send). Default: allow. Receives the logged method and the
   * args that will actually be used — which may be UNVALIDATED, GUI-supplied args. This is the
   * only argument check in the system, so an app whose methods mutate state should implement it.
   */
  canReplay?: (method: string, args: unknown[]) => boolean;
  /** Max logged calls retained for replay (corrId→method+args). Default 500. */
  replayLogMax?: number;
}

export interface ObserveHandle {
  /** Wire your L1 adapters into this: `instrumentDataChannel(dc, peerId, obs.sink)`. */
  sink: EventSink;
  flusher: BatchFlusher<L2Event>;
  runtime: Runtime;
  mode: 'websocket' | 'stream' | 'custom' | 'buffering';
  /** The redactor applied on export (null if redact:false). Use `.resolvePeer()` for a local names view. */
  redactor: Redactor | null;
  /** This device/app's resolved identity — stamped on every event as `src` and announced to the GUI. */
  source: SourceInfo;
  /** Report one event directly to the sink (this is what wrapClient uses). */
  report: Report;
  /** Wrap an RPC/service client so its calls + subscription streams are observed. */
  wrapClient<T extends Record<string, any>>(client: T, opts?: WrapClientOptions): T;
  /**
   * Snapshot of request/response calls currently in flight — started (request.start) but not yet
   * settled (request.end). Each `{ method, corrId, t }`. Subscription streams are not included (see
   * observe.ts). Wire this to a thread-occupancy probe's `getInflight` so a stall names the call
   * that was running (e.g. hrpc-inspector-threads).
   */
  inflight(): Array<{ method: string; corrId: string; t: number }>;
  /**
   * Bridge a hypertrace tracer into the SAME event stream: pass hypertrace's `setTraceFunction`
   * and every `trace()` from instrumented classes (e.g. a WebRTC/call layer) becomes a
   * `type:'trace'` event on a distinct "trace" plane in the GUI. Install this BEFORE the traced
   * objects are constructed (hypertrace only traces objects created after the function is set).
   * Dependency-free: the app supplies `setTraceFunction`, so the package never imports hypertrace.
   * Returns a disposer that stops forwarding.
   */
  bridgeTraces(setTraceFunction: (fn: (trace: any) => void) => void): () => void;
  /** Attach a hub connection later (auto-swarm calls this on 'connection'). */
  attach(stream: WritableStreamLike): void;
  stop(): void;
}

/** An exporter that buffers batches until a real stream is attached, then drains + goes live. */
function createDeferredExporter(): HyperswarmExporter & {
  attach(stream: WritableStreamLike): void;
  readonly pendingBatches: number;
} {
  let live: HyperswarmExporter | null = null;
  const buffered: unknown[][] = [];
  return {
    export(batch: unknown[]): void {
      if (live) live.export(batch);
      else buffered.push(batch);
    },
    attach(stream: WritableStreamLike): void {
      live = createHyperswarmExporter(stream);
      for (const b of buffered) live.export(b);
      buffered.length = 0;
    },
    get pendingBatches(): number {
      return buffered.length;
    },
  };
}

// Best-effort Hyperswarm auto-dial. Guarded dynamic import so this file is safe to load
// under Node/RN where hyperswarm isn't present.
// COVERAGE (honest): only the buffering→attach() HALF is tested (observe.test.mjs). This
// auto-dial trigger itself — detect Bare → import hyperswarm → join → on('connection') →
// attach — is UNVERIFIED here: no hyperswarm installed, no second peer/network (C14/G4).
async function autoSwarm(topic: string, onConnection: (stream: WritableStreamLike) => void): Promise<void> {
  const Hyperswarm = (await import('hyperswarm')).default;
  const crypto = (await import('hypercore-crypto')).default;
  const swarm = new Hyperswarm();
  // Buffer is a Bare/Node global and absent in browsers; this path only runs under Bare.
  const enc = new TextEncoder();
  const topicKey = crypto.hash(enc.encode(topic));
  swarm.on('connection', (conn: WritableStreamLike) => onConnection(conn));
  await swarm.join(topicKey, { client: true, server: false }).flushed();
}

export function observe(opts: ObserveOptions = {}): ObserveHandle {
  const info = detectRuntime();
  const source = resolveSource(opts.source, info.runtime);

  // Redaction is the choke point before anything leaves the device — computed FIRST so the
  // source announce + `src` stamp can also be redacted. Default ON for export paths
  // (hub / .p2plog); default OFF for the local WebSocket viewer (localhost, dev). `redact` wins.
  const redactOn = opts.redact ?? (opts.websocket ? false : true);
  const redactor: Redactor | null =
    opts.redactor ?? (redactOn ? new Redactor({ bodyAllowlist: opts.bodyAllowlist }) : null);
  // Identity ON THE WIRE — hashed ids / no human labels when redaction is on. `handle.source`
  // keeps the original for the app's own use.
  const wireSource = redactor ? redactSource(source, redactor) : source;

  // --- Replay capability (opt-in, websocket-only). The GUI can re-run a call the app already made,
  // referenced BY corrId: the METHOD is looked up in this client's own call log and never comes off
  // the wire, so a replay cannot be redirected to a method the app never called. The ARGS may be
  // overridden by the GUI and are not validated here beyond being a JSON array — opts.canReplay is
  // the only argument check (see handleInvoke).
  // Fails CLOSED: `allowInvoke: true` must be passed EXPLICITLY — no dev sniffing, so a production
  // build that forgot to strip observe() still installs no inbound handler and advertises no caps.
  const invokeEnabled = opts.allowInvoke === true && !!opts.websocket;
  // Replay window: how many recent calls stay replayable. The GUI can show up to ~5000 rows, so a
  // small window meant an older-but-still-visible row failed with 'unknown-corrId'. 2000 covers
  // realistic "replay a call you just saw" on a chatty app while bounding memory (raw
  // args are retained for replay fidelity — dev-only, never leaves the device). Tune via replayLogMax.
  const replayLogMax = opts.replayLogMax ?? 2000;
  const recentCalls = new Map<string, { method: string; args: unknown[] }>(); // corrId → its own call
  const recordCall = invokeEnabled
    ? (corrId: string, method: string, args: unknown[]) => {
        recentCalls.set(corrId, { method, args });
        if (recentCalls.size > replayLogMax) { const oldest = recentCalls.keys().next().value; if (oldest !== undefined) recentCalls.delete(oldest); }
      }
    : undefined;
  let wrapped: Record<string, any> | null = null; // set when the app calls handle.wrapClient

  let exporter: { export(batch: unknown[]): void };
  let reporter: Reporter | null = null;
  let deferred: ReturnType<typeof createDeferredExporter> | null = null;
  let mode: ObserveHandle['mode'];

  if (opts.exporter) {
    exporter = opts.exporter;
    mode = 'custom';
  } else if (opts.websocket) {
    // Reliable local-dev viewer for every runtime: WebSocket → GUI server. Announce our
    // (possibly redacted) source identity on connect so the GUI can offer a device selector.
    reporter = createWebSocketReporter(opts.websocket, {
      // Advertise the replay capability so the GUI shows Replay only for opted-in sources.
      announce: invokeEnabled ? { ...(wireSource as object), caps: { invoke: true } } : wireSource,
      // Inbound handler ONLY when replay is enabled — otherwise the reporter stays send-only.
      onMessage: invokeEnabled ? handleInvoke : undefined,
    });
    exporter = reporter;
    mode = 'websocket';
  } else if (opts.stream) {
    exporter = createHyperswarmExporter(opts.stream);
    mode = 'stream';
  } else {
    deferred = createDeferredExporter();
    exporter = deferred;
    mode = 'buffering';
  }

  const flusher = new BatchFlusher<L2Event>({
    intervalMs: opts.intervalMs ?? 200,
    onFlush: (batch) => {
      const out = redactor ? redactor.redactBatch(batch) : batch;
      // Stamp the (wire) source id so the GUI can group/select by device.
      exporter.export(out.map((e) => ({ ...(e as object), src: wireSource.id })));
    },
  });
  flusher.start();

  const sink: EventSink = {
    emit(event: L2Event): void {
      // Never throw into the app: the flusher just stages.
      try {
        flusher.add(event);
      } catch {
        /* monitoring must not crash the app it observes */
      }
    },
  };
  // In-flight tracker — request/response calls that have started (request.start) but not yet
  // settled (request.end). Maintained purely by watching the event stream, so it needs no change
  // to wrapClient. Scope is deliberate: subscription streams announce via stream.open (not
  // request.start), so a long-lived subscription is NOT counted as in-flight — otherwise every
  // stall would be blamed on every open stream. Exposed as handle.inflight() so a thread-occupancy
  // probe can BLAME a stall on the promise-returning call that was actually running.
  // Bounded so a call that never settles can't leak memory (oldest evicted past the cap).
  const INFLIGHT_MAX = 1000;
  const inflightCalls = new Map<string, { method: string; corrId: string; t: number }>();
  const report: Report = (event) => {
    const e = event as any;
    const corrId = e && typeof e.corrId === 'string' ? e.corrId : null;
    if (corrId) {
      if (e.type === 'request.start') {
        inflightCalls.set(corrId, { method: String(e.method ?? ''), corrId, t: typeof e.t === 'number' ? e.t : Date.now() });
        if (inflightCalls.size > INFLIGHT_MAX) { const oldest = inflightCalls.keys().next().value; if (oldest !== undefined) inflightCalls.delete(oldest); }
      } else if (e.type === 'stream.open' || e.type === 'request.end') {
        // request.end = the call settled. stream.open = this corrId is a subscription, not a
        // request/response call (wrapFn emits request.start unconditionally, THEN stream.open) —
        // drop it so long-lived subscriptions don't pollute every stall's blame list.
        inflightCalls.delete(corrId);
      }
    }
    sink.emit(event as L2Event);
  };

  // Surface an invoke failure back to the GUI over the SAME outbound event path (no side channel).
  function emitInvokeError(invokeId: string, corrId: string, error: string): void {
    report({ type: 'invoke.error', invokeId, replayOf: corrId, origin: 'gui', error, t: Date.now() });
  }
  // Dispatch a GUI replay request. `{__invoke:{corrId, invokeId}}` re-runs the app's OWN logged
  // call for that corrId — an unknown corrId is rejected, so only real, already-made calls replay.
  function handleInvoke(msg: any): void {
    if (!invokeEnabled || !msg || !msg.__invoke) return;
    const corrId = String(msg.__invoke.corrId ?? '');
    const invokeId = String(msg.__invoke.invokeId ?? '');
    if (!wrapped) return emitInvokeError(invokeId, corrId, 'client-not-wrapped');
    const rec = recentCalls.get(corrId);
    if (!rec) return emitInvokeError(invokeId, corrId, 'unknown-corrId');          // enforced: log-bound
    // "Replay with edit": args MAY be overridden by the GUI, but the METHOD stays locked to the
    // logged call (rec.method) — you can only re-send a call that actually happened with tweaked
    // args, never invoke a method the app never made. Edited args must be a JSON array.
    const edited = msg.__invoke.args;
    if (edited !== undefined && !Array.isArray(edited)) return emitInvokeError(invokeId, corrId, 'bad-args');
    const args = edited !== undefined ? edited : rec.args;
    if (opts.canReplay && !opts.canReplay(rec.method, args)) return emitInvokeError(invokeId, corrId, 'blocked-by-canReplay');
    const [ns, m] = rec.method.split('.', 2);
    const fn = m ? wrapped?.[ns]?.[m] : (wrapped as any)?.[ns];
    if (typeof fn !== 'function') return emitInvokeError(invokeId, corrId, 'method-unavailable');
    try {
      setInvokeContext({ invokeId, replayOf: corrId, method: rec.method }); // tags the re-run's events origin:'gui'
      (m ? wrapped![ns][m] : (wrapped as any)[ns])(...args);
    } catch (e) {
      emitInvokeError(invokeId, corrId, 'threw: ' + String(e));
    } finally {
      setInvokeContext(null); // never let the tag leak onto a later organic call
    }
  }

  const attach = (stream: WritableStreamLike): void => {
    if (deferred) deferred.attach(stream);
  };

  // Auto-dial the hub when we're inside Bare/Pear (or an RN bare-kit worklet) and buffering.
  if (mode === 'buffering' && info.isBareRuntime && opts.autoSwarm !== false) {
    autoSwarm(opts.topic ?? DEFAULT_TOPIC, attach).catch(() => {
      /* stay buffering; caller may attach() manually */
    });
  }

  return {
    sink,
    flusher,
    runtime: info.runtime,
    mode,
    redactor,
    source,
    report,
    inflight: () => [...inflightCalls.values()],
    wrapClient: (client, o) => { wrapped = wrapClient(client, report, { ...(o || {}), onCall: recordCall }); return wrapped as typeof client; },
    bridgeTraces: (setTraceFunction) => {
      let on = true;
      try {
        setTraceFunction((trace: any) => {
          if (!on) return;
          try {
            const obj = (trace && trace.object) || {};
            const caller = (trace && trace.caller) || {};
            const data = caller.props;                                   // the trace({...}) args
            const event = (data && data.event) || caller.functionName || 'trace';
            report({
              type: 'trace', plane: 'trace',
              className: obj.className, objId: obj.id, objProps: obj.props,
              method: (obj.className ? obj.className + '.' : '') + event, // GUI groups/labels by this
              event, data,
              caller: caller.functionName ? caller.functionName + ':' + caller.line : undefined,
              t: Date.now(),
            });
          } catch { /* a trace must never break the app it observes */ }
        });
      } catch { /* setTraceFunction unavailable — no-op */ }
      return () => { on = false; };
    },
    attach,
    stop: () => { flusher.stop(); reporter?.close(); },
  };
}
