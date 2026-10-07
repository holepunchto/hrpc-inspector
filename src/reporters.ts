// Reporters = where observed events go. The WebSocket reporter is the reliable local-dev
// path for EVERY runtime (RN, Pear/Bare, Node/Electron, browser): a plain WebSocket to the
// GUI server on your machine. Unlike the Hyperswarm hub (peer↔peer, DHT holepunched), a
// WebSocket to your dev host Just Works — it's how RN DevTools/Metro talk to your laptop.
//
// A reporter is `{ export(batch), close() }` — the same shape observe()'s flusher drives.

export interface Reporter {
  export(batch: unknown[]): void;
  close(): void;
}

export interface WebSocketReporterOptions {
  /** WebSocket implementation. Default globalThis.WebSocket (RN/browser/Bare/Node ≥22 have it). */
  WebSocketImpl?: any;
  /** Max events buffered while disconnected (oldest dropped past this). Default 1000. */
  maxQueue?: number;
  /** Reconnect delay ms. Default 3000. */
  reconnectMs?: number;
  /** Source identity sent once per connection as `{ __source }` so the GUI can build a device selector. */
  announce?: unknown;
  /**
   * Inbound frame handler. When set, the reporter becomes BIDIRECTIONAL — it installs
   * `ws.onmessage` and forwards parsed frames here. observe() passes this ONLY in dev (for the
   * replay/invoke path); leaving it undefined keeps the reporter strictly send-only, as before.
   */
  onMessage?: (msg: any) => void;
  /** Ceiling for the reconnect backoff, in ms. Default 30000. */
  maxReconnectMs?: number;
}

/**
 * Send each event as one JSON WebSocket message to `url` (e.g. ws://127.0.0.1:9420/ws).
 * Auto-connects, queues while down, flushes on open, reconnects on close. Never throws.
 */
export function createWebSocketReporter(url: string, opts: WebSocketReporterOptions = {}): Reporter {
  const WS = opts.WebSocketImpl ?? (globalThis as any).WebSocket;
  const maxQueue = opts.maxQueue ?? 1000;
  const reconnectMs = opts.reconnectMs ?? 3000;
  const OPEN = 1;

  const maxReconnectMs = opts.maxReconnectMs ?? 30000;

  let ws: any = null;
  let queue: unknown[] = [];
  let closed = false;
  // A reconnect already scheduled. Without this, export() — which runs on every flush, i.e. every
  // ~200ms — would open a fresh socket the moment the previous one failed, defeating the backoff
  // entirely. A browser logs EVERY refused WebSocket connect to the console itself, before any
  // onerror handler runs, so that turned "no GUI running" into a console flooded at 5 errors/sec.
  let retryTimer: any = null;
  let backoffMs = reconnectMs;

  function enqueue(ev: unknown) {
    queue.push(ev);
    if (queue.length > maxQueue) queue.shift();
  }
  function rawSend(ev: unknown) {
    try { ws.send(JSON.stringify(ev)); } catch { enqueue(ev); }
  }
  function scheduleRetry() {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; ensure(); }, backoffMs);
    // Widen the gap each time the viewer stays absent, so a dev session with no GUI settles at one
    // attempt per maxReconnectMs instead of one per flush. Reset to `reconnectMs` on a real open.
    backoffMs = Math.min(backoffMs * 2, maxReconnectMs);
    if (typeof retryTimer?.unref === 'function') retryTimer.unref();
  }

  function ensure() {
    if (closed || !WS) return;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    if (retryTimer) return; // a reconnect is already pending — do not stack another socket on top
    try {
      ws = new WS(url);
      ws.onopen = () => {
        backoffMs = reconnectMs; // the viewer is back; retry promptly if it goes away again
        if (opts.announce !== undefined) rawSend({ __source: opts.announce }); // identify this device first
        const q = queue; queue = []; for (const e of q) rawSend(e);
      };
      ws.onclose = () => { ws = null; scheduleRetry(); };
      ws.onerror = () => {};
      // Bidirectional only when a handler was supplied (dev/replay path). Never throws inward.
      if (opts.onMessage) ws.onmessage = (m: any) => { try { opts.onMessage!(JSON.parse(m.data)); } catch { /* ignore malformed inbound */ } };
    } catch {
      ws = null;
      scheduleRetry();
    }
  }

  return {
    export(batch: unknown[]) {
      if (closed) return;
      ensure();
      for (const ev of batch) {
        if (ws && ws.readyState === OPEN) rawSend(ev);
        else enqueue(ev);
      }
    },
    close() {
      closed = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      try { ws?.close(); } catch {}
      ws = null;
    },
  };
}
