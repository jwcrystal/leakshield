# pi 1.6.0: extension-only fetch guard, gap audit

Date: 2026-11-23. Related: #98, PR #100. Follows
`2026-11-23-pi-in-process-fetch-interception.md`, which showed that wrapping
`globalThis.fetch` from an extension masks the three wire formats and manual
compaction. That record left four items unverified for an extension-only
adapter: fetch-bypassing transports, extension load order, automatic
compaction and titles, and response/tool restoration.

This audit closes the first three. Restoration (response, streaming, tool
arguments, session mappings) is adapter work, not a transport question, and
stays out of this record.

## Setup

- `@earendil-works/pi-coding-agent@1.6.0`, npm, `--ignore-scripts`, Node 24.22.3.
- A loopback stub provider records every request body. The canary
  `PI98_PRIVATE_VALUE` is passed as both `--system-prompt` and the user prompt,
  so every provider request carries it.
- `gap-guard-ext.mjs` replaces `globalThis.fetch` at module load, masks the
  canary, logs each call, and records whether `globalThis.fetch` is still the
  guard at process exit.
- `watch.cjs` is preloaded with `NODE_OPTIONS=--require` and patches
  `net.Socket.prototype.connect`, logging every outbound host and port. This
  sees undici, `node:http` and any other socket, not only `fetch`.
- Scripts: `gap-probe.mjs`, `autocompact-probe.mjs`, `order-probe.mjs`,
  `early-ext.mjs`, `gap-guard-ext.mjs`, `watch.cjs` in this directory.

## 1. Wire routes: stub requests and guard calls match

| Route | Stub requests | Original value at stub | Guard calls | Other outbound hosts |
|---|---|---|---|---|
| `openai-completions` | 1 | no | 1 | none |
| `anthropic-messages` | 1 | no | 1 | none |
| `openai-responses` | 1 | no | 1 | none |

`openai-responses` exits 1 because the stub SSE has no terminal response event;
the request was recorded before any reply. The earlier record covers the same
exit for anthropic and responses.

One connection to the stub, one guarded call, no other host: on these routes
the `fetch` wrapper sees every connection the run makes.

## 2. Startup does not overwrite the guard

`dist/bundle/cli-runtime.js` calls `setupCli()` before `main()`, and
`setupCli()` calls `configureHttpDispatcher()` (`dist/core/http-dispatcher.js`).
At that point `globalThis.fetch` is untouched, so `undici.install()` replaces it
with undici's fetch. Extensions load later, so the guard wraps undici's fetch.

A later `configureHttpDispatcher()` call only reinstalls when
`globalThis.fetch` is the implementation it installed; the guard is not, so it
is preserved. Runtime: `finalFetchIsGuard: true` in every run, including the
compaction run with three provider requests.

## 3. Automatic compaction goes through the guard

Settings: `compaction { enabled: true, reserveTokens: 100, keepRecentTokens: 50 }`,
stub model `contextWindow: 700`, two RPC prompts.

- `compaction_start` and `compaction_end`, both `reason: "threshold"`; the
  summary was produced.
- 3 provider requests, 3 guard calls, all masked, no original value at the stub.

## 4. Branch summarization and titles

- Branch summarization calls `completeSummarization()` in
  `dist/core/compaction/branch-summarization.js:237`, the same function the
  verified automatic compaction used. It inherits the same transport.
  It was not triggered at runtime: `/tree` navigation has no RPC command, and
  `completeSummarization` is only reachable through the TUI flow.
- pi 1.6.0 has no LLM title generation. Session names are user-set (RPC
  `set_session_name`); the terminal title is UI-only. There is no extra provider
  request to cover.

## 5. Extension load order decides whether an earlier extension is covered

Load order is declaration order within one source, and CLI `-e` extensions load
before `settings.extensions`, regardless of which source lists what first.

| Declaration | Load order | Request from the early extension |
|---|---|---|
| `-e early -e guard` | early, guard | original value reaches the stub |
| `-e guard -e early` | guard, early | masked |
| settings `[early, guard]` | early, guard | original value reaches the stub |
| settings `[guard, early]` | guard, early | masked |
| settings `[early]` + `-e guard` | guard, early | masked |
| `-e guard` + settings `[early]` | guard, early | masked |

An extension that runs before the guard can keep the fetch it saw at load, and
anything it sends through that reference bypasses the guard. An extension that
runs after the guard sees the guard and is covered.

Consequence for the adapter: the guard should be the first extension loaded
(CLI `-e` is enough, or `settings.extensions[0]`). pi's own requests are guarded
at any position; the risk is only another extension's traffic. The guard cannot
detect an earlier holder of the raw fetch, so the doctor checks the configured
order and reports a later position as partial rather than protected.

## 6. Transports the guard cannot see

Static audit of the bundle, plus the provider selection:

| Path | Transport | Guard sees it | Disposition |
|---|---|---|---|
| `openai-completions`, `anthropic-messages`, `openai-responses` | `options.fetch ?? globalThis.fetch` at request time | yes | supported |
| `openai-codex-responses` | WebSocket (`transport: auto \| sse \| websocket`) | no | refuse the provider |
| `bedrock-converse-stream` | `@smithy` node:http/https handlers, http2, IMDS over node:http | no | refuse the provider |
| Google provider auth (service account, Vertex credentials) | `google-auth-library`, gaxios, node-fetch | no | credential traffic only; Google is outside the three supported APIs |
| OAuth login and refresh | `fetch` defaulted at call time | mostly | out of scope; OAuth-only accounts are unsupported |

`ctx.model.api` is available to the extension, so the refusal can be enforced
before a run starts rather than only documented.

## Conclusion

- For the three supported wire formats, automatic compaction and branch
  summarization all go through the wrapped `fetch`; a masking error is turned
  into a refusal by the wrapper itself.
- Extension load order is the one real condition: LeakShield must load first,
  and the doctor must verify it.
- The bypassing transports are separate API types, and the model's API is
  readable at session start, so "refuse what the guard cannot see" is
  implementable without a proxy.

## Not verified

- Branch summarization at runtime (`/tree` has no RPC command).
- Bedrock, Codex WebSocket and Google at runtime; only the code paths were read.
- Non-string `Request` bodies, retries, streaming responses, response and tool
  restoration, session mapping lifecycle.
- Windows.

## Reproduce

```sh
runtime="$(mktemp -d)"
npm install --prefix "$runtime" --ignore-scripts --save-exact @earendil-works/pi-coding-agent@1.6.0
cd docs/evidence/pi-fetch-probe
node gap-probe.mjs "$runtime/node_modules/.bin/pi"
node autocompact-probe.mjs "$runtime/node_modules/.bin/pi"
node order-probe.mjs "$runtime/node_modules/.bin/pi"
```
