#!/usr/bin/env bash
# CI gate for hrpc-inspector. Non-zero exit blocks a release.
set -u
cd "$(dirname "$0")"
fail=0
run() { echo "--- $1"; if eval "$2"; then echo "    PASS"; else echo "    FAIL"; fail=1; fi; echo; }

echo "=== hrpc-inspector (observe + CLI + GUI) ==="
echo "Node $(node --version)"
echo

run "observe.test.mjs (plug-and-play + runtime detect)"      "node observe.test.mjs"
run "observe-redaction.test.mjs (redaction on export path)"  "node observe-redaction.test.mjs"
run "redact-methods.test.mjs (per-method redaction)"        "node redact-methods.test.mjs"
run "wrap-client.test.mjs (RPC tap + streams)"               "node wrap-client.test.mjs"
run "fn-identity.test.mjs (wrapping preserves fn.name)"     "node fn-identity.test.mjs"
run "stream-passive.test.mjs (monitoring never consumes)"   "node stream-passive.test.mjs"
run "inflight.test.mjs (in-flight call tracking)"            "node inflight.test.mjs"
run "ws-reporter.test.mjs (WebSocket dev-viewer transport)"   "node ws-reporter.test.mjs"
run "source.test.mjs (source id injectivity + redaction)"     "node source.test.mjs"
run "replay.test.mjs (GUI replay gating + controls)"          "node replay.test.mjs"
run "origin-guard.test.mjs (WS upgrade CSRF guard)"           "node origin-guard.test.mjs"
run "gui-xss.test.mjs (no wire field reaches innerHTML raw)"  "node gui-xss.test.mjs"
run "tarball-cli.test.mjs (the PUBLISHED artifact runs)"      "node tarball-cli.test.mjs"
run "testnet-capture.test.mjs (multi-peer; SKIPs w/o deps)"   "node testnet-capture.test.mjs"

if [ $fail -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "VERIFICATION FAILED"; fi
exit $fail
