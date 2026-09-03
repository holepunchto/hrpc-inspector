# hrpc-inspector

hrpc based debugging and observability for Bare. Tap an RPC client or a raw transport and read
endpoint, request, response, latency and live subscription streams — the same core across
**React Native** (via `react-native-bare-kit` worklets), **Pear/Bare**, **Electron/Node** and the
browser.

```
npm i -D hrpc-inspector
npx hrpc-inspector init          # detect the project, preview the plan (writes nothing)
npx hrpc-inspector init --write  # apply (never overwrites an existing file)
```

## Use

```js
import { observe } from 'hrpc-inspector'

const obs = observe({
  websocket: 'ws://127.0.0.1:9420/ws',   // reliable local-dev viewer
  allowInvoke: true,                     // opt in to GUI replay — DEV BUILDS ONLY
})
const client = obs.wrapClient(myRpcClient)  // endpoint + request + response + streams
```

```
npx hrpc-inspector gui           # http://localhost:9420
adb reverse tcp:9420 tcp:9420    # Android only, or the device cannot reach your machine
```

No client to wrap? Tap the transport directly:

```js
import { observe, instrumentDataChannel } from 'hrpc-inspector'
instrumentDataChannel(dataChannel, peerId, observe({ websocket: 'ws://127.0.0.1:9420/ws' }).sink)
```

## Two export paths, and the difference matters

Pass `websocket` and events stream to the local GUI over a plain WebSocket — reliable on every
runtime because it is not DHT holepunching. Omit it and, inside Bare/Pear, `observe()` auto-dials a
Hyperswarm hub so multiple peers merge into one timeline ordered by hybrid logical clock.

Redaction follows that split: **off** for the local viewer (localhost, never leaves the machine),
**on** for the hub (it leaves the device). Full reference in [USAGE.md](USAGE.md).

## Replay is opt-in

The GUI can re-run a call the app already made. That is an inbound execution surface, so it needs an
explicit `allowInvoke: true` and a `websocket:` viewer. The method is resolved from your app's own
call log and cannot be redirected from the wire; the **arguments are caller-supplied and unvalidated**,
so `canReplay(method, args)` is the only argument check in the system.

## Test

```
npm test
```

Eleven dependency-free suites, including one that packs the tarball and runs the CLI out of it —
because every other suite runs against the worktree, where a packaging mistake is invisible.

## License

[Apache-2.0](LICENSE). Copyright notice in [NOTICE](NOTICE).
