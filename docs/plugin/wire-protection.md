# Wire protection

> 🌐 English | [繁體中文](./wire-protection.zh-TW.md)

[← README](../../README.md#opencode-plugin-recommended)

## Hook-only

For new transparent installs, use [the hook-first configuration example](../../config/opencode.hook-first.example.json), which explicitly sets `wireProtection: false`. Content hooks protect system/messages/options/tools and the tool gate restores safe known arguments. LeakShield registers **no outbound HTTP request, WS handshake/send, or AI SDK admission hooks**, does not inspect transport metadata, and does not change provider transport settings.

Unknown routes and private SDK transports do not incur LeakShield transport refusals. Optional incoming HTTP/WS hooks restore supported display text using successful preparation for the same session/kind/model; missing hooks or restoration failures leave placeholders literal without disabling input protection. Later-added content or attachments may leave unmasked, even with `attachments: "block"`.

The doctor reports `PARTIAL`, not full-wire protection. **Content-hook masking failures still refuse the affected call**, now including a safe `[stage=prepare.mask reason=…]` code; hook-only does not silently forward unprotectable raw content. See [hook-only verification](../evidence/2026-10-11-pure-hook-only-verification.md).

## Final wire protection

Set `wireProtection: true` to additionally validate/remask the final HTTP request body or supported WS outbound frame content; unknown routes and unknown/mixed body shapes refuse before dispatch. Tool safety and reply-side recovery are identical in both levels. For compatibility, **omitting `wireProtection` retains this stronger legacy behavior**.

With the v2 default (`mode: "transparent"`, `wireProtection` omitted) this stronger level is on; only the hook-first example chooses false explicitly. The option is valid only in transparent mode.

## AI SDK providers

With `wireProtection: true`, providers must honor OpenCode's injected `options.fetch`; request-scoped HTTP hooks provide attribution and wire enforcement without a provider-brand allowlist. The wrapper checks HTTP/HTTPS and supported paths; missing/accessor/nonwritable fetch options refuse. With false, LeakShield installs no SDK wrapper and imposes none of those transport requirements; only content/tool hooks and optional ingress restoration apply.

Bypass transports are **outside final-wire coverage**, not guaranteed blocked. Commandcode `/alpha/generate`, including Go/403 fallback, is untouched in false and refused in true; there is no legacy response adapter. Arguments, abort signals and real provider failures remain host-owned.

## Wire refusals

In wire mode, the wrapper represents its route/content refusals as a **local HTTP 400 error response**, with `error.code: "leakshield_transport_refusal"` and a content-free WARN. Rejected requests do not reach the network. Hook-only has no such wrapper or transport admission.

SDKs can distinguish a refusal from a retryable network failure; genuine network errors, aborts and provider responses remain unchanged. Responses easy-input messages may omit `type: "message"`; recognized roles and supported content are masked without inserting a type into their wire body.

## Reply-side recovery

Applies to both levels.

LeakShield attribution or JSON/SSE/WS restoration failures stop LeakShield rewriting rather than interrupting the host's response. Unattributed replies stay original; no session/model mapping is guessed. SSE keeps a bounded transaction of undelivered original events, releases them in order on failure, then passes subsequent bytes through without duplicates or dropped tails.

Provider error events are released immediately; upstream errors and consumer cancellation still propagate. This can show literal placeholders, and invalid provider data may still fail in OpenCode. Tool arguments still pass the unchanged safety gate.

WS can replace only one frame, not replay multiple held channels; see the documented WS limitations and [recovery evidence](../evidence/2026-10-11-experience-first-verification.md).

## Native OpenAI transport

Wire mode retains an HTTP preference for native OpenAI providers; explicit provider configuration has higher precedence. Hook-only makes no provider transport transformation. Supported Responses-family WS ingress can restore display deltas without LeakShield handshake/send registrations, starting from a validated `response.created` in a prepared session/kind/model scope.

No endpoint, credential, or persisted configuration is changed. Real subscription authentication and complete restart recovery remain separate from local capture evidence.
