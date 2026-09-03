# hrpc-inspector — usage (all runtimes)

Observe an app's P2P / RPC traffic as a **network inspector** — endpoint, request, response,
latency, and **live subscription streams** — across React Native (bare-kit worklets), plain
Pear/Bare apps, desktop (Electron/Node), and the browser. One package, one GUI.

Signatures verified in `../../verification/{observe,wrap-client,ws-reporter,observe-redaction}.test.mjs`.
Ships as a bundled `dist/` (esbuild); source of truth is `src/`.

---

## 1. Two ways to tap (pick what fits the app)

### A) `wrapClient` — tap an RPC / service client  ★ recommended
For any object of namespaced methods (`client.namespace.method(...)`) that returns a **Promise**
(request/response) or a **stream** (subscription). This is the most useful and the most
portable tap — it produces named endpoints + request args + the actual response, and it
**monitors subscription streams** (so they don't sit "pending"). Works in every runtime.

```js
import { observe } from 'hrpc-inspector'
const obs = observe({ websocket: 'ws://127.0.0.1:9420/ws' })   // where events go (see §2)
const client = obs.wrapClient(myRpcClient)                     // tap it; returns the same client
// use `client` exactly as before — calls now show up in the GUI
```
Emits `request.start` → `request.end` (promises) and `stream.open` → `stream.data*` →
`request.end` (subscriptions). Return values and `this` are preserved; a wrapped call behaves
identically. Opt out of stream monitoring with `obs.wrapClient(client, { monitorStreams: false })`.

### B) Transport adapters — tap a raw transport
When there's no RPC client, tap the transport bytes directly:
`instrumentDataChannel` / `instrumentPeerConnection` (WebRTC), `instrumentWebSocket`,
`instrumentHyperswarmStream` — each `(target, …, obs.sink)`, returning `{ restore() }`.

---

## 2. Where events go (reporters / exporters)

`observe(options)` picks one, in this precedence:

| Option | Destination | Redaction default | Use when |
|---|---|---|---|
| `websocket: 'ws://host:port/ws'` | **local GUI over WebSocket** | **off** (localhost dev) | **local dev — every runtime.** Reliable (unlike DHT holepunch) |
| `exporter: <custom>` | your sink (Rozenite / OTLP) | on | custom pipeline |
| `stream: <duplex>` | a hub connection you provide | on | you already hold a hub socket |
| *(none)* | Bare/Pear → auto-dial the Hyperswarm hub; else buffer + `attach()` | on | multi-peer / field P2P |

| Capability | Default | Notes |
|---|---|---|
| `allowInvoke: true` | **off** | Enables GUI replay. Requires a `websocket:` viewer. Dev builds only. |
| `canReplay(method, args)` | allow all | The only check on GUI-supplied replay arguments. |

### Replay is opt-in (off by default)

The GUI can re-run a call your app already made. That is an **inbound execution surface**, so it
is off unless you ask for it, in a dev build only:

```js
const obs = observe({
  websocket: 'ws://127.0.0.1:9420/ws',
  allowInvoke: true,        // dev builds ONLY — never ship this
  canReplay: (method, args) => method.startsWith('read.'),   // your own gate, see below
})
```

It used to default on whenever no production signal was detectable — which is exactly what a
browser or Bare/Pear bundle looks like, so a shipped release could carry the surface. It now
requires the explicit flag.

What the boundary actually is, precisely:

- **The method is safe.** It is resolved from your app's own call log by `corrId` and never
  crosses the wire, so a crafted frame cannot name a method your app did not already call.
- **The arguments are not.** The GUI's "Edit & replay" sends caller-supplied args, and the
  library checks only that they are a JSON array. **`canReplay(method, args)` is the only
  argument check in the system** — if a replayable method mutates state, implement it.

Redaction is the choke point before data leaves the device — hashes peer ids, strips URL
tokens, summarises bodies. It defaults **on** for export paths and **off** for the local
`websocket` viewer. Force either with `redact: true|false`.

---

## 3. The GUI  (ships in the package)

Run it on your dev machine — no extra install (dependency-free server):
```bash
npx hrpc-inspector gui                          # http://localhost:9420  (--port N, --demo)
```
Open **http://localhost:9420** — a request/response inspector: endpoint · status · ms · size,
click a row for request args + core response. Subscriptions render as **live streams**
(`streaming · N msgs`) with each response item.

**Connectivity (device → your Mac):**

| Runtime | `HOST` in `observe({ websocket })` | Setup |
|---|---|---|
| Android emulator/device | `127.0.0.1` | `adb reverse tcp:9420 tcp:9420` (like Metro's 8081) |
| iOS simulator | `127.0.0.1` | none |
| Real device (no adb) | your Mac's LAN IP | same Wi-Fi |
| Pear/Bare/Electron/Node/browser on the same machine | `127.0.0.1` | none |

### Device & app selectors (multiple sources)

When several apps/devices report to one GUI, pass a `source` so you can select between them —
by **physical device** or by **app id** (for multiple apps sharing one package):

```js
observe({
  websocket: 'ws://127.0.0.1:9420/ws',
  source: { deviceId: options.deviceId, appId: APP_VARIANT, device: 'Pixel 7' },
})
```
The GUI shows source chips plus **all devices** / **all apps** dropdowns (filter by either).
The unique `id` derives from `deviceId:appId` (so same device + different app, or same app +
different device, stay distinct).

**Stable ids (reuse local storage) — design, browser-path untested in CI:**
- **Browser** — the package is *intended to* persist a stable id in `localStorage` (survives
  reload, clears on delete-data). ⚠️ Not covered by the suite — there is no browser runtime in
  CI, so this path is UNVERIFIED HERE; verify in a real browser.
- **React Native / Bare / Node** — the client passes `deviceId` from its own persistent store
  (RN `AsyncStorage`, a Bare/Node file, or a platform id — many app cores already expose an `options.deviceId`).
  Without it you get a **per-session id** that changes on restart (VERIFIED). The id derivation
  itself (`deviceId`/`appId` → distinct ids) is VERIFIED in `verification/observe.test.mjs`.

---

## 4. Export paths & symbols

| Path | Exports |
|---|---|
| `hrpc-inspector` | `observe`, `wrapClient`, `createWebSocketReporter`, `detectRuntime`, adapters, `CollectorSink`, `BatchFlusher`, `StreamFramer`/`encodeFrame`, `DEFAULT_TOPIC`, types |
| `hrpc-inspector/observe` | `observe`, `DEFAULT_TOPIC`, `ObserveOptions`, `ObserveHandle` |
| `hrpc-inspector/detect` | `detectRuntime`, `Runtime`, `RuntimeInfo` |

**`observe(options?) → handle`.** Options: `{ websocket?, exporter?, stream?, topic?, autoSwarm?, intervalMs?=200, redact?, redactor?, bodyAllowlist? }`.
Handle: `{ sink, report, wrapClient(client, opts?), flusher, redactor, runtime, mode, attach(stream), stop() }`.

**`wrapClient(client, report, opts?)`** — standalone form of `handle.wrapClient`.
**`createWebSocketReporter(url, opts?)`** — `{ export(batch), close() }`; queues while down, flushes on open, reconnects.

---

## 5. Per-runtime recipes

**React Native** — the observability core runs in a `react-native-bare-kit` worklet OR you can
skip the worklet entirely and report over WebSocket from the RN JS thread. For an RPC-client
app (e.g. an app-core RPC client), wrap the client and report over WS:
```js
const obs = observe({ websocket: `ws://127.0.0.1:9420/ws` })   // Android: adb reverse first
const client = obs.wrapClient(rawRpcClient)                    // endpoints + responses + streams
```

**Pear / Bare app** — same call; either report over `websocket` (local GUI) or omit it to
auto-dial the Hyperswarm hub for multi-peer.
```js
const obs = observe({ websocket: 'ws://127.0.0.1:9420/ws' })
```

**Electron / Node** — runs in-process:
```js
const obs = observe({ websocket: 'ws://127.0.0.1:9420/ws' })
obs.wrapClient(serviceClient)            // or instrument a raw socket via the adapters
```

**Browser** — `observe({ websocket })` uses the global `WebSocket`; wrap your service client
or instrument a `WebSocket`/`RTCDataChannel` via the adapters.

---

## 6. Verified vs not

- **VERIFIED** (Node): runtime detection; observe() wiring; redaction-on-export + control;
  `wrapClient` (endpoint/request/response, `this`/return preserved, subscription-stream
  monitoring) + controls; `createWebSocketReporter` (queue → flush → send, close) + control.
- **UNVERIFIABLE HERE**: on-device RN (`react-native-bare-kit`), a live two-peer Hyperswarm
  connection (one interface — C14/G4), static `tsc`. Verify those on real targets.

No silent postinstall — `npx hrpc-inspector init` is explicit and dry-runs by default.
