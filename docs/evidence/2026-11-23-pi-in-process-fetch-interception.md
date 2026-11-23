# pi 1.6.0: in-process fetch interception from an extension

Date: 2026-11-23. Related: #98, PR #100.

> 後續：PR #100 最後採用本文驗證的 in-process fetch 邊界，不再使用 proxy 與啟動器。開頭的 proxy 設計是當時的起點。

## Question

PR #100 protects pi with a loopback proxy and a managed launcher. It chose that design for two reasons: `before_provider_request` keeps the original payload when a handler throws, and compaction requests skip that hook. This record checks a third option that #100 did not try. Like the OpenCode wire protection, an extension could replace `globalThis.fetch` inside the pi process and guard every provider request there, with no proxy.

## Setup

- `@earendil-works/pi-coding-agent@1.6.0` installed with `--ignore-scripts`, Node 24.22.3.
- Real `pi` process, `--offline --no-extensions --extension <probe>`, and a loopback stub provider configured in `models.json`. The synthetic value `PI98_PRIVATE_VALUE` is sent as both the system prompt and the user prompt.
- [`pi-fetch-probe/fetch-ext.mjs`](pi-fetch-probe/fetch-ext.mjs) wraps `globalThis.fetch` when the module loads. It replaces the value with `[MASKED]`. If masking throws, it returns a local 400 response and never calls the real fetch.
- Reproduce with `node docs/evidence/pi-fetch-probe/probe.mjs <path-to-pi>`.

## Observations

| Case | Requests reaching the stub | Original value at the stub |
|---|---|---|
| `openai-completions` | 1, `/v1/chat/completions` | no (masked) |
| `anthropic-messages` | 1, `/v1/messages?beta=true` | no (masked) |
| `openai-responses` | 1, `/v1/responses` | no (masked) |
| Forced masking error | **0**. pi prints `400: LeakShield refused: forced mask failure` and exits 1 | n/a |
| Manual compaction (RPC `compact`, with the value in `customInstructions`) | 4: 2 prompts + 2 summarization | no (all masked) |

In the anthropic and responses cases pi exits 1 because the stub's SSE stream is incomplete ("stream ended without a stop reason"). The stub records the request body before it sends any reply, so this does not affect the masking result.

From the source: the OpenAI and Anthropic SDK clients get `fetch: options?.fetch` and fall back to the global fetch. They are created during a request, after extensions have loaded. The Google clients pass `fetch ?? globalThis.fetch` explicitly.

## Conclusion

For the routes tested, an extension that replaces `globalThis.fetch` closes both gaps that drove #100 to a proxy:

- A masking error is caught inside our own fetch and turned into a refusal, so it fails closed.
- Compaction goes through the same fetch.

This makes an extension-only adapter worth evaluating. It would need no launcher, no proxy and no credential brokering.

## Not verified

- Bedrock (AWS SDK HTTP handler, probably not fetch) and any WebSocket transport (Codex/Responses `transport`). These would have to be refused.
- Other code paths that bypass `globalThis.fetch`, such as direct `undici` or `node:http` calls. The bundle has not been audited for them yet.
- Extension load order: an extension loaded earlier could keep the original fetch.
- Response restoration, streaming, tool argument restoration and the session mapping lifecycle. Only the outbound side was tested.
- Automatic compaction, branch summarization and title generation.
- If the extension is not loaded, there is no protection. This is the same as the OpenCode plugin not being registered, so doctor has to report it.
