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

Neither `wireProtection` setting changes this tool gate. The source of OpenCode's built-in `execute` tool (Code Mode, input `{code}`) is not restored: it is JavaScript, and placeholders are restored when the code calls a tool, under that tool's field rules; a placeholder in the source stays literal. `execute` source holding a mapped placeholder together with `fetch` is refused, so that a failed call cannot be read as a verdict on the value; this is a text match, not a network control, so other spellings are not caught and then send only the placeholder. JavaScript that computes on a placeholder (length, encoding) sees the placeholder and gets no error. A value recognisably derived from a placeholder of this session but with its format changed (brackets dropped, separators or case altered) is refused rather than passed on; a partially masked value, or one the model replaced entirely, cannot be detected and reaches the tool as written. Verified on OpenCode v2.2.5 only. Restoration is decided per field. Every field of a shell tool (a built-in name list, or a tool name containing a segment such as `bash`, `shell`, `zsh`, `pwsh`) gets shell rules, and in any tool a field named like a command (`command`, `cmd`, `commands`, `argv`, `shell`, ...) does too. In fields named `code`, `script` and similar, only placeholders matching a restricted single-line string rule are restored. This is a conservative heuristic, not cross-language syntax verification, and it can both over-refuse and miss. A refused call is blocked, not masked: the tool does not run and the input keeps its placeholder. Refused forms are bare placeholders, interpolation regions (`f"{...}"`, `${...}`, `$(...)`), backtick strings, multi-line strings (including any line that contains a triple quote), lines after a backslash continuation, comments, and originals containing shell-unsafe characters (spaces included). A script with a balanced docstring above the assignment still works. To rewrite, put the placeholder in a plain quoted string with no interpolation, on a single line outside any multi-line string or line continuation and reference the variable. When rewriting, copy the placeholder exactly as it appears in the conversation, including its brackets. This is not egress protection: a program can still print, send or re-interpret the restored value, and language structures not listed here (for example Ruby `%q`) may be misjudged. Descriptive fields (`description`, `title`, `label`) and all other fields restore verbatim. An executing tool that uses any other field name is not detected. The shell-tool list is built into LeakShield's source and is not configurable.

## Restart limitation

Applies to both levels.

Replayed originals can establish new mappings, but old tokens cannot be reconstructed from token text. Some provider tool-call arguments remain tokenized when published to history, even though the local execution gate restores them before execution. Thus complete token-free history and seamless restart recovery are not established; an unresolved write/execute argument still refuses with no side effects.

Local originals may remain in history, logs, and generated files — this protects the model boundary, not your disk.
