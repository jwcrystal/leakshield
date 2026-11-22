# Core-owned wire protection and shared mapping experiment

The new loopback wire proxy resolves the tested manual compaction gap. Actual pi 1.6.0 compaction completes successfully and both summarization requests contain only masked values. A single Core instance in the proxy owns the mapping used by extension preparation, local display and tool restoration.

The overall #98 release gate remains blocked by direct-provider configuration and the remaining coverage gaps. This experiment covers one ephemeral managed session on an OpenAI-compatible loopback endpoint.

## Reproduce

Build LeakShield and install the pinned pi 1.6.0 runtime using the [lab setup](README.md). Run from the repository root.

```sh
node docs/evidence/pi-lab/run-wire.mjs "$runtime/node_modules/.bin/pi"
```

The script starts an authenticated loopback proxy and a recording stub, then launches actual pi processes with isolated settings and synthetic credentials. It exercises real manual compaction through RPC with keepRecentTokens=1 and auto compaction disabled. Exit 0 means all assertions matched, including the expected direct-route exposure.

## Implementation

wire-proxy.mjs creates one Core through the exported leakshield/core API. Its sole provider route is POST /v1/chat/completions, its sole allowed model is stub-model, and its fixed upstream destination must be loopback HTTP. Every provider request runs Core.onHttpRequest before fetch. The proxy preserves masked provider replies in the model-facing stream.

The paired wire-extension.mjs calls authenticated loopback control endpoints for preparation, local diagnostic display and read-tool restoration. These control endpoints use the same Core instance and session identity as wire protection. No mapping snapshot is copied between processes. A separate proxy instance has a separate session identity and rejects the first instance's token at its tool boundary.

The proxy generates a random per-instance bearer credential used for provider and control calls. Requests over 1 MiB, unknown routes/models, unsupported input structures, Core masking failures and unauthorized calls are refused before upstream fetch. The read tool accepts only its flat documented fields, validates optional numeric offset/limit, and refuses other tools or modified/unknown tokens.

The original HMAC proof protocol remains in the older fixtures for comparison. This wire experiment replaces that protocol with independent Core masking at the proxy. A hook failure or disabled extension can therefore still produce a successful request after the proxy masks it. A proxy masking failure always prevents forwarding.

## Actual pi results

| Scenario | Upstream observations | Outcome |
| --- | --- | --- |
| Normal prompt | 1 masked request | CLI exit 0 |
| Hook throws | 1 masked request | CLI exit 0 |
| Hook rejects | 1 masked request | CLI exit 0 |
| Extension disabled | 1 masked request | CLI exit 0 |
| Proxy masking throws | 0 requests | CLI exit 1 |
| Proxy masking rejects | 0 requests | CLI exit 1 |
| Normal manual compaction | 2 masked normal requests and 2 masked summarization requests | RPC success=true |
| Proxy masking throws during compaction | 2 earlier masked prompts, zero summarization requests | RPC success=false, proxy HTTP 400 |
| Proxy masking rejects during compaction | 2 earlier masked prompts, zero summarization requests | RPC success=false, proxy HTTP 400 |
| Shared mapping, read/display/history | 3 masked model requests | Real read succeeds, diagnostic restores value, assistant history stays masked |
| Direct baseUrl with extension disabled | 1 request containing original canary | Exposure remains, CLI exit 0 |
| Proxy unavailable | 0 upstream requests | CLI exit 1 |

The shared-mapping test makes the stub return a tool call with the minted placeholder as a filename, reads the real local file, verifies the masked tool result at the provider, restores the streamed placeholder into a local diagnostic display, then sends a follow-up turn and checks assistant history.

## Negative and streaming checks

Direct authenticated calls test malformed JSON, unknown routes and models, unknown wire shapes, Core's real per-string scanner limit, modified placeholders, unknown tools, invalid nested read fields and foreign-session tokens. All are refused with zero upstream requests. An incorrect bearer credential is also refused.

The streaming check holds the upstream SSE connection open after its first event. The proxy client receives that event before the test releases the upstream to finish. This verifies incremental forwarding through the proxy.

## Limits

This remains an isolated synthetic lab, with session identity scoped to the lifetime of one proxy instance. It does not implement persistent mappings, pi interactive rendering, a production launcher, managed credential storage or network routing enforcement. Other provider protocols, real authenticated services, automatic compaction, branch summaries, additional background paths, custom tools and write/edit/shell restoration remain unverified.

Direct provider configuration still bypasses the proxy. The next release gate requires an enforced managed route and verification of the supported production scope. The earlier [routing report](routing-verification.md) records the failure of the proof-only proxy before this experiment.
