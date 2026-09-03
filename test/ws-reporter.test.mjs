// createWebSocketReporter — the reliable local-dev viewer transport for every runtime.
// Proves: events queue while disconnected, flush on open, send while open; control shows
// nothing sends after close. Uses an injected fake WebSocket (no real network).

import { createWebSocketReporter } from '../src/reporters.ts';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

console.log('ws-reporter.test.mjs — WebSocket reporter\n');

class FakeWS {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWS.last = this; }
  send(s) { this.sent.push(s); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  open() { this.readyState = 1; if (this.onopen) this.onopen(); } // test helper
}

const reporter = createWebSocketReporter('ws://127.0.0.1:9420/ws', { WebSocketImpl: FakeWS });

// (1) export before the socket is open → queued, nothing sent yet.
reporter.export([{ type: 'request.start', method: 'core.boot', corrId: 'c1' }]);
const ws = FakeWS.last;
check('socket constructed with the url', ws && ws.url === 'ws://127.0.0.1:9420/ws');
check('CONTROL: nothing sent before open (queued)', ws.sent.length === 0);

// (2) open → queued events flush.
ws.open();
check('queued event flushed on open', ws.sent.length === 1 && JSON.parse(ws.sent[0]).method === 'core.boot');

// (3) export while open → sent immediately, one JSON message per event.
reporter.export([
  { type: 'request.end', method: 'core.boot', corrId: 'c1', status: 'ok' },
  { type: 'stream.data', method: 'sub.watch', corrId: 'c2', seq: 1 },
]);
check('events sent immediately while open (one message each)', ws.sent.length === 3 && JSON.parse(ws.sent[2]).type === 'stream.data');

// (4) CONTROL: after close(), further exports are dropped (no send, no throw).
reporter.close();
const before = ws.sent.length;
reporter.export([{ type: 'request.start', method: 'late', corrId: 'c3' }]);
check('CONTROL: nothing sent after close()', ws.sent.length === before);

console.log(failures === 0 ? '\nAll ws-reporter claims verified.' : `\n${failures} claim(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
