// Generic RPC/service-client tap — the most useful and portable way to observe an app.
//
// Works for ANY object of namespaced methods that return a Promise (request/response) OR a
// stream (subscription): an app-core RPC client, a libp2p service, your own service object.
// Runtime-agnostic (RN, Pear/Bare, Node, Electron, browser) — it only touches JS objects.
//
// Emits (via `report`) the same event vocabulary the collector/GUI understand:
//   request.start {method,args,corrId}  → a call began
//   request.end   {method,status,response|error,dur,corrId}  → promise settled / stream closed
//   stream.open   {method,corrId}       → a subscription stream began
//   stream.data   {method,seq,item,corrId}  → one item pushed by a subscription

export type Report = (event: Record<string, unknown>) => void;

export interface WrapClientOptions {
  /** Summarise args/response/stream items before reporting. Default: bounded JSON. */
  preview?: (v: unknown) => unknown;
  /** Monitor subscription streams' data/end/error. Default true. */
  monitorStreams?: boolean;
  /**
   * Called with the RAW (un-previewed) args at each call site, keyed by the minted corrId.
   * observe() uses this to keep a bounded call-log so a GUI can REPLAY a logged call by corrId.
   * The METHOD comes from this log, never from the wire, so a replay cannot be redirected to a
   * method the app never called. ARGS, however, may be supplied by the GUI (edit-and-replay) and
   * are not validated by this library — the app's `canReplay(method, args)` hook is the only
   * argument check. Wired only when `allowInvoke: true` is passed explicitly.
   */
  onCall?: (corrId: string, method: string, args: unknown[]) => void;
}

let seq = 0;

// Consume-once context for tagging a REPLAYED call's events as GUI-originated. The dispatcher
// (observe.invoke) sets this immediately before invoking the wrapped fn; wrapFn reads it on its
// synchronous first line and clears it. The `method` guard means a stray organic call that somehow
// runs in between cannot steal the tag — it only applies to the exact method being replayed.
let invokeCtx: { invokeId: string; replayOf: string; method: string } | null = null;
export function setInvokeContext(ctx: { invokeId: string; replayOf: string; method: string } | null): void {
  invokeCtx = ctx;
}

// Keep realistic RPC bodies WHOLE so the GUI can render them as a foldable tree — the old 4000B
// cap collapsed anything larger (e.g. a message list) into a truncated STRING, which the inspector
// then showed as a string, not JSON. 64KB covers normal responses; the local viewer is localhost +
// redaction-off, and export paths redact bodies regardless of this preview. Above the cap we keep a
// STRUCTURED marker (still tree-able), never a raw truncated string.
const PREVIEW_MAX_BYTES = 64_000;
function defaultPreview(v: unknown): unknown {
  try {
    const s = JSON.stringify(v);
    if (s === undefined) return String(v);
    if (s.length <= PREVIEW_MAX_BYTES) return v;                       // small enough: keep structure
    if (typeof v === 'string') return v.slice(0, PREVIEW_MAX_BYTES) + `…[truncated ${s.length}B]`;
    return { __truncated: true, bytes: s.length, preview: s.slice(0, 2000) + '…' }; // object stays tree-able
  } catch {
    return { __unserializable: true };
  }
}

// Attach PASSIVE listeners to a subscription stream. Non-destructive when the app also uses
// `.on('data')` (every listener receives each item). If a consumer instead uses `.read()` /
// async-iteration, adding a data listener flips it to flowing mode — opt out with
// monitorStreams:false for those.
function monitorStream(report: Report, endpoint: string, corrId: string, stream: any, t0: number, preview: (v: unknown) => unknown, tag: Record<string, unknown>): void {
  report({ type: 'stream.open', method: endpoint, corrId, t: Date.now(), ...tag });
  let n = 0;
  let ended = false;
  const settle = (status: string, extra?: Record<string, unknown>) => {
    if (ended) return;
    ended = true;
    report({ type: 'request.end', method: endpoint, corrId, status, count: n, dur: Date.now() - t0, t: Date.now(), ...tag, ...(extra || {}) });
  };
  try {
    stream.on('data', (item: unknown) => report({ type: 'stream.data', method: endpoint, corrId, seq: ++n, item: preview(item), t: Date.now(), ...tag }));
    stream.on('error', (err: unknown) => settle('error', { error: String(err) }));
    stream.on('end', () => settle('closed'));
    stream.on('close', () => settle('closed'));
  } catch (e) {
    report({ type: 'request.end', method: endpoint, corrId, status: 'error', error: 'monitor-failed: ' + String(e), dur: 0, t: Date.now(), ...tag });
  }
}

function wrapFn(report: Report, endpoint: string, fn: any, self: any, preview: (v: unknown) => unknown, monitorStreams: boolean, onCall?: (corrId: string, method: string, args: unknown[]) => void): any {
  return function observed(this: unknown, ...args: unknown[]) {
    const corrId = 'rpc-' + ++seq;
    // Consume the invoke tag ONCE, and only for the exact method being replayed.
    let tag: Record<string, unknown> = {};
    if (invokeCtx && invokeCtx.method === endpoint) {
      tag = { origin: 'gui', invokeId: invokeCtx.invokeId, replayOf: invokeCtx.replayOf };
      invokeCtx = null;
    }
    if (onCall) { try { onCall(corrId, endpoint, args); } catch { /* logging must not break the call */ } }
    const t = Date.now();
    report({ type: 'request.start', method: endpoint, corrId, args: preview(args), t, ...tag });
    let result: any;
    try {
      result = fn.apply(self, args);
    } catch (err) {
      report({ type: 'request.end', method: endpoint, corrId, status: 'error', error: String(err), dur: Date.now() - t, t: Date.now(), ...tag });
      throw err;
    }
    if (result && typeof result.then === 'function') {
      result.then(
        (res: unknown) => report({ type: 'request.end', method: endpoint, corrId, status: 'ok', response: preview(res), dur: Date.now() - t, t: Date.now(), ...tag }),
        (err: unknown) => report({ type: 'request.end', method: endpoint, corrId, status: 'error', error: String(err), dur: Date.now() - t, t: Date.now(), ...tag })
      );
    } else if (monitorStreams && result && typeof result.on === 'function') {
      monitorStream(report, endpoint, corrId, result, t, preview, tag);
    } else {
      report({ type: 'request.end', method: endpoint, corrId, status: 'ok', response: preview(result), dur: Date.now() - t, t: Date.now(), ...tag });
    }
    return result;
  };
}

/**
 * Wrap a client object of namespaced methods (`client.namespace.method(...)`) so every call
 * reports endpoint + request + response/stream. Mutates and returns the same client; method
 * return values and `this` binding are preserved (a wrapped call behaves identically).
 */
export function wrapClient<T extends Record<string, any>>(client: T, report: Report, opts: WrapClientOptions = {}): T {
  if (!client || typeof client !== 'object') return client;
  const preview = opts.preview ?? defaultPreview;
  const monitorStreams = opts.monitorStreams !== false;
  try {
    for (const ns of Object.keys(client)) {
      const group = (client as any)[ns];
      if (group && typeof group === 'object') {
        for (const m of Object.keys(group)) {
          if (typeof group[m] === 'function') group[m] = wrapFn(report, `${ns}.${m}`, group[m], group, preview, monitorStreams, opts.onCall);
        }
      } else if (typeof group === 'function') {
        (client as any)[ns] = wrapFn(report, ns, group, client, preview, monitorStreams, opts.onCall);
      }
    }
  } catch {
    /* never break the client */
  }
  return client;
}
