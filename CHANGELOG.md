# Changelog

All notable changes are listed here.

## Unreleased

### Changed

- Releases ship the npm package only (the OpenCode plugin and the `leakshield` CLI). Standalone binaries are no longer attached; run the `Build binaries` workflow manually and download one from its artifacts when needed.

### Fixed

- `npm publish` no longer warns that the `bin` entry is invalid. The path is now `dist/cli.js` instead of `./dist/cli.js`; npm 11 rewrote the old form at publish time, and 0.1.0 still installs the `leakshield` command.

## 0.1.0 — 2026-10-16

The first release. It is `0.1.0` rather than `1.0.0` because defaults may still change during 0.x.

### Added

- OpenCode V2 **transparent pseudonymization** (`mode: "transparent"`, the v2 default; see Changed): sensitive values become stable placeholders like `[SGP2:API_KEY-xxxx-xxxx-xxxx]` before model requests and are restored in tool inputs and assistant replies. Chat Completions, Anthropic Messages, Responses (HTTP/SSE and native WebSocket) and AI SDK injected fetch. `wireProtection: false` is a pure hook-only mode. ([#23](https://github.com/jwcrystal/leakshield/pull/23))
- Opt-in encrypted mapping persistence (AES-256-GCM SQLite, TTL, `--forget`), with a doctor check. Needs Node 22.13+. (#23)
- Per-rule toggles via `settings.rule_overrides`; validated credit card (Luhn), IBAN (mod-97) and public IPv4 rules; an opt-in URL rule. (#23)
- CI running `tsc --noEmit` and the test suite on pull requests; host E2E runners and a plugin comparison harness. (#23)
- `--help` / `-h` lists every mode and flag. Before this, `--help` was ignored and the CLI waited on stdin.

### Changed

- **Renamed to LeakShield.** The unscoped npm name `sensitive-guard` belongs to another package. Everything moves to `leakshield` with no compatibility aliases, since nothing has been released: the package and `leakshield` bin, the OpenCode plugin id, the `leakshield-ignore` directive, `LEAKSHIELD_LANG`, the `~/.leakshield/` config directory, the keychain service and mapping store directory (`~/.local/share/leakshield/`), the `x-leakshield-refusal` header and `leakshield_transport_refusal` code, binary names, and the GitHub repository (`jwcrystal/leakshield`). The `[SGP2:…]` placeholder format is unchanged.
- **The OpenCode v2 plugin defaults to `mode: "transparent"`** when its options omit `mode`. OpenCode v1 still defaults to `block`, since transparent is v2-only. Set `"mode": "block"` to refuse instead of pseudonymize. With the default, `envQueries` is rejected, so set `mode` explicitly to use it. `--doctor` marks a default mode as `(default)`.

These also affect the CLI, Web UI and block mode:

- Phone rules (`phone-tw`, `phone-intl`) are **off by default**; enable them with `rule_overrides`. (#23)
- Credit card, IBAN and public IPv4 rules are **on by default**, so text containing them is now flagged. (#23)
- ASCII NDA keywords match whole words (`NDA` no longer matches `agenda`); CJK keywords still match as substrings. (#23)
- Unknown ids in `settings.rule_overrides` fail the config load. (#23)
- Zero-width characters are flagged only when they hide a value the rules would otherwise detect; emoji ZWJ sequences, a BOM, ZWNJ and ZWSP between words no longer flag or refuse. A key split by a word joiner (U+2060) is now caught. ([#29](https://github.com/jwcrystal/leakshield/pull/29))
- `package.json` declares `exports`, so only the package root (the OpenCode plugin) and `leakshield/package.json` can be imported; deep imports such as `leakshield/dist/opencode.js` fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Registering the plugin by a `dist` path or `file://` URL still works.
- Release binaries are built from `src/cli.ts` (the CLI entry) instead of `src/index.ts`, which is now the plugin entry. (#23) The macOS Intel binary is cross-compiled on an arm runner, since GitHub retired `macos-13`.

### Removed

- MCP server mode (`scan_text`, `scan_file`, `scan_dir`, `reload_config`). It relied on the model calling a scan tool after the content had already reached it; use the OpenCode plugin, the CLI, or the Web UI instead.

### Security

- Known: `@opencode-ai/plugin` depends on `effect`, which pulls in a `toml` version with 3 high advisories (GHSA-82x6-q7mm-w9cf). LeakShield never parses user-supplied TOML, so the exposure should be low; it waits on an upstream fix.
- Transparent mode is verified against loopback providers and one real OpenAI model. Real OS keychains, a real Anthropic provider and long-history replay on other providers are not verified yet ([#26](https://github.com/jwcrystal/leakshield/issues/26)). Routes it cannot protect are refused, not forwarded.
- `js-yaml` raised to `^4.3.2` to pick up fixes for quadratic-CPU DoS advisories in merge-key and `!!omap` handling (GHSA-h67p-54hq-rp68, GHSA-52cp-r559-cp3m, GHSA-5p4m-2wfm-xmqj, GHSA-2883-xcg3-v3hh). The config loader parses YAML with it.

### Fixed

- Long-history replays failed with `invalid_encrypted_content` because provider-opaque reasoning state was masked; it is now replayed byte-for-byte. (#23)
- Large histories and more than 128 sessions per guard hit `operation_limit` / `session_limit`; transparent mode now has a bounded 8 Mi-unit / 4,096-session budget and reclaims deleted sessions. (#23)
