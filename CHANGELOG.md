# Changelog

All notable changes are listed here.

## Unreleased

### Added

- pi adapter: an in-process extension wraps pi 1.6's `globalThis.fetch`, so Chat Completions, Anthropic Messages and Responses requests are masked before they leave the process and assistant text is restored in the reply. It restores read/write/edit/bash/powershell arguments at the local tool boundary, refuses placeholders for unknown and MCP tools, refuses provider routes and wire APIs it cannot see (Codex WebSocket, Bedrock, Google auth) and cancels manual compaction and branch summarization when the model cannot be guarded, and keeps pi sessions in the user's session directory, and can keep the encrypted mapping store across processes when `LEAKSHIELD_PI_PERSIST` is enabled. Install it in pi `settings.extensions` (first entry recommended so an earlier extension cannot hold the raw fetch), or with `-e`; `leakshield --doctor` gained pi checks for the build, the guard config, registration order and the selected model's wire API. Verified on pi 1.6.0 with a real process, all three wire formats and a scripted tool sequence including `--continue`. A failing pi check only changes the aggregate doctor exit code when OpenCode is absent. `--doctor` also accepts `opencode`, `claude-code` or `pi` to check one host with its own exit code. See [docs/pi.md](docs/pi.md) and the [verification record](docs/evidence/2026-11-23-pi-extension.md). ([#98](https://github.com/jwcrystal/leakshield/issues/98))
- Claude Code support through a local proxy: `leakshield --claude-code-proxy` listens on `127.0.0.1:8787`, and Claude Code reaches it through `ANTHROPIC_BASE_URL`. It masks Anthropic Messages and `count_tokens` requests and restores placeholders in assistant text, JSON and SSE. A request it cannot mask is answered with a 400 and not forwarded. Placeholders in tool calls are not restored yet, and traffic that bypasses the base URL (WebFetch's domain check, telemetry, Bedrock/Vertex) is not covered; see [docs/claude-code.md](docs/claude-code.md). ([#86](https://github.com/jwcrystal/leakshield/issues/86))
- `leakshield --doctor` has a `Claude Code:` section: where `ANTHROPIC_BASE_URL` comes from, whether the LeakShield proxy answers there, and providers that bypass it. On a machine without OpenCode, the doctor now exits 0 when Claude Code is behind a running LeakShield proxy and no Bedrock/Vertex/host-managed setting bypasses it; every OpenCode status keeps its exit code, and a base URL pointing at a proxy that is not running exits 1.
- The Anthropic masker can accept `thinking` and `redacted_thinking` history blocks, masking the thinking text and passing `signature` and redacted data through unchanged. Only the Claude Code proxy turns this on; the OpenCode plugin still refuses those blocks.
- Experimental `leakshield/core` subpath export with TypeScript declarations, for hosts other than OpenCode. A host passes a `HostToolPolicy` to `createGuardCore` to have placeholders in tool calls restored; without one, a tool call that carries a placeholder is refused. Not a separate package, and the API may change. The default `leakshield` entry is unchanged. ([#94](https://github.com/jwcrystal/leakshield/pull/94), [#95](https://github.com/jwcrystal/leakshield/pull/95))

### Fixed

- Transparent mode no longer forwards original request bytes that parse to something other than what was scanned. A Chat Completions, Anthropic Messages or Responses body with a duplicate key (only the last occurrence survives `JSON.parse`) or invalid UTF-8 was forwarded byte-for-byte when masking changed nothing, so a secret in an earlier occurrence reached the provider unscanned. Any body that is not already its canonical `JSON.stringify` serialization is now forwarded as that serialization, even when nothing was masked: whitespace and `\u` escapes are normalized, and numbers are re-emitted as parsed (`1.0` becomes `1`, integers beyond 2^53 lose precision, which also closes the gap where such digits were scanned rounded but forwarded exact). A body that already is canonical keeps its original request. ([#93](https://github.com/jwcrystal/leakshield/pull/93))

## 0.3.1 — 2026-11-21

OpenCode sessions no longer stop after a server-side compaction.

### Fixed

- OpenCode now replays four Responses input item types that the validator refused as unknown (`[responses-item-type]`), so a session that had been compacted on the server was blocked on every later request. `compaction` items cross verbatim and unscanned, like `reasoning.encrypted_content`; `custom_tool_call` input and `custom_tool_call_output` output are masked as text; `configuration_update` keeps `reasoning.effort` structural; and `function_call.namespace` is a structural identifier. On the restore side, `custom_tool_call` input stays tokenized over HTTP, SSE and WebSocket for the tool gate, without a degradation warning. ([#83](https://github.com/jwcrystal/leakshield/pull/83))

## 0.3.0 — 2026-11-06

Transparent-mode tool restoration is now decided per field instead of per tool. A string in an ordinary tool is restored verbatim, and `curl` and `http` may hold a placeholder inside an argument, so an API can be called with a protected value. Two kinds of call are still refused that a reader might expect to work: a placeholder in a multi-line or interpolated `code`/`script` string, and any command that parses its arguments again (`sh -c`, `wget -e`). Restoring a value still does not control where a permitted command sends it. Run `leakshield --doctor` after upgrading.

### Changed

- Restoration is chosen per field, not per tool. Shell tools and command-like fields, at any depth and in argv arrays, keep the shell rules; `description`, `title` and `label` restore verbatim; and a tool that is neither a known shell nor has a command-like field restores its strings verbatim instead of being refused as a shell. `code` and `script` fields restore only under a restricted single-line string rule: bare placeholders, interpolation regions, backtick strings, comments, multi-line strings and lines after a continuation are refused, and so are originals holding shell-unsafe characters. A refused call is blocked rather than masked: the tool does not run and its input keeps the placeholder. The rule is a conservative heuristic, not syntax verification, so it can over-refuse and miss; it guards the restoration context only, is not egress protection, and does not detect a tool that executes something under another field name. ([#76](https://github.com/jwcrystal/leakshield/pull/76))
- `curl` and `http`, when they are literally the first word, may hold a placeholder inside an argument, such as `-H 'x-api-key: <placeholder>'` or `-u user:<placeholder>`. An argument starting with a dash may hold one only as `--name=value`, and every other command keeps the whole-word rule, `wget` included, because `sh -c`, `python -c`, `ssh` and `eval` parse their arguments again. ([#78](https://github.com/jwcrystal/leakshield/pull/78))
- The source of the built-in `execute` (Code Mode) tool is no longer restored. The host fires the hook again for each tool the code calls, with evaluated arguments, and the field rules apply there; a placeholder kept in the source stays literal. `execute` source holding a mapped placeholder together with `fetch` is refused, because `fetch` would send the placeholder and a 401 would then read as an invalid key. ([#78](https://github.com/jwcrystal/leakshield/pull/78))
- The structure refusal now says that the input's structure is the problem, not the value. Models read the old wording as a verdict on the secret and kept rewriting it. ([#79](https://github.com/jwcrystal/leakshield/pull/79))

### Fixed

- Tools with nested arguments, such as OpenChamber's `openchamber_render` with its `{action, parameters}` form (reachable only from Code Mode on OpenCode v2.2.5), were always refused once the input carried a placeholder, because the host freezes nested values. A frozen container is rebuilt as a copy along the changed path and assigned into its nearest writable ancestor; unchanged subtrees keep their identity, and field rules follow the key path. A copy keeps enumerable properties only, so an input with a hidden value is refused instead of dropping it silently. Verified on OpenCode v2.2.5 only. ([#79](https://github.com/jwcrystal/leakshield/pull/79))
- `rtk` was not known to the shell gate, so `rtk sh -c`, `rtk err sh -c` and `rtk wget -e` restored a placeholder as a plain argument. `rtk` is now resolved to the command it runs, however it is spelled, and its subcommands that run another command are refused; `rtk curl` keeps the whole-word rule because `rtk` stores command lines in a local plaintext history, which whole-word forms such as `rtk git log` still reach. ([#79](https://github.com/jwcrystal/leakshield/pull/79))
- Reading `input.code` ran a getter or proxy trap, a path the rest of the gate avoids, and could skip the shape refusal. Only an own string data property now counts as a Code Mode call, and a root proxy is refused before its traps run. ([#79](https://github.com/jwcrystal/leakshield/pull/79))
- A value recognisably a placeholder of this session whose format changed (brackets dropped, separators changed or removed, case altered) is refused for every tool, instead of running the tool on the altered string. SGP2 only; a partially masked value, or one the model replaced entirely, cannot be detected and still reaches the tool as written. ([#78](https://github.com/jwcrystal/leakshield/pull/78))
- The inert-position check rescanned the field once per mapped placeholder, so it was quadratic: a 1.6 MB code field took 14.5 s to judge, and 40,000 placeholders on one line took 73 s. The check now walks the field once, carrying line boundaries, triple-quote counts and the line's quote state; what is allowed or refused, and which error wins, is unchanged. ([#77](https://github.com/jwcrystal/leakshield/pull/77))

## 0.2.0 — 2026-11-04

**Breaking:** OpenCode v1 is no longer supported. LeakShield supports OpenCode v2 only. On a v1 host this version aborts every model request, so upgrade to OpenCode v2 before upgrading LeakShield. Staying on `leakshield@0.1.3` keeps a v1 host working, without the security fixes below. Two more changes can affect an existing setup: a config over the new list caps fails the load, and the warning labels in the default English `summary` are no longer in Chinese. Run `leakshield --doctor` after upgrading.

### Security

- The Web UI `POST /scan` response no longer includes `redactedContent` when `redactionVerified` is `false`. With `encoding_detection` on, an encoded secret used to come back whole in that field. This now matches `--redact`, which suppresses output: the Web UI shows no safe version, only its verification notice. A truncated scan is treated the same way.
- zod is upgraded to ^4.6.7, which fixes GHSA-mrhx-c7xc-m3w5 (high: memory exhaustion when validating oversized constrained collections). `nda_keywords` and `private_domains` are now capped at 4096 entries and `custom_rules` at 1024, and a config over a cap fails the load. A YAML value that is not a mapping where a mapping is expected (a timestamp or `!!binary` for `settings`, or a non-mapping root) fails the load, as it did before the upgrade.

### Removed

- OpenCode v1 support. A v1 host that loads the package now gets hooks that fail closed and abort every model request with a message that says to upgrade to OpenCode v2; it no longer runs `block` mode with the legacy hooks, and the v1 env query tools are gone. `leakshield --doctor` reports `BROKEN` for a v1 host, with the fix "upgrade to OpenCode v2". Upgrade to OpenCode v2.
- `@opencode-ai/plugin` is no longer installed with the package. It moved to `devDependencies` (type-only imports, erased at build), which removes 28 transitive packages from every install, including `effect` and its `toml` dependency with 4 high advisories, `zod@4.1.8` and `msgpackr-extract` with an install script.

### Changed

- The default `mode` is always `transparent`; there is no longer a per-host default. `block` stays available with `"mode": "block"`.
- Config and option validation errors are worded by zod 4 and no longer echo rejected enum values.
- Large strings are faster to process. Transparent mode searches for detected values in one pass instead of once per value, and the scanner builds one line index per scanned text. Results and refusals are unchanged.

### Fixed

- Two rules of one type matching at one offset, which any two overlapping `custom_rules` can do, no longer report only the first rule's match. A LOW rule listed first hid a HIGH rule at that offset, downgrading the decision and dropping the match under `--min-severity high`, and a shorter match hid a longer one, so transparent mode masked only the start of the value and sent the rest to the model. The finding now carries the highest severity and the longest span.
- An exact value from `env_files` on the same range as a weaker rule match is no longer hidden by it. A LOW or MEDIUM rule, such as `PII_EMAIL` on an address in `.env`, suppressed the HIGH `ENV_SECRET` finding, downgrading the decision and dropping the match under `--min-severity high`. Both findings are now reported; a HIGH rule on that range still reports alone.
- A transparent-mode request refused because a string, before or after masking, exceeded `settings.max_chars` now says so. The refusal carried only `reason=truncated_content`; it now names the configured bound and asks to raise it or split the content. Nothing is sent unscanned either way, and the limit's documentation no longer says "truncate", which is what the standalone scanner does, not transparent mode. ([#47](https://github.com/jwcrystal/leakshield/issues/47))
- Encoded content that decodes to a finding is masked with an `ENCODED` token and restored exactly, instead of refusing the whole transparent-mode request, when the decoder can report the run's exact source span: a percent-encoded email, an encoded email in a URL query string, a `+tag` local part, and a key's whole Base64 or raw hex run. An encoded run hidden by zero-width or look-alike characters, one that crosses an existing token, a structural identifier that carries a secret, and a run whose span cannot be attributed still refuse. ([#48](https://github.com/jwcrystal/leakshield/issues/48))
- With `encoding_detection` on, a Base64, hex or percent-encoded finding is now masked over the whole encoded run in `redactedContent` and `safePreview`. It was masked at offsets of the decoded text, so the tail of the run survived (`c2stcHJvai10ZXN0MTIzNDU2Nzg5MGFiY2RlZg==` became `[REDACTED_API_KEY]MGFiY2RlZg==`), a long prefix was overwritten while the whole run survived, and an encoded key whose decoded offsets equalled a direct finding's was not reported at all. A run that cannot be attributed to a source span (a zero-width or look-alike character inside it) gives no redacted content or preview, and `--redact` still suppresses its output.
- `leakshield --doctor` still identifies LeakShield in a `file://` URL it cannot parse or decode, such as one with a bad percent escape, by reading its path segments, so the entry is reported as unloadable instead of being skipped. This is a heuristic, since such a reference cannot be resolved. ([#65](https://github.com/jwcrystal/leakshield/issues/65))
- The `[WARNING: ...]` suffix (encoding, truncation, zero-width, suspicious Unicode) is kept in the CLI text and JSON summary. The severity filter rebuilt the summary on every scan and dropped it.
- The labels in that suffix follow `LEAKSHIELD_LANG`. They were always in Chinese, so the default English summary now reads, for example, `[WARNING: Encoded content: Base64]`. A script that matched the old text in `summary` needs updating.
- `leakshield --doctor` reads every config file OpenCode reads — `.opencode/`, the project file, and one global root — and applies their `plugins` arrays the way the host does: entries accumulate from lowest to highest precedence instead of replacing one another, `-leakshield`, `-prefix.*` and `-*` remove an entry, and `*` restores the entries seen so far. Removals match the plugin id, so `-leakshield` disables a dist-path entry too, a relative plugin path resolves from the config file that declared it (`file://` URLs are absolute and decoded, and one this platform cannot turn into a path is reported instead of crashing the doctor), and a configured path that points at a single file is reported as skipped rather than accepted. A project `opencode.json` that set only `$schema` used to hide a global registration and report `NOT_REGISTERED` with exit 1; it is now found, and the check names the file that supplied the entry. A config that disables the plugin still fails, but as disabled — naming the entry and the file rather than claiming the plugin is absent. When several entries reference LeakShield, every one is validated — its guard config must load, its scanner must still flag the canary, and `attachments: "allow"` counts — and the weakest decides the verdict, so a hook-only entry is not hidden behind a stronger one. ([#65](https://github.com/jwcrystal/leakshield/issues/65), [#67](https://github.com/jwcrystal/leakshield/issues/67))

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
