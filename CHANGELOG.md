# Changelog

All notable changes are listed here. The project has no tagged release yet; `package.json` still says `1.0.0`.

## Unreleased

### Added

- OpenCode V2 **transparent pseudonymization** (`mode: "transparent"`, opt-in; the default `mode` is still `block`): sensitive values become stable placeholders like `[SGP2:API_KEY-xxxx-xxxx-xxxx]` before model requests and are restored in tool inputs and assistant replies. Chat Completions, Anthropic Messages, Responses (HTTP/SSE and native WebSocket) and AI SDK injected fetch. `wireProtection: false` is a pure hook-only mode. ([#23](https://github.com/jwcrystal/sensitive-guard/pull/23))
- Opt-in encrypted mapping persistence (AES-256-GCM SQLite, TTL, `--forget`), with a doctor check. Needs Node 22.13+. (#23)
- Per-rule toggles via `settings.rule_overrides`; validated credit card (Luhn), IBAN (mod-97) and public IPv4 rules; an opt-in URL rule. (#23)
- CI running `tsc --noEmit` and the test suite on pull requests; host E2E runners and a plugin comparison harness. (#23)

### Changed

These also affect the CLI, Web UI and block mode:

- Phone rules (`phone-tw`, `phone-intl`) are **off by default**; enable them with `rule_overrides`. (#23)
- Credit card, IBAN and public IPv4 rules are **on by default**, so text containing them is now flagged. (#23)
- ASCII NDA keywords match whole words (`NDA` no longer matches `agenda`); CJK keywords still match as substrings. (#23)
- Unknown ids in `settings.rule_overrides` fail the config load. (#23)
- Zero-width characters are flagged only when they hide a value the rules would otherwise detect; emoji ZWJ sequences, a BOM, ZWNJ and ZWSP between words no longer flag or refuse. A key split by a word joiner (U+2060) is now caught. ([#29](https://github.com/jwcrystal/sensitive-guard/pull/29))
- Release binaries are built from `src/cli.ts` (the CLI entry) instead of `src/index.ts`, which is now the plugin entry. (#23)

### Removed

- MCP server mode (`scan_text`, `scan_file`, `scan_dir`, `reload_config`). It relied on the model calling a scan tool after the content had already reached it; use the OpenCode plugin, the CLI, or the Web UI instead.

### Fixed

- Long-history replays failed with `invalid_encrypted_content` because provider-opaque reasoning state was masked; it is now replayed byte-for-byte. (#23)
- Large histories and more than 128 sessions per guard hit `operation_limit` / `session_limit`; transparent mode now has a bounded 8 Mi-unit / 4,096-session budget and reclaims deleted sessions. (#23)
