# Changelog

All notable changes are listed here.

## Unreleased

### Fixed

- A transparent-mode request refused because content exceeded `settings.max_chars` now says so. The refusal carried only `reason=truncated_content`; it now names the configured bound and asks to raise it or split the content. Nothing is sent unscanned either way, and the limit's documentation no longer says "truncate", which is what the standalone scanner does, not transparent mode. ([#47](https://github.com/jwcrystal/leakshield/issues/47))

## 0.1.3 — 2026-11-03

Mostly fewer false refusals in transparent mode. Three changes narrow detection on purpose and can affect an existing setup: `generic-secret` skips code expressions, `credit-card` skips repeated digits and digits inside a UUID, and `url-userinfo` and `db-connection` skip placeholder passwords. Cyrillic or Greek look-alikes are now reported only when folding them to Latin reveals a finding. The `custom_rules` options below were listed under 0.1.2 by mistake; they ship in this release. Run `leakshield --doctor` after upgrading.

### Added

- `custom_rules` entries accept `flags`, `word_boundary`, `allow` and (reserved) `path`, and `settings.allowlist` adds a global exact-match bypass. `flags` must be a subset of `gimsuy` (`g` is implied, `i` stays the default) and the pattern is compiled with its final flags, so an invalid combination fails the config load. `word_boundary` adds `\b` only at literal ASCII word edges: CJK edges and escaped edges are left alone, an edge that is a group, class or quantifier gets no boundary and `--doctor` warns that the rule is looser than it looks, and a top-level alternation is refused. Allowlists are exact-string only (32 per rule, 64 global, 200 chars each), are surfaced by `--doctor` (which exercises up to eight entries and reports entries it cannot exercise), and are counted when they suppress. `path` is accepted and validated but does not scope yet; `--doctor` says so. ([#32](https://github.com/jwcrystal/leakshield/issues/32))

### Fixed

- Transparent mode no longer refuses a string because a detected value also appears somewhere the rules did not report it. Most rules depend on context (`\b` boundaries, validators that look at neighbours), so `1318289051000.1` can be a finding while `1318289051000n` is not, and the absence check then refused the whole request with `residual_sensitive_content`. Those occurrences are now masked with the same token, which masks strictly more; an occurrence that overlaps another finding, a token or a preserved marker still refuses. In a simulation of OpenCode `read` pages over 22,626 package files, this was 5 of the 6 refused pages. This also covers repeats across strings of one JSON request (the whole OpenCode request): a value detected in one message masks its undetected repeats in the others, with one retry when the repeat comes first. ([#52](https://github.com/jwcrystal/leakshield/issues/52))

- Three built-in rules no longer report ordinary source code as secrets. `generic-secret` skips an unquoted value that is a code expression: an env or config member read (`process.env.DB_PASSWORD`, `config.clientSecret`, `os.environ["DB_SECRET"]`) or a call chain (`z.string().min(6)`, `getPassword()`). A call whose arguments hold any other string literal (`decrypt("hunter2hunter2")`) is still reported, and so is a bare `word.word` value. `credit-card` skips a run of one repeated digit and digits inside a UUID. `url-userinfo` and `db-connection` skip a URL whose password is a `${…}`, `{{…}}` or `<…>` placeholder. On 1,410 files from installed packages this cut findings from these four rules from 182 to 58; the rest are literal values such as `password: "aaaaaaaa"`. ([#49](https://github.com/jwcrystal/leakshield/issues/49))

- Cyrillic or Greek text no longer refuses a transparent-mode request on its own. The homograph check used to flag any text that contained a word like `key`, `token` or `api` together with three Cyrillic or Greek letters (or one Cyrillic look-alike), so locale files, Russian comments and Greek math were refused as `unicode_evasion`. Look-alike letters are now folded to Latin and the text is rescanned, the same way zero-width characters are handled; only a finding that appears after folding is reported, as HIGH. On 1,410 files from installed packages this removed 27 of 35 refusals. ([#46](https://github.com/jwcrystal/leakshield/issues/46))

- Scanning and redaction now advance safely past zero-length regex matches, including Unicode matches next to surrogate pairs. Empty spans produce no finding or replacement; later nonempty matches remain protected. Previously a custom rule such as `\p{ASCII}*` with `flags: "u"` passed configuration validation but could hang both operations. (#32)

## 0.1.2 — 2026-10-22

Two changes can affect an existing setup: `url-userinfo` is on by default, so text with a `user:password@` URL is now flagged, and a `custom_rules` pattern that does not compile now fails the config load instead of being skipped. Run `leakshield --doctor` after upgrading.

### Added

- `url-userinfo` reports the `user:password@` span of an authenticated `scheme://` URL as a HIGH SECRET finding. Only the userinfo is masked; the scheme and host stay readable, and the span is no longer mislabelled as an email address. ([#34](https://github.com/jwcrystal/leakshield/issues/34))
- `private-ipv4` reports RFC 1918, CGNAT and link-local addresses as `PII_IP`. It is opt-in (`rule_overrides["private-ipv4"]: true`) because address literals also match version numbers and timestamps. `settings.private_cidrs` narrows the rule to an organisation's own networks; an entry that does not parse fails the config load. ([#31](https://github.com/jwcrystal/leakshield/issues/31))

### Fixed

- A dotted run longer than four octets is now reported whole (`10.1.2.3.4` masks the whole run), so an address embedded in it is no longer left unmasked. Before, the pattern consumed the first four groups, the public `1.2.3.4` suffix escaped detection, and transparent mode refused the whole request with `residual_sensitive_content` once the same address appeared elsewhere. ([#40](https://github.com/jwcrystal/leakshield/issues/40))
- An SSH Git remote (`user@host:path`, `ssh://user@host/…`, `git+ssh://…`) is no longer reported as `PII_EMAIL`. A public repository host is no longer pseudonymized for no privacy gain, and the password half of a remote URL is no longer classified as personal data. Configured private domains and path keywords still apply inside remote URLs. (#34)

### Changed

- A `custom_rules` pattern that does not compile now fails the config load, naming the rule's index and `description`. Before, the rule was skipped with one stderr line and the scan still reported `safe: true`. ([#33](https://github.com/jwcrystal/leakshield/issues/33))
- `leakshield --doctor` lists custom rules skipped by the ReDoS timing check as a `custom-rules` warning. The check is a heuristic, not a guarantee; the README now says so. (#33)
- The unresolved-placeholder refusal now states that the tool did not run, asks for the arguments to be rebuilt from current references, and says plainly that rereading does not validate an old placeholder. If the same call is refused again, the agent is told to stop retrying and ask the user. The message stays content-free. ([#35](https://github.com/jwcrystal/leakshield/issues/35))

## 0.1.1 — 2026-10-19

### Changed

- Refusal and block messages now follow one plain style, `LeakShield blocked <thing> because <reason>.` The `transparent mode` prefix and the misleading `failed to protect a model request` wording are gone (masking failures always failed closed; the old text read like a leak and was the only refusal that did not say `blocked`), and jargon such as `verified request attribution`, `model transport route` and `literal-argument form` is replaced with simpler language. Only the operator-facing text changed; every message still starts with `LeakShield `.
- Releases ship the npm package only (the OpenCode plugin and the `leakshield` CLI). Standalone binaries are no longer attached; run the `Build binaries` workflow manually and download one from its artifacts when needed.

### Fixed

- `npm publish` no longer warns that the `bin` entry is invalid. The path is now `dist/cli.js` instead of `./dist/cli.js`; npm 11 rewrote the old form at publish time, and 0.1.1 still installs the `leakshield` command.

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
