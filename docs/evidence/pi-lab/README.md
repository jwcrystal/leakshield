# pi 1.6.0 loopback prototype

This research prototype exercises the exported LeakShield Core through the actual pi CLI. It uses a synthetic private value and a loopback provider. The overall Issue #98 release gate remains **BLOCKED** because direct requests to the upstream bypass the lab proxy.

The extension masks serialized OpenAI Chat Completions requests, restores text into a local stderr diagnostic display, and restores the built-in read tool's flat arguments at the execution boundary. It keeps assistant history pseudonymized. This is an ephemeral single-session fixture, with only the read tool enabled. The diagnostic display does not implement a pi interactive renderer.

## Reproduction

Use Node.js 24.22.3. Start in the repository root. The separate runtime installation keeps pi dependencies out of the product package.

```sh
npm ci
npm run build
runtime="$(mktemp -d)"
npm install --prefix "$runtime" --save-exact @earendil-works/pi-coding-agent@1.6.0
PI_CODING_AGENT_DIR="$runtime/agent" "$runtime/node_modules/.bin/pi" --offline --version
node docs/evidence/pi-lab/run.mjs "$runtime/node_modules/.bin/pi"
node docs/evidence/pi-lab/run.mjs "$runtime/node_modules/.bin/pi" invalid-tool
node docs/evidence/pi-lab/run-gate.mjs "$runtime/node_modules/.bin/pi"
node docs/evidence/pi-provider-boundary.mjs "$runtime/node_modules/.bin/pi"
```

The final command intentionally exits 1 when the unprotected hook sends a request after a forced error. The lab and gate harnesses exit 0 when their assertions match the observations. The gate harness asserts that direct bypass exists and prints a blocked release status.

The npm tarball integrity and matching upstream source commit are recorded in the [runtime report](../2026-11-22-pi-runtime-provider-boundary.md).

## Observations

| Actual pi process test | Observation |
| --- | --- |
| Prompt and system masking | Provider receives placeholders |
| Streamed placeholder reply | Local diagnostic restores the private value |
| Built-in read tool | File with original private value in its name is read successfully |
| Tool result | Original content is masked before the next request |
| Follow-up conversation | Assistant history retains placeholders |
| Modified placeholder in read argument | Tool is refused, file content stays unread |
| Hook throws with proxy | Zero upstream requests, CLI exit 1 |
| Hook rejects with proxy | Zero upstream requests, CLI exit 1 |
| Extension disabled with proxy | Zero upstream requests, CLI exit 1 |
| Valid proof | One request reaches the upstream |
| Missing proof, modified payload, replay, unsupported route | HTTP 400, zero additional upstream requests |
| Direct upstream request | Original private value reaches upstream, release blocked |

The lab gate accepts only POST /v1/chat/completions and forwards to a fixed loopback destination. The extension signs the masked payload with a per-run HMAC key, nonce and timestamp. The gate validates the exact payload, rejects reused nonces and removes the proof before forwarding. It buffers the stub's SSE response. The HMAC proves that the paired trusted extension approved those bytes. It cannot constrain arbitrary code holding the key or prevent direct network connections.

## Limits and next gate

This run covers OpenAI-compatible HTTP and SSE, an ephemeral mapping, a read tool and a local diagnostic display. Persistent sessions, interactive display, real credentials, other provider formats, compaction, background calls, custom tools, write/edit/shell restoration, and incremental proxy streaming remain unverified.

An enforced egress route is required to prevent direct-provider bypass. Provider credentials and network routing must be controlled at a boundary the extension cannot bypass, then exercised under the same forced failures. A production adapter can resume after that proof passes. The lab helper files have no product package entrypoint.

## Cloud run on 2026-11-22

The prototype ran from PR #100's independent worktree. Captured summaries follow. Only synthetic markers were used.

```jsonl
{"requests":3,"rawValueAtProvider":false,"localReadRestored":true,"modifiedTokenBlocked":false,"toolOutputMasked":true,"localDisplayRestored":true,"assistantHistoryMasked":true}
{"requests":3,"rawValueAtProvider":false,"localReadRestored":false,"modifiedTokenBlocked":true,"toolOutputMasked":true,"localDisplayRestored":true,"assistantHistoryMasked":true}
{"mode":"rewrite","upstreamRequests":1,"exit":0}
{"mode":"throw","upstreamRequests":0,"exit":1}
{"mode":"reject","upstreamRequests":0,"exit":1}
{"mode":"disabled","upstreamRequests":0,"exit":1}
{"validProof":true,"replayBlocked":true,"tamperBlocked":true,"unsupportedRouteBlocked":true,"missingProofBlocked":true}
{"directBypass":"UNCONTAINED","releaseGate":"BLOCKED"}
```

The full baseline passed 62 test files and 1,772 tests. TypeScript, build and package dry run also passed. Graph impact analysis reported LOW risk for the reused Core factory. Change analysis reported low risk for the research files. The index warned that process enumeration had incomplete coverage and that its FTS extension was unavailable. These graph results supplement the runtime tests.
