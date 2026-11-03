<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./icon.svg">
  <img alt="leakshield" src="./icon.svg" width="64">
</picture>

# leakshield

> 🌐 English | [繁體中文](./README.zh-TW.md)

**A gatekeeper that scans for sensitive content before you feed code, documents, or data to AI services.**

Three supported modes:
- **OpenCode Plugin**: The enforced ingress gate for OpenCode. Use this when OpenCode sends content to a model.
- **CLI**: Manual or CI scanning of text, files, and directories; supports redaction.
- **Web UI**: Local browser interface and REST endpoint for manual scanning.

MCP server mode has been removed. It depended on the model voluntarily calling a scan tool after it had already received the relevant context, so it cannot provide the plugin's security boundary.

| Mode | Start it with | Use it for |
|------|---------------|------------|
| OpenCode Plugin | Add the `leakshield` package or the `dist` directory (v2), or `dist/opencode.js` (v1), to `opencode.json` | Automatic, fail-closed protection for OpenCode model inputs and tool outputs |
| CLI | `npm run scan -- --file ./path` (or `leakshield --file ./path` after a global install / `npm link`) | Explicit local or CI scans; it never sends content to a model |
| Web UI | `npm run web` | Manual browser scans at `http://localhost:3000` |

## Project status

**Experimental, `0.x`.** Published to npm as `leakshield`: run `npx leakshield --help` to see the commands, or build locally (`npm ci && npm run build`) and point OpenCode at the `dist` directory. Without arguments or input, the CLI waits on stdin.

- Transparent mode has been verified on OpenCode v2.0.28 with local loopback providers, and once against a real OpenAI model. It is **not** a guarantee that nothing sensitive reaches a model: the recommended hook-first setup is reported as `PARTIAL` by `--doctor`, and content added after the plugin's hooks or sent by permitted tools (curl, remote MCP) is outside its coverage.
- Not yet verified: OS-keychain custody on Windows and Linux (macOS verified 2026-10-20), a real Anthropic provider, long histories on other providers, long-running use ([#26](https://github.com/jwcrystal/leakshield/issues/26)).
- Defaults may still change during `0.x`; see the [changelog](CHANGELOG.md).
- Verification records: [docs/evidence](docs/evidence/README.md). Report vulnerabilities privately: [SECURITY.md](SECURITY.md). License: [MIT](LICENSE).

---

## Detection Coverage

| Type | Description | Severity |
|------|-------------|----------|
| API Key | OpenAI, Anthropic, Google, AWS, Stripe (live keys) | 🔴 HIGH |
| Secret / Password | Generic password assignments, AWS Secret | 🔴 HIGH |
| Token | GitHub, Slack, Hugging Face, JWT, Bearer Token | 🔴 HIGH |
| Private Key | PEM private key blocks | 🔴 HIGH |
| DB Connection String | MongoDB, PostgreSQL, MySQL, Redis, ADO format, etc. | 🔴 HIGH |
| Taiwan National ID | Format validation | 🔴 HIGH |
| Credit Card Number | 13–19 digits, Luhn checksum required | 🔴 HIGH |
| IBAN | Compact or 4-char groups, mod-97 checksum required | 🔴 HIGH |
| Public IPv4 Address | Private/loopback/CGNAT/reserved ranges excluded; runs longer than four groups are reported whole | 🟡 MEDIUM |
| Private IPv4 / VPN CIDR | **Opt-in** — disabled by default (`rule_overrides["private-ipv4"]: true`); networks from `settings.private_cidrs`, default RFC 1918 + CGNAT + link-local | 🟡 MEDIUM |
| Email Address | All email formats | 🟡 MEDIUM |
| URL Embedded Credential | `scheme://user:password@host` — only the userinfo span is masked | 🔴 HIGH |
| Taiwan Mobile Number | **Opt-in** — disabled by default (`rule_overrides["phone-tw"]: true`); digit runs are a measured false-positive source | 🟡 MEDIUM |
| International Phone | **Opt-in** — disabled by default (`rule_overrides["phone-intl"]: true`); same trade-off as above | 🟢 LOW |
| HTTP(S) URL | **Opt-in** — disabled by default (`rule_overrides.url: true`) | 🟢 LOW |
| NDA Keywords | Custom (see `config/guard.config.yaml`) | 🔴 HIGH |
| Private Domains | Custom (see `config/guard.config.yaml`) | 🟡 MEDIUM |

> **Detection boundaries** (per `src/rules/builtin.ts`): the generic secret rule matches only the keywords `password`, `passwd`, `secret`, `private_key`, `client_secret` with a value of **8+ characters** — generic `api_key=`/`token=` assignments are not matched unless the value itself matches a vendor pattern. It also skips an unquoted value that is a code expression, such as `process.env.DB_PASSWORD` or `z.string().min(6)`; a call whose arguments hold another string literal is still reported. Credit card and IBAN matches require a valid checksum, and the credit card rule skips a run of one repeated digit and digits inside a UUID. The URL credential and DB connection rules skip a password that is a `${…}`, `{{…}}` or `<…>` placeholder. IP matches cover only public/routable IPv4, and a dotted run longer than four groups is reported whole so an address embedded in it is masked instead of left behind (dotted dates such as `2026.10.21.14.32.59` therefore report as an IP run too). Not covered by any rule: street/postal addresses, dates, IPv6, and values below the 8-character minimum for generic secret assignments. SSH remote authorities (`user@host:path`, `ssh://user@host/…`) are not reported as email; private domains and path keywords still apply inside them, and the password half of `scheme://user:password@host` is reported as a URL credential instead. Private IPv4 is opt-in because the literal also matches version numbers and timestamps; `settings.private_cidrs` narrows it to the organisation's own ranges, and an entry that does not parse fails the config load. Every built-in rule has a stable id and can be toggled via `settings.rule_overrides` in `config/guard.config.yaml` (unknown ids fail config load); the URL rule ships disabled because always-on URL masking would flag provider endpoints. The same rule set (built-in + `config/guard.config.yaml`) applies to every mode — `block`, `redact`, and `transparent`.

---

## Decision Model

Every scan produces a **decision** that tells the caller how to handle the content:

| Decision | When | Risk Level | Meaning |
|----------|------|-----------|---------|
| `ALLOW` | No findings | LOW | Content is clean — safe to send |
| `WARN` | LOW-severity findings only | MEDIUM | Minor items detected — reminder shown, content can be sent |
| `CONFIRM` | MEDIUM or HIGH findings | HIGH / CRITICAL | Sensitive content detected — user must explicitly confirm |

### CONFIRM Handling

When the decision is `CONFIRM`, the CLI is non-interactive: it prints a warning card and a next-step hint, and does not prompt you to choose. The hint points to `--format json` (read `redactedContent`) or `--redact` (sanitized output). Exit code `1` means the content was blocked.

The `CONFIRM` decision includes:
- `recommendedAction`: `REVIEW` (MEDIUM findings) or `BLOCK` (HIGH findings)
- `safePreview`: a masked excerpt around the first finding
- `redactedContent`: the full content with all sensitive spans replaced

### JSON Output Fields

When using `--format json`, the output includes these decision-oriented fields:

| Field | Description |
|-------|-------------|
| `decision` | `ALLOW`, `WARN`, or `CONFIRM` |
| `riskLevel` | `LOW`, `MEDIUM`, `HIGH`, or `CRITICAL` |
| `recommendedAction` | `REVIEW` or `BLOCK` (CONFIRM only) |
| `findings` | Array of sanitized findings (no internal metadata) |
| `safePreview` | Masked excerpt (CONFIRM only) |
| `redactedContent` | Full redacted text (CONFIRM only) |

---

## Installation

Requires Node.js 20 or later. Mapping persistence needs 22.13 or later.

```bash
npm install -g leakshield
leakshield --help
```

`npx leakshield …` runs the published package without installing it. The npm
package ships only the compiled code, so it has no `config/` directory; see
[Configuration](#configuration) to add one.

To build from source:

```bash
git clone https://github.com/jwcrystal/leakshield.git
cd leakshield
npm install
npm run build
```

For local development, install the build globally or `npm link` it, then use
`leakshield` directly. `npm run scan -- ...` works from this repository without
installing.

### npm Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Clean, then compile TypeScript → `dist/` |
| `npm run clean` | Remove `dist/` |
| `npm start` | Run the built CLI (`node dist/cli.js --cli`) |
| `npm run dev` | CLI mode (no build needed) |
| `npm run scan` | CLI scan (no build needed) |
| `npm run web` | Start the local Web UI (no build needed) |
| `npm test` | Run unit tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run binary` | Build standalone binary for current platform (macOS ARM) |
| `npm run binary:win` | Cross-compile for Windows x64 |
| `npm run binary:linux` | Cross-compile for Linux x64 |
| `npm run binary:mac-intel` | Cross-compile for macOS Intel |
| `npm run binary:win-icon` | Build the Windows binary with the app icon (`scripts/build-win.js`) |
| `npm run binary:all` | Build all platforms at once |
| `npm run bundle:mac` | Build the binary and package a macOS bundle (`scripts/bundle-mac.sh`) |

---

## Standalone Binary

Can't use Node.js or npm? Build a standalone binary with [Bun](https://bun.sh) — no runtime needed on the target machine.

```bash
# One-command build for current platform
npm run binary

# Cross-compile for other platforms
npm run binary:win     # Windows x64  → leakshield.exe
npm run binary:linux   # Linux x64    → leakshield-linux
npm run binary:all     # All platforms
```

Or directly with Bun:

```bash
bun build --compile --target=bun-windows-x64 ./src/cli.ts --outfile=leakshield.exe
```

The output is a single executable — hand it to anyone, no dependencies required.

### Configuration for binary and npm users

The binary and the npm package work out of the box with built-in defaults. To customize rules (NDA keywords, private domains, custom regex patterns), place a config file in one of these locations:

| Location | Scope |
|----------|-------|
| `./config/guard.config.yaml` | Current working directory |
| `~/.leakshield/guard.config.yaml` | All sessions (user home) |

```bash
# Quick start: copy config/guard.config.example.yaml from this repository,
# then replace its sample keywords and domains
mkdir -p ~/.leakshield
cp config/guard.config.example.yaml ~/.leakshield/guard.config.yaml

# Or per-project
mkdir -p ./config
# Create/edit ./config/guard.config.yaml as needed
```

See [Configuration](#configuration) section for available options.

---

## Usage

### CLI

```bash
# Scan text
npm run scan -- --text 'sk-proj-test1234567890abcdef my_password="super_secret"'

# Scan a single file
npm run scan -- --file ./src/config.ts

# Scan an entire directory
npm run scan -- --dir ./src

# Scan specific file extensions only
npm run scan -- --dir ./src --ext .ts .env .json

# Read from stdin
cat .env | npm run scan -- --stdin

# Global installation
leakshield --file ./config.ts
```

Exit codes: `0` = safe (ALLOW), `1` = findings detected (WARN or CONFIRM), `2` = file not found

#### Redaction Mode

Replace sensitive content with `[REDACTED_TYPE]` placeholders instead of just reporting it:

```bash
# Redact stdin and print to stdout
echo 'token=sk-proj-test1234567890abcdef' | npm run scan -- --redact --stdin

# Redact a file and write result to a new file
npm run scan -- --redact --file .env --out .env.redacted

# Dry-run: preview what would be redacted without producing any output
npm run scan -- --redact --dry-run --file .env
```

Redacted output goes to **stdout**; the findings summary goes to **stderr** so they can be separated in pipelines.

| Flag | Behaviour |
|------|-----------|
| `--redact` | Replace findings with `[REDACTED_TYPE]`, write to stdout |
| `--redact --dry-run` | Preview findings only, no output; exit `1` if any found |
| `--redact --out <path>` | Write redacted text to file instead of stdout |
| `--redact --format json` | Return JSON with `redacted`, `findings`, and `summary` fields |

#### CLI Options

| Option | Description |
|--------|-------------|
| `--format json` | JSON output (CI/CD friendly) |
| `--min-severity high` | Only report HIGH (or `medium` / `low`) |
| `--allow-outside` | Allow scanning paths outside the current working directory (disabled by default) |
| `--enable-encoding-detection` | Also decode Base64, URL-encoded and hex content before scanning (disabled by default) |

#### Workspace Path Restriction

By default, `--file` and `--dir` only accept paths **inside the current working directory**. Attempts to scan outside (e.g. `../shared.env` or `/etc/passwd`) will be rejected with an error.

To intentionally scan a path outside the workspace, pass `--allow-outside`:

```bash
npm run scan -- --file ../shared.env --allow-outside
```

> ⚠️ Outside-workspace scanning is opt-in. Only use it when you explicitly need to scan a file that lives outside the project root.

#### Ignore Directives

The CLI and Web UI skip any line containing `leakshield-ignore`, `guard:skip`, `guard:ignore`, `sg-ignore`, `no-scan` or `skip-guard` (case-insensitive). A real secret on that line reports as `ALLOW`.

> ⚠️ Anyone who can edit a scanned file can add a directive, so a CLI scan is not a gate against untrusted changes. The OpenCode plugin does not honor directives.

---

### Web UI

Start a local web server and use it in your browser:

```bash
# Default port 3000
npx tsx src/cli.ts --web

# Custom port
npx tsx src/cli.ts --web --port 3001

# Built version
node dist/cli.js --web --port 3001
```

Open `http://localhost:3001` in your browser, paste content, and press **Scan** or `Ctrl+Enter`.

#### REST API

You can also call the API directly:

```bash
# Scan text
curl -s -X POST http://localhost:3001/scan \
  -H 'Content-Type: application/json' \
  -d '{"content": "sk-proj-test1234567890abcdef my_password=\"super_secret\""}' | jq

# Response format
{
  "decision": "CONFIRM",
  "riskLevel": "CRITICAL",
  "summary": "...",
  "findings": [
    { "type": "API_KEY", "severity": "HIGH", "description": "OpenAI API Key", "preview": "****", "line": 1 },
    { "type": "SECRET", "severity": "HIGH", "description": "...", "preview": "****", "line": 1 }
  ],
  "recommendedAction": "BLOCK",
  "redactedContent": "[REDACTED_API_KEY] my_[REDACTED_SECRET]",
  "redactionVerified": true,
  "residualFindings": 0,
  "wasTruncated": false
}
```

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Web UI HTML |
| `/scan` | POST | Scan `{ "content": string }`, returns JSON |

---

### OpenCode Plugin (recommended)

When loaded successfully, the OpenCode plugin is the enforced integration. It scans and blocks user text before OpenCode persists or sends it to a model, sanitizes system prompts and tool definitions, protects tool output before the next model turn, and re-scans history before replay. It always enables encoded-content detection. Invalid plugin options or scanner configuration make every protected hook fail closed and abort the model request. A bounded SHA-256 decision cache avoids repeatedly scanning unchanged history without retaining original or redacted content. In transparent mode, schema annotation prose (a `description`/`title` value inside a tool input schema) that trips a scanner rule is masked to a pseudonym token like any other content; identifier positions (tool names, property keys, enum/const values, regex patterns) still refuse the whole request rather than being renamed.

The same compiled plugin supports both OpenCode major versions: v2 hosts load the package `id` + `setup(ctx)` definition, while v1 hosts (1.18.29+) call the legacy `server()` factory.

**OpenCode v2** — point `plugins` at the published package, or at the `dist` directory of a local build:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "leakshield" // or "/absolute/path/to/leakshield/dist"
      // No options: mode defaults to "transparent" on v2.
      // Add "options": { "mode": "block" } to refuse instead of pseudonymize.
    }
  ]
}
```

Note that v2 only accepts plugin *directories* (it resolves `dist/index.js`) or package names; a `file://` URL to a single `.js` file is rejected with `configured plugin path must be a directory`.

**OpenCode v1 (1.18.29+)** — use the legacy `plugin` array with the compiled plugin file:

```json
{
  "plugin": [
    [
      "file:///absolute/path/to/leakshield/dist/opencode.js",
      { "mode": "block" }
    ]
  ]
}
```

The default `mode` depends on the host: **`transparent` on OpenCode v2** (described below) and **`block` on v1**, since transparent is v2-only. `block` replaces unsafe content with a disclosure-free notice; set `"mode": "block"` on v2 to keep that behavior. Set `mode` to `redact` only when you explicitly want recognized direct matches replaced with `[REDACTED_TYPE]` placeholders. `--doctor` shows the mode in effect and marks it `(default)` when the options omit it.

**OpenCode v2 only — transparent pseudonymization (the v2 default):** omit `mode` or set `"mode": "transparent"` to replace detected sensitive values in model-request snapshots with stable opaque placeholders — category-labelled `[SGP2:<TYPE>-xxxx-xxxx-xxxx]` (the legacy `[SGP1:…]` shape stays recognized for restoring pre-upgrade in-session mappings). Reverse mappings are scoped to the OpenCode session and stay in process memory by default; encrypted persistence is opt-in below. Known placeholders are restored in tool inputs before execution and in supported assistant response text. Supported HTTP protocols are selected by URL path shape: Chat Completions, Anthropic Messages, and Responses, including streaming. Native Responses-family WebSocket is also supported as described below. Wire-mode SDKs honoring injected fetch use the same request-scoped HTTP hooks. Hook-only protects content snapshots without transport admission; it does not add adapters for unknown protocols. Transparent mode has been verified against loopback providers and one real OpenAI model; OS-keychain custody is verified on macOS only, and a real Anthropic provider, long-history replay on other providers and Windows/Linux keychains are not verified yet ([#26](https://github.com/jwcrystal/leakshield/issues/26)). Routes it cannot protect are refused, not forwarded.

**Hook-only for new transparent installs:** use [the hook-first configuration example](config/opencode.hook-first.example.json), which explicitly sets `wireProtection: false`. Content hooks protect system/messages/options/tools and the tool gate restores safe known arguments. LeakShield registers **no outbound HTTP request, WS handshake/send, or AI SDK admission hooks**, does not inspect transport metadata, and does not change provider transport settings. Unknown routes and private SDK transports do not incur LeakShield transport refusals. Optional incoming HTTP/WS hooks restore supported display text using successful preparation for the same session/kind/model; missing hooks or restoration failures leave placeholders literal without disabling input protection. Later-added content or attachments may leave unmasked, even with `attachments: "block"`. The doctor reports `PARTIAL`, not full-wire protection. **Content-hook masking failures still refuse the affected call**, now including a safe `[stage=prepare.mask reason=…]` code; hook-only does not silently forward unprotectable raw content. See [hook-only verification](docs/evidence/2026-10-11-pure-hook-only-verification.md).

**Final wire protection:** set `wireProtection: true` to additionally validate/remask the final HTTP request body or supported WS outbound frame content; unknown routes and unknown/mixed body shapes refuse before dispatch. Tool safety and reply-side recovery are identical in both levels. For compatibility, **omitting `wireProtection` retains this stronger legacy behavior**. With the v2 default (`mode: "transparent"`, `wireProtection` omitted) this stronger level is on; only the hook-first example chooses false explicitly. The option is valid only in transparent mode.

**AI SDK providers:** with `wireProtection: true`, providers must honor OpenCode's injected `options.fetch`; request-scoped HTTP hooks provide attribution and wire enforcement without a provider-brand allowlist. The wrapper checks HTTP/HTTPS and supported paths; missing/accessor/nonwritable fetch options refuse. With false, LeakShield installs no SDK wrapper and imposes none of those transport requirements; only content/tool hooks and optional ingress restoration apply. Bypass transports are **outside final-wire coverage**, not guaranteed blocked. Commandcode `/alpha/generate`, including Go/403 fallback, is untouched in false and refused in true; there is no legacy response adapter. Arguments, abort signals and real provider failures remain host-owned.

In wire mode, the wrapper represents its route/content refusals as a **local HTTP 400 error response**, with `error.code: "leakshield_transport_refusal"` and a content-free WARN. Rejected requests do not reach the network. Hook-only has no such wrapper or transport admission. SDKs can distinguish a refusal from a retryable network failure; genuine network errors, aborts and provider responses remain unchanged. Responses easy-input messages may omit `type: "message"`; recognized roles and supported content are masked without inserting a type into their wire body.

**Reply-side recovery in both levels:** LeakShield attribution or JSON/SSE/WS restoration failures stop LeakShield rewriting rather than interrupting the host's response. Unattributed replies stay original; no session/model mapping is guessed. SSE keeps a bounded transaction of undelivered original events, releases them in order on failure, then passes subsequent bytes through without duplicates or dropped tails. Provider error events are released immediately; upstream errors and consumer cancellation still propagate. This can show literal placeholders, and invalid provider data may still fail in OpenCode. Tool arguments still pass the unchanged safety gate. WS can replace only one frame, not replay multiple held channels; see the documented WS limitations and [recovery evidence](docs/evidence/2026-10-11-experience-first-verification.md).

**Native WebSocket (experimental, Responses-family):** `/responses` over `ws:`/`wss:` accepts flat `response.create` frames, regardless of provider brand, and restores supported display deltas split across frames. Request masking reuses the HTTP Responses masker; function-call argument frames remain tokenized until the local tool gate, and encrypted reasoning stays opaque. Continuation IDs are preserved, not remasked. Different dialects/extensions are not automatically supported. OpenCode exposes no connection ID: state is isolated by session, request kind and model, then response ID and content channel. New handshakes/model switches, HTTP fallback, rejected frames and disposal invalidate old state; terminal frames release buffers. Frames, channels and aggregate buffering are bounded. A provider that omits the final text delta leaves a static warning: the complete `.done` text is restored without replacing that event with a synthetic delta, so delta-only consumers may show an incomplete reply. Unknown display tokens remain literal; unsafe or unknown write-tool mappings still refuse. The existing native OpenAI HTTP preference is retained for compatibility; explicit WS settings now work on supported routes. This is not a system network firewall or support for every WS provider. See [verification and limitations](docs/evidence/2026-10-11-responses-ws-verification.md).

**Shell argument restoration:** on macOS/Linux POSIX shells, a known placeholder may occupy a complete unquoted, single-quoted, or double-quoted argument. Existing quotes are preserved, and originals must be safe in that quote context; quoted space-containing values remain one argument. A single trailing `>`/`>>` redirect to a static literal filename is supported. Command/assignment positions, tokenized redirect filenames, expansions, quote concatenation, pipelines, inline scripts, quote-breaking originals, and leading-option values still refuse the affected tool call before mutation. Token-free commands are unchanged. The new quoting/redirect support is not enabled on Windows; it is not a general shell parser. Neither `wireProtection` setting changes this tool gate.

**Opt-in mapping persistence:** set `"persistence": { "enabled": true }` in transparent mode to survive restarts — mappings persist encrypted (per-entry AES-256-GCM, AAD-bound) in a SQLite store (default `~/.local/share/leakshield/SGP.db`) and rehydrate on a session's first touch, so previously saved placeholders in resumed sessions keep restoring. Requires Node.js 22.13+ (built-in `node:sqlite`); on an older runtime the store cannot open and mappings stay memory-only with a WARN. Options: `ttlDays` (default 7; 0 = manual erasure only), `path` (store location), `keyFile`/`keyfilePath` (weaker fallback when no OS keychain exists). Key custody resolves down a ladder — OS keychain (macOS Keychain / Windows DPAPI / Linux libsecret) → explicit keyfile → memory-only degrade. Runtime logs report `persistence: active; key=os-keychain|keyfile` when the store opens successfully; later degradation emits a WARN. Missing keys do not directly refuse conversations, but an unsaved old token can still fail the tool gate. `--doctor` reports configuration/store readability as **unverified**, not runtime activation or decryptability, and never touches the real keychain. TTL cleanup runs when a writer opens the store, not on a timer; saving a changed mapping snapshot extends expiry, while reads do not. Seven days is not a hard deletion deadline. Persistence cannot recover mappings already lost before activation. Active erasure: `leakshield --forget --all` (or `--session <id>`) deletes persisted mappings, counts only in output. Erasure is logical plus in-file best effort (`secure_delete` zeroes freed pages, `forget --all` also vacuums and truncates the WAL); physical-media and backup residue (SSD wear leveling, snapshots, restores) are out of scope. Switching the key source after enabling (keychain ↔ keyfile) refuses to open the store — it degrades memory-only until `forget --all` resets — rather than silently re-keying history.

**Persistence risk notes (read before enabling):** the design is dual-secret — the DB file alone or the key alone exposes nothing; both together do. Backups (Time Machine, cloud sync) copy `SGP.db`: `forget` cannot reclaim what a backup already captured, and a restored backup plus a surviving key can re-identify old sessions — treat backup retention accordingly. The keychain defends offline file theft (stolen disk, stolen backups, a copied `SGP.db`); it does not defend malware already running inside your login session. The keyfile option lowers the bar to "both files from the same directory tree" and is intended for headless/server environments without a keychain service.

**Restart limitation in both levels:** replayed originals can establish new mappings, but old tokens cannot be reconstructed from token text. Some provider tool-call arguments remain tokenized when published to history, even though the local execution gate restores them before execution. Thus complete token-free history and seamless restart recovery are not established; an unresolved write/execute argument still refuses with no side effects. Local originals may remain in history, logs, and generated files — this protects the model boundary, not your disk.

**Transparent capacity and lifecycle:** the guard uses an 8 Mi UTF-16-unit combined input/output budget and 100,000 value nodes per protect/restore operation, rather than applying the standalone core's 1 Mi-unit budget to an entire history. HTTP bodies and WS frames retain their 4 MiB limits; scanner `max_chars`, depth 32, mapping-entry and aggregate mapping-memory caps remain enforced. Up to 4,096 sessions can be retained per guard instance; live mappings are never LRU-evicted to admit another session. The public V2 `session.deleted` event releases only that session's RAM, prepared-response proof and WS buffers. Idle, completed and interrupted sessions retain mappings for resume. Missing/failed lifecycle subscriptions retain mappings until unload, so capacity remains finite, not an unlimited-lifetime guarantee. Deletion does not erase encrypted persisted rows: TTL/explicit `forget` remain their retention policy. [Local verification and remaining live-test gap](docs/evidence/2026-10-14-transparent-capacity-verification.md).

**Native OpenAI transport:** wire mode retains an HTTP preference for native OpenAI providers; explicit provider configuration has higher precedence. Hook-only makes no provider transport transformation. Supported Responses-family WS ingress can restore display deltas without LeakShield handshake/send registrations, starting from a validated `response.created` in a prepared session/kind/model scope. No endpoint, credential, or persisted configuration is changed. Real subscription authentication and complete restart recovery remain separate from local capture evidence.

**OpenCode v2 only — email de-identification trial:** the opt-in `deidentify` option (valid only together with `mode: "redact"`) additionally replaces repeated MEDIUM email findings with stable, opaque `[SG-EMAIL-…]` placeholders so an agent can correlate records without seeing the addresses. The mapping key is generated once per plugin setup (one OpenCode session), held in memory only, and never persisted — placeholders are stable within a live session but change after a restart, and no reverse mapping exists. Everything else keeps its existing disposition: HIGH credentials are still redacted/blocked, and truncated, encoded, or unverifiable content blocks the whole unit.

```jsonc
{ "package": "/absolute/path/to/leakshield/dist", "options": { "mode": "redact", "deidentify": true } }
```

**Opt-in readonly env queries (both versions):** the `envQueries` option (default `false`) exposes three read-only tools over the files listed in `settings.env_files`, so an agent can answer configuration questions without ever seeing values. It does not work with transparent mode, so on v2 set `mode` to `block` or `redact` explicitly:

| Tool | Contract |
|---|---|
| `guard_env_list` | Opaque session-local file ids plus key names — never paths, values, lengths, or previews. |
| `guard_env_inspect(file_id, key)` | `missing` \| `empty` \| `nonempty`; when nonempty, a coarse lexical shape `boolean_like` \| `number_like` \| `multiline_text` \| `text`. A shape is a lexical hint, never a claim the value is a valid boolean or number. |
| `guard_env_compare(left_file_id, left_key, right_file_id, right_key)` | `equal` \| `different` \| `unavailable` for key-to-key, same- or cross-file equality. Missing keys and unreadable files are `unavailable`. |

```jsonc
{ "package": "/absolute/path/to/leakshield/dist", "options": { "mode": "block", "envQueries": true } }
```

Ground rules: only `settings.env_files` entries are queryable (at most 16 files, 1 MiB each). File ids are only valid in the session that listed them. Files are re-read on every call, and a comparison reads both operands in one per-call snapshot. Raw values, value lengths, previews, fingerprints, and reverse mappings never appear in any output. If the guard configuration file changes after setup, the tools return a fixed restart-required error until OpenCode restarts — they never silently fall back to the old or new authorization.

File access is best-effort pathname identity validation, not a sandbox. The workspace root is frozen at setup (resolved path plus device/inode identity); every query re-stats the root and each ancestor directory before opening and again after reading, rejects symlinks on any path component — including ancestor directories that resolve elsewhere, even inside the workspace — requires regular files, opens the fully resolved canonical path with `O_NOFOLLOW` and `O_NONBLOCK`, and binds the opened descriptor to the statted inode with pre- and post-read size and mtime checks. Limitations, stated honestly: malicious concurrent filesystem mutation by the same owner is outside this threat model — a substitution that is reverted between two checks (an ABA race on the root, an ancestor directory, or the file) is not detectable by pathname checks, hardlinks are not distinguished from the original file (provenance is not checked), in-place rewrites that preserve size and mtime are not distinguishable, and the agent can modify env files through other tools — so results describe the current file state, not a trusted baseline. Key names themselves are returned as-is and pass through the normal output/history protection. On OpenCode v1 the tools are registered through the standard v1 tool API (`@opencode-ai/plugin`), which the v1 host provides.

Attachments: transparent mode supports an `attachments` policy (plural; `attachment` is not recognized). **`"block"` (default)** omits media/file parts at content hooks and replaces them with a notice; the model cannot read those omitted images. Final wire protection also refuses residual wire attachment parts; hook-first does not inspect late-added attachments. **`"allow"`** sends attachments through unscanned and appends a visible notice part — an explicit decision that you vouch for their content (`"allow"` requires `mode: "transparent"`). In block/redact modes attachments are blocked as before. Existing conversations can replay originals, subject to the restart limitations above; starting a new conversation is not a substitute for verifying recovery. The plugin protects OpenCode model requests only, not other AI clients or local tools.

OpenCode currently logs and skips modules that fail before their plugin factory can run, such as a missing package or JavaScript syntax error. After installation or upgrade, run a smoke test with a synthetic key matching `sk-` followed by at least 20 letters or digits and verify that LeakShield replaces the message before using real sensitive data.

#### Isolated smoke test (OpenCode v2)

Run this from the project root. It uses a temporary working directory and a synthetic value, not a real credential:

```bash
npm run build
SMOKE_DIR="$(mktemp -d)"
PROJECT_DIR="$(pwd)"
cat > "$SMOKE_DIR/opencode.json" <<EOF
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "$PROJECT_DIR/dist", "options": { "mode": "block" } }
  ]
}
EOF
(cd "$SMOKE_DIR" && opencode run --standalone \
  "Smoke test only. Do not reveal or use this token: sk-AAAAAAAAAAAAAAAAAAAA")
rm -rf "$SMOKE_DIR"
```

The model-facing message must contain the LeakShield block notice and must not contain the synthetic token. Do not use a real credential for this test.

To test the published package, use `"leakshield"` instead of the local `dist` path.

#### Automated install check: `--doctor`

```bash
npm run scan -- --doctor     # or: leakshield --doctor after global install
```

The doctor verifies the install without sending anything anywhere: it checks the OpenCode host version, finds `opencode.json` (workspace then global), confirms LeakShield is registered with options that the plugin itself would accept, verifies a local `dist` entry point actually exists (a missing one makes OpenCode silently log-and-skip the plugin — sessions look normal but are unprotected), loads the guard config, and runs the synthetic-canary smoke scan locally. Exit code 0 means `PROTECTED` (v2) or `PARTIAL` (v1: session hooks only; v2 with `wireProtection: false`: final outbound HTTP bodies are not inspected); any other status prints the failing check with a concrete fix, including a copy-paste registration snippet when the plugin is missing.

Doctor is an install-level check that runs outside the host — it cannot see inside a live session. Runtime proof comes from the smoke test above or `scripts/e2e/run-boundary.mjs`.

### What this protects — and what it does not

LeakShield protects model-conversation content: prompts, replayed history, tool outputs, and (in transparent mode) provider-bound request bodies whose shape it can parse. It is **not** a tool-egress firewall: a permitted local tool can still transmit originals over the network via `curl`, a remote MCP server, or any other channel. Controlling tool destinations requires a separate permission layer outside this plugin.

Detection also has known gaps: street/postal addresses, dates, IPv6, and generic assignments outside the keyword list or below the 8-character minimum pass through undetected. Credit card and IBAN numbers are detected only when the checksum validates; IP detection covers public IPv4 only; URL detection exists but is opt-in — see [Detection Coverage](#detection-coverage).

---

## Configuration

LeakShield loads the first config file it finds: `./config/guard.config.yaml`, then `config/guard.config.yaml` in the LeakShield directory (source builds only), then `~/.leakshield/guard.config.yaml`. With no file, the built-in defaults apply. The OpenCode plugin also accepts a `configPath` option. To start a new file, copy [`config/guard.config.example.yaml`](config/guard.config.example.yaml) and replace its sample keywords and domains.

### Exact `.env` Value Detection

Enable this only for files whose values should never enter an LLM context:

```yaml
settings:
  env_files:
    - .env
    - .env.local
```

Paths are relative to the workspace root and must remain inside it. LeakShield reads non-empty values of at least eight characters, then detects exact occurrences in text sent to the model. It does not automatically read `.env`, process environment variables, or send, log, or serialize the loaded values. Restart OpenCode after changing an enabled env file. The opt-in `envQueries` plugin tools (see OpenCode Plugin) query these same files and never return their values.

```yaml
# NDA keywords (case-insensitive)
nda_keywords:
  - "CONFIDENTIAL"
  - "INTERNAL ONLY"
  - "DO NOT SHARE"
  - "NDA"
  - "PROPRIETARY"
  # Add your own internal keywords:
  # - "Project Phoenix"
  # - "MyCompany Internal"

# Private domains
private_domains:
  - "internal.mycompany.com"
  # - "dev.yourcompany.io"

settings:
  max_chars: 200000      # Truncate if exceeded to avoid long scans
  show_line_numbers: true
  preview_length: 60
```

After editing:
- **CLI**: Reloaded automatically on next run
- **OpenCode Plugin**: Restart OpenCode to reload the plugin configuration
- **Web UI**: Restart the local server

### Custom Rules

```yaml
custom_rules:
  - description: "Company token"
    pattern: "MYCO_[A-Z0-9]{32}"
    severity: HIGH
    flags: "i"            # subset of gimsuy; g is always implied
    word_boundary: true   # \b only at literal ASCII word edges
    allow:                # exact strings this rule never reports
      - "MYCO_EXAMPLE0000000000000000000000000"
    # path: ["src/**"]    # accepted, but NOT implemented (see below)

settings:
  allowlist:              # exact strings no rule reports (see the bypass warning)
    - "qa@example.com"
```

- **`flags`** — any subset of `gimsuy`; `g` is always added. The default is `i`, so
  existing rules keep matching case-insensitively. An unknown flag (such as `x`)
  fails the config load, and the pattern is compiled with the final flags, so a
  pattern that is only invalid under `u` also fails the load.
  Zero-length matches are skipped (they contain no value to report or redact);
  scanning continues to later nonempty matches, including under Unicode flags.
- **`word_boundary`** — adds `\b` where the pattern's edge is a literal ASCII word
  character. A CJK edge (「機密」) is left alone: `\b` never holds between two
  non-word characters, and wrapping it would stop the rule matching. An edge that
  is a group, character class, quantifier or escape cannot take a boundary safely,
  so none is added and `--doctor` warns that the rule is looser than it looks —
  write `\b` in the pattern yourself, e.g. `\bEMP-\d{6}\b`. A top-level alternation
  (`a|b`) is a config error; group it as `(?:a|b)`.
- **`allow` / `settings.allowlist`** — exact matches against the matched text, not
  substrings and not regexes. `allow` applies to that rule; `settings.allowlist`
  applies to every rule, including the built-in ones and exact `.env` values.
  Caps: 32 entries per rule, 64 globally, 200 characters each.
  **Allowlisting a live secret is a real bypass**: the value still leaves the
  machine unmasked, and LeakShield will not report that value as a rule or
  `.env` finding. Use it only for values you have decided are not sensitive.
  Unicode evasion diagnostics are separate: a zero-width or look-alike-letter
  warning means removing those characters exposes a finding the raw text hides,
  and an allowlist on the raw text does not silence it. Cyrillic or Greek text
  on its own is not flagged. `--doctor` reports how many entries exist, exercises up to eight
  of them, and reports how many it could not exercise (a context-dependent
  pattern can only be judged in place). Suppressions are counted rather than
  silent.
- **`path`** — accepted and validated, but path scoping is **not implemented**: the
  scanner has no source path for prompts or tool output. These rules currently
  apply to every scanned text, and `--doctor` warns when `path` is set.

Allowlist entries are part of the config file, so they change its fingerprint
(sha256 of the file), which is what authorizations compare against.

---

## Practical Examples

### Scenario 1: Asking OpenCode to review a config file

With `mode: "block"`, shown below. In the v2 default, transparent mode, the model sees a placeholder instead and the task continues.

```
You (to OpenCode): Please review this config.ts for issues
OpenCode: [reads config.ts]
→ Tool output contains an API_KEY
→ Plugin replaces it before the next model turn
→ OpenCode receives a block notice instead of the secret
You: Replace line 12 with a dummy key, then continue
```

### Scenario 2: CLI scan before submitting a project

```bash
npm run scan -- --dir ./my-project
# If exit code = 1, there are findings — fix them before sharing with AI
```

### Scenario 3: CI/CD integration (block sensitive prompts from the pipeline)

```bash
# Add to your CI script
node dist/cli.js --cli --dir ./prompts
if [ $? -ne 0 ]; then
  echo "❌ Sensitive content detected — stopping pipeline"
  exit 1
fi
```

---

## Configuration Validation

Input lengths for dynamic rules are validated when the config is loaded:

| Field | Max length |
|-------|-----------|
| `nda_keywords` entries | 200 characters |
| `private_domains` entries | 255 characters |
| `custom_rules` `description` / `pattern` | 200 characters |

Values exceeding these limits will cause `loadConfig()` to throw a Zod validation error, preventing oversized patterns from entering the scanner.

A `custom_rules` pattern that does not compile as a regular expression also makes `loadConfig()` throw, naming the rule's index and `description` (not the pattern): a rule that cannot be enforced must not load. A pattern that compiles but runs slowly on a fixed probe input is skipped as a ReDoS suspect, with a warning on stderr and a `custom-rules` warning in `leakshield --doctor`. That check is a timing heuristic, not a guarantee: it runs the pattern once and cannot interrupt it, so it cannot prove a pattern safe.

## Secret Preview Behavior

All secret previews in scan results are **fully masked** as `****`, regardless of the secret's length. No prefix or suffix characters from the original value are preserved. This eliminates partial secret exposure in logs, CI output, and Web UI responses.

## Internationalization (i18n)

CLI output language is controlled by the `LEAKSHIELD_LANG` environment variable.

| Value | Language |
|-------|----------|
| `en` (default) | English |
| `zh-TW` or `zh` | Traditional Chinese |

```bash
# English output (default)
npm run scan -- --text "your content"

# Traditional Chinese output
LEAKSHIELD_LANG=zh-TW npm run scan -- --text "你的內容"
```

You can also set it persistently in your shell profile:

```bash
export LEAKSHIELD_LANG=zh-TW
```

## Notes

- This tool performs **static pattern matching** and cannot guarantee 100% coverage
- **Common false positives**: literal test values long enough to match (e.g. `password: "aaaaaaaa"`), placeholder values in example code
- The tool is meant to **warn**, not guarantee — final judgment is always yours
- Keep NDA keywords focused on truly confidential terms to avoid excessive false positives
