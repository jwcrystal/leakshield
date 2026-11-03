# Transparent mode

> 🌐 English | [繁體中文](./transparent-mode.zh-TW.md)

[← README](../../README.md#opencode-plugin-recommended)

## Transparent pseudonymization

OpenCode v2 only — the v2 default.

Omit `mode` or set `"mode": "transparent"` to replace detected sensitive values in model-request snapshots with stable opaque placeholders — category-labelled `[SGP2:<TYPE>-xxxx-xxxx-xxxx]` (the legacy `[SGP1:…]` shape stays recognized for restoring pre-upgrade in-session mappings). Reverse mappings are scoped to the OpenCode session and stay in process memory by default; encrypted persistence is opt-in ([Mapping persistence](persistence.md)). Known placeholders are restored in tool inputs before execution and in supported assistant response text.

Supported HTTP protocols are selected by URL path shape: Chat Completions, Anthropic Messages, and Responses, including streaming. Native Responses-family WebSocket is also supported as described in [Native WebSocket](websocket.md). Wire-mode SDKs honoring injected fetch use the same request-scoped HTTP hooks.

Hook-only protects content snapshots without transport admission; it does not add adapters for unknown protocols. Transparent mode has been verified against loopback providers and one real OpenAI model; OS-keychain custody is verified on macOS only, and a real Anthropic provider, long-history replay on other providers and Windows/Linux keychains are not verified yet ([#26](https://github.com/jwcrystal/leakshield/issues/26)). Routes it cannot protect are refused, not forwarded.

## Encoded content and tool schemas

In transparent mode, a Base64, hex or URL-encoded run that decodes to a finding is masked whole as `[SGP2:ENCODED-…]` when its source span can be located exactly; otherwise the request is refused.

In transparent mode, schema annotation prose (a `description`/`title` value inside a tool input schema) that trips a scanner rule is masked to a pseudonym token like any other content; identifier positions (tool names, property keys, enum/const values, regex patterns) still refuse the whole request rather than being renamed.

## Shell argument restoration

On macOS/Linux POSIX shells, a known placeholder may occupy a complete unquoted, single-quoted, or double-quoted argument. Existing quotes are preserved, and originals must be safe in that quote context; quoted space-containing values remain one argument. A single trailing `>`/`>>` redirect to a static literal filename is supported.

Command/assignment positions, tokenized redirect filenames, expansions, quote concatenation, pipelines, inline scripts, quote-breaking originals, and leading-option values still refuse the affected tool call before mutation. Token-free commands are unchanged. The new quoting/redirect support is not enabled on Windows; it is not a general shell parser.

Neither `wireProtection` setting changes this tool gate.

## Restart limitation

Applies to both levels.

Replayed originals can establish new mappings, but old tokens cannot be reconstructed from token text. Some provider tool-call arguments remain tokenized when published to history, even though the local execution gate restores them before execution. Thus complete token-free history and seamless restart recovery are not established; an unresolved write/execute argument still refuses with no side effects.

Local originals may remain in history, logs, and generated files — this protects the model boundary, not your disk.
