# Native WebSocket (experimental)

> 🌐 English | [繁體中文](./websocket.zh-TW.md)

[← OpenCode plugin](../opencode.md)

Responses-family only.

`/responses` over `ws:`/`wss:` accepts flat `response.create` frames, regardless of provider brand, and restores supported display deltas split across frames. Request masking reuses the HTTP Responses masker; function-call argument frames remain tokenized until the local tool gate, and encrypted reasoning stays opaque. Continuation IDs are preserved, not remasked.

Different dialects/extensions are not automatically supported. OpenCode exposes no connection ID: state is isolated by session, request kind and model, then response ID and content channel. New handshakes/model switches, HTTP fallback, rejected frames and disposal invalidate old state; terminal frames release buffers.

Frames, channels and aggregate buffering are bounded. A provider that omits the final text delta leaves a static warning: the complete `.done` text is restored without replacing that event with a synthetic delta, so delta-only consumers may show an incomplete reply. Unknown display tokens remain literal; unsafe or unknown write-tool mappings still refuse.

The existing native OpenAI HTTP preference is retained for compatibility; explicit WS settings now work on supported routes. This is not a system network firewall or support for every WS provider. See [verification and limitations](../evidence/2026-10-11-responses-ws-verification.md).
