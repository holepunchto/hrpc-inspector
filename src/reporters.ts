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

  let ws: any = null;
  let queue: unknown[] = [];
  let closed = false;

  function enqueue(ev: unknown) {
    queue.push(ev);
    if (queue.length > maxQueue) queue.shift();
  }
  function rawSend(ev: unknown) {
    try { ws.send(JSON.stringify(ev)); } catch { enqueue(ev); }
  }
  function ensure() {
    if (closed || !WS) return;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    try {
      ws = new WS(url);
      ws.onopen = () => {
        if (opts.announce !== undefined) rawSend({ __source: opts.announce }); // identify this device first
        const q = queue; queue = []; for (const e of q) rawSend(e);
      };
      ws.onclose = () => { ws = null; if (!closed) setTimeout(ensure, reconnectMs); };
      ws.onerror = () => {};
      // Bidirectional only when a handler was supplied (dev/replay path). Never throws inward.
      if (opts.onMessage) ws.onmessage = (m: any) => { try { opts.onMessage!(JSON.parse(m.data)); } catch { /* ignore malformed inbound */ } };
    } catch {
      ws = null;
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
      try { ws?.close(); } catch {}
      ws = null;
    },
  };
}
