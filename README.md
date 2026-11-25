<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./icon.svg">
  <img alt="leakshield" src="./icon.svg" width="64">
</picture>

# leakshield

> 🌐 English | [繁體中文](./README.zh-TW.md)

**A gatekeeper that scans for sensitive content before you feed code, documents, or data to AI services.**

> **Design principles:** Invisible by default. Observable on demand. Fail-closed at the model boundary.
> New adapter work is built and accepted against these ([ADR 0008](docs/adr/0008-transparent-protection-and-native-ux.md)). They are a contract for adapter work, not a claim that every host meets them today; see [host capabilities](docs/host-capabilities.md) for current status.

Five entry points share one scanner and decision model:
- **OpenCode plugin**: The enforced ingress gate for OpenCode v2, at its content hooks and, in transparent mode, the final provider body.
- **pi extension**: An in-process pi extension that guards the agent's provider requests through the shared wire core and restores local tool arguments.
- **Claude Code proxy** (experimental): A local proxy behind `ANTHROPIC_BASE_URL` that masks Anthropic Messages requests and restores assistant text.
- **CLI**: Manual or CI scanning of text, files, and directories; supports redaction.
- **Web UI**: Local browser interface and REST endpoint for manual scanning.

MCP server mode has been removed. It depended on the model voluntarily calling a scan tool after it had already received the relevant context, so it cannot provide a model-boundary guarantee.

| Entry point | Start it with | Use it for |
|------|---------------|------------|
| OpenCode plugin | Add the `leakshield` package or the `dist` directory to `opencode.json` (OpenCode v2; [guide](docs/opencode.md)) | Automatic, fail-closed protection for OpenCode model inputs and tool outputs |
| pi extension | `pi install npm:leakshield` (0.4.0+, or `pi install /absolute/path/to/built/leakshield` for a local build; [guide](docs/pi.md)) | Masked pi provider requests and restored read/write/edit/bash arguments |
| Claude Code proxy | `leakshield --claude-code-proxy`, then `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` ([guide](docs/claude-code.md)) | Masked Claude Code model requests and restored assistant text; tool arguments are not restored yet |
| CLI | `npm run scan -- --file ./path` (or `leakshield --file ./path` after a global install / `npm link`) | Explicit local or CI scans; it never sends content to a model |
| Web UI | `npm run web` | Manual browser scans at `http://localhost:3000` |

## Project status

**Experimental, `0.x`.** Published to npm as `leakshield`: run `npx leakshield --help` to see the commands, or build locally (`npm ci && npm run build`) and point a host at the build. Run without arguments in a terminal, the CLI prints usage. When stdin is not a terminal (a pipe, CI or a script), it reads stdin until EOF, so close or redirect stdin there.

None of the hosts is a guarantee that nothing sensitive reaches a model. `leakshield --doctor <host>` prints each host's declared coverage and residuals; the [host capability matrix](docs/host-capabilities.md) summarizes them.

- **OpenCode**: transparent mode verified on OpenCode v2.0.28 with local loopback providers, and once against a real OpenAI model. The 0.3.0 tool restoration was rechecked on OpenCode v2.2.5 with a loopback provider, the OpenChamber render tool and `rtk` ([record](docs/evidence/2026-11-06-opencode-2.2.5-tool-restoration.md)). The hook-first setup is reported as `PARTIAL` by `--doctor`, and content added after the plugin's hooks or sent by permitted tools (curl, remote MCP) is outside its coverage. See [OpenCode plugin](docs/opencode.md).
- **pi**: an in-process extension wraps the agent's `fetch`, masks the three wire APIs it supports, and restores read/write/edit/bash arguments locally. Verified against pi 1.6.0 with a recording stub upstream ([record](docs/evidence/2026-11-23-pi-extension.md)); providers whose transport bypasses fetch (Codex WebSocket, Bedrock) are refused, and OAuth-only accounts are not supported. See [pi adapter](docs/pi.md).
- **Claude Code** (experimental): a local proxy (`leakshield --claude-code-proxy`, then `ANTHROPIC_BASE_URL`), verified with Claude Code 2.1.321 against a loopback stub upstream ([record](docs/evidence/2026-11-21-claude-code-proxy.md)). It masks model requests and restores assistant text, but does not restore placeholders at tool execution yet. See [Claude Code](docs/claude-code.md).
- Not yet verified: OS-keychain custody on Windows and Linux (macOS verified 2026-10-20), a real Anthropic provider, long histories on other providers, long-running use ([#26](https://github.com/jwcrystal/leakshield/issues/26)).
- Defaults may still change during `0.x`; see the [changelog](CHANGELOG.md).
- Verification records: [docs/evidence](docs/evidence/README.md). Report vulnerabilities privately: [SECURITY.md](SECURITY.md). License: [Apache-2.0](LICENSE).

---

## Quickstart

Install once (Node.js 20 or later; the pi extension needs Node.js 22.19 or later):

```bash
npm install -g leakshield
```

Then connect the host you use and check it with `leakshield --doctor <host>`. Exit code 0 means `PROTECTED` or `PARTIAL`. The doctor checks the install outside the host and cannot see inside a live session, so finish with a synthetic-value test before using real data. Never use a real credential for that test.

### OpenCode v2

1. Register the plugin in your project's `opencode.json`. With no options, `mode` defaults to `transparent`:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": [{ "package": "leakshield" }]
   }
   ```

2. Check the install; see [what `PARTIAL` means](docs/opencode.md#what-partial-means):

   ```bash
   leakshield --doctor opencode
   ```

3. Run the smoke test. It uses a temporary directory and a synthetic value:

   ```bash
   SMOKE_DIR="$(mktemp -d)"
   cat > "$SMOKE_DIR/opencode.json" <<'JSON'
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": [{ "package": "leakshield", "options": { "mode": "block" } }]
   }
   JSON
   (cd "$SMOKE_DIR" && opencode run --standalone \
     "Smoke test only. Do not reveal or use this token: sk-AAAAAAAAAAAAAAAAAAAA")
   rm -rf "$SMOKE_DIR"
   ```

   The model-facing message must contain the LeakShield block notice and must not contain the synthetic token.

### pi

1. Install the pi package (it registers the extension in `settings.packages`):

   ```bash
   pi install npm:leakshield
   ```

2. Check the install. A package install reports `PARTIAL` because pi's load order cannot be verified; for `PROTECTED`, register the extension first in `settings.extensions` instead ([explicit path](docs/pi.md#explicit-extension-path)):

   ```bash
   leakshield --doctor pi
   ```

3. Send pi a synthetic value such as `sk-AAAAAAAAAAAAAAAAAAAA` and confirm the provider receives a placeholder. See [pi adapter](docs/pi.md) for the provider APIs it supports.

### Claude Code (experimental)

1. Start the proxy and leave it running:

   ```bash
   leakshield --claude-code-proxy        # listens on 127.0.0.1:8787
   ```

2. Point Claude Code at it, in the shell or in the `env` block of `~/.claude/settings.json`:

   ```bash
   export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
   ```

3. Check the wiring:

   ```bash
   leakshield --doctor claude-code
   ```

Tool-call arguments are not restored yet, and traffic that bypasses the base URL is not covered; see [Claude Code](docs/claude-code.md).

### CLI only

```bash
leakshield --file ./path/to/file
```

Before relying on any host, read [what this protects — and what it does not](#what-this-protects--and-what-it-does-not). For source builds and other options, see [Installation](#installation). New contributors: [3-minute onboarding](docs/ONBOARDING.zh-TW.md) (Traditional Chinese only).

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
| NDA Keywords | Defaults plus your own (see [Configuration](#configuration)) | 🔴 HIGH |
| Private Domains | Your own (see [Configuration](#configuration)) | 🟡 MEDIUM |

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

`safePreview` and `redactedContent` are left out when a sensitive span cannot be located exactly, such as an encoded run split by a zero-width character. A missing field means no safe version is available.

### JSON Output Fields

When using `--format json`, the output includes these decision-oriented fields:

| Field | Description |
|-------|-------------|
| `decision` | `ALLOW`, `WARN`, or `CONFIRM` |
| `riskLevel` | `LOW`, `MEDIUM`, `HIGH`, or `CRITICAL` |
| `recommendedAction` | `REVIEW` or `BLOCK` (CONFIRM only) |
| `findings` | Array of sanitized findings (no internal metadata) |
| `safePreview` | Masked excerpt (CONFIRM only; can be absent) |
| `redactedContent` | Full redacted text (CONFIRM only; can be absent) |

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

The binary is the CLI compiled into one executable (`src/cli.ts`), not a separate mode:

| Feature | Binary |
|---------|--------|
| CLI scan and redaction, Web UI | Supported |
| `--claude-code-proxy`, `--doctor` | Included but not verified in a Bun-compiled binary; use the npm package for host protection |
| OpenCode plugin, pi extension | Not available: the host loads the npm package, not an executable |

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

### What this protects — and what it does not

LeakShield protects model-conversation content: prompts, replayed history, tool outputs, and provider-bound request bodies whose shape it can parse. How much of that each host covers differs; `leakshield --doctor <host>` and the [host capability matrix](docs/host-capabilities.md) list it. It is **not** a tool-egress firewall: a permitted local tool can still transmit originals over the network via `curl`, a remote MCP server, or any other channel. Controlling tool destinations requires a separate permission layer outside LeakShield. Since 0.3.0, `curl` and `http` may also hold a placeholder inside an argument, so a tool can call an API with the protected value; the original then leaves the machine by design.

Detection also has known gaps: street/postal addresses, dates, IPv6, and generic assignments outside the keyword list or below the 8-character minimum pass through undetected. Credit card and IBAN numbers are detected only when the checksum validates; IP detection covers public IPv4 only; URL detection exists but is opt-in — see [Detection Coverage](#detection-coverage).

Local originals may remain in history, logs, and generated files — this protects the model boundary, not your disk.

---

### OpenCode plugin

When loaded successfully, the OpenCode plugin is the enforced integration. It scans and blocks user text before OpenCode persists or sends it to a model, sanitizes system prompts and tool definitions, protects tool output before the next model turn, and re-scans history before replay. In transparent mode (the default) it also validates the final provider body. Invalid plugin options or scanner configuration make every protected hook fail closed and abort the model request. OpenCode v2 only.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "leakshield" // or "/absolute/path/to/leakshield/dist"
      // Add "options": { "mode": "block" } to refuse instead of pseudonymize.
    }
  ]
}
```

Modes, `PARTIAL`, attachments, email de-identification, the isolated smoke test and what `--doctor` checks: [OpenCode plugin](docs/opencode.md). Feature guides: [transparent mode](docs/plugin/transparent-mode.md), [wire protection](docs/plugin/wire-protection.md), [native WebSocket](docs/plugin/websocket.md), [mapping persistence](docs/plugin/persistence.md), [capacity](docs/plugin/capacity.md), [readonly env queries](docs/plugin/env-queries.md).

---

### pi (in-process extension)

```bash
pi install npm:leakshield      # or: pi -e /path/to/leakshield/dist/adapters/pi/extension.js
leakshield --doctor pi         # checks registration, order and wire API
```

pi resolves `fetch` when it builds a provider client, including compaction and branch summaries, so an extension that wraps `globalThis.fetch` covers the same traffic the OpenCode plugin covers through its wire hook. Every provider request is masked in-process; assistant text is restored in the reply, and `read`, `write`, `edit`, `bash` and `powershell` arguments are restored at the local execution boundary. Session files stay with pi, so `--continue`, `--resume` and `--session` keep working. Verified against pi 1.6.0 with a recording stub; providers that bypass fetch (Codex WebSocket, Bedrock, Google auth) are refused, OAuth-only accounts are not supported, and loading the extension first keeps other extensions from holding the raw fetch. See [pi adapter](docs/pi.md).

---

### Claude Code (local proxy, experimental)

```bash
leakshield --claude-code-proxy                     # listens on 127.0.0.1:8787
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787    # or the "env" block of ~/.claude/settings.json
leakshield --doctor claude-code                    # checks the wiring
```

The proxy masks every Anthropic Messages request Claude Code sends (and `count_tokens`), restores placeholders in the assistant's JSON or streamed text, and blocks anything it cannot mask instead of forwarding it. It is verified with an API key; Claude Code documents that the base URL also applies to a claude.ai login, which has not been tested here. It does not restore placeholders inside tool calls, and it cannot see traffic that bypasses the base URL, such as WebFetch's domain check, which sends the hostname to Anthropic. Setup and the full list of gaps: [docs/claude-code.md](docs/claude-code.md).

---

### Across hosts

- [Host capability matrix](docs/host-capabilities.md): per-host declaration of which model egress and surfaces are protected, refused, absent, or outside interception, and the invariants a new adapter must satisfy
- [Agent hook coverage](docs/hooks.md): how OpenCode, pi and Claude Code expose hooks, and which hook points can mask a request or restore a placeholder

#### Persistence risk notes (read before enabling)

Mapping persistence is opt-in for the OpenCode plugin ([setup](docs/plugin/persistence.md)) and pi (`LEAKSHIELD_PI_PERSIST`, [setup](docs/pi.md#sessions-and-persistence)). The Claude Code proxy keeps mappings in memory only.

- The design is dual-secret — the DB file alone or the key alone exposes nothing; both together do.
- Backups (Time Machine, cloud sync) copy `SGP.db`: `forget` cannot reclaim what a backup already captured, and a restored backup plus a surviving key can re-identify old sessions — treat backup retention accordingly.
- The keychain defends offline file theft (stolen disk, stolen backups, a copied `SGP.db`); it does not defend malware already running inside your login session.
- The keyfile option lowers the bar to "both files from the same directory tree" and is intended for headless/server environments without a keychain service.

---

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
| `--redact` | Replace findings with `[REDACTED_TYPE]`, write to stdout; output is suppressed if findings remain after redaction |
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

#### Encoding Detection

**Why encoding detection?**

Encoding tricks can bypass sensitive-data detection:
- **Base64 encoding**: an API key or password is encoded before it is sent
- **URL encoding**: formats such as `%20` hide keywords
- **Hex encoding**: hexadecimal encoding evades pattern matching

**Enabling**

```bash
# Enable encoding detection
npm run scan -- --enable-encoding-detection --text "c2stcHJvai10ZXN0MTIzNDU2Nzg5MGFiY2RlZg=="

# Combine with other options
npm run scan -- --enable-encoding-detection --file ./config.yaml --format json

# Enable when scanning a directory
npm run scan -- --enable-encoding-detection --dir ./src --ext .ts .env
```

**Performance**

Decoding and rescanning can add 10-30% to scan time. Recommendations:
- **Off by default**: ordinary scans can use the default
- **Enable on demand**: turn it on for external or unknown content
- **CI/CD**: recommended in CI pipelines to catch encoding attacks

**Examples**

```bash
# Base64-encoded API key
echo "c2stcHJvai10ZXN0MTIzNDU2Nzg5MGFiY2RlZg==" | npm run scan -- --enable-encoding-detection --stdin
# → Detects an OpenAI API Key (synthetic value)

# URL-encoded sensitive content
echo "password%3Dsecret123" | npm run scan -- --enable-encoding-detection --stdin
# → Detects the password keyword

# Normal text is unaffected
echo "This is safe content" | npm run scan -- --enable-encoding-detection --stdin
# → Safe, no sensitive content
```

When encoded content is found, the text and JSON summaries name the encoding types, in the language set by `LEAKSHIELD_LANG`:

```
[WARNING: Encoded content: Base64, URL]
```

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

`redactedContent` is omitted when `redactionVerified` is `false`.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Web UI HTML |
| `/scan` | POST | Scan `{ "content": string }`, returns JSON |

---

## Configuration

LeakShield loads the first config file it finds: `./config/guard.config.yaml`, then `config/guard.config.yaml` in the LeakShield directory (source builds only), then `~/.leakshield/guard.config.yaml`. With no file, the built-in defaults apply. The OpenCode plugin also accepts a `configPath` option. The repository does not ship a `config/guard.config.yaml`, and Git ignores one you create there, so your keywords stay local. To start a new file, copy [`config/guard.config.example.yaml`](config/guard.config.example.yaml) and add your own keywords and domains. Listing `nda_keywords` replaces the four defaults (`CONFIDENTIAL`, `INTERNAL ONLY`, `DO NOT SHARE`, `NDA`); the example keeps them.

### Fields

Every key is optional. A key you leave out keeps its default; an unknown key is ignored.

| Key | Default | What it does | Details |
|-----|---------|--------------|---------|
| `nda_keywords` | `CONFIDENTIAL`, `INTERNAL ONLY`, `DO NOT SHARE`, `NDA` | Words reported as HIGH. Case-insensitive. A keyword that starts and ends with an ASCII letter or digit matches whole words (`NDA` does not match `agenda`); a CJK keyword matches as a substring. A list replaces the defaults; `[]` turns keywords off | — |
| `private_domains` | none | Hostnames reported as MEDIUM. Case-insensitive substring match; a full hostname gives fewer false matches | — |
| `custom_rules` | none | Your own regular expressions with a `description`, `pattern` and `severity` (`HIGH` by default) | [Custom Rules](#custom-rules) |
| `settings.max_chars` | `200000` | Scan bound per input. The CLI scans the first `max_chars` characters; transparent mode refuses longer content instead of truncating it | — |
| `settings.show_line_numbers` | `true` | Include line and column in findings | — |
| `settings.preview_length` | `60` | Length of the masked `safePreview` excerpt around the first finding | [Secret Preview Behavior](#secret-preview-behavior) |
| `settings.encoding_detection` | `false` | Also decode Base64, URL and Hex text before scanning (the OpenCode plugin always enables it) | [Encoding Detection](#encoding-detection) |
| `settings.env_files` | none | Files whose values are matched exactly | [Exact `.env` Value Detection](#exact-env-value-detection) |
| `settings.rule_overrides` | `{}` | Turn built-in rules on or off by id, e.g. `{ url: true, email: false }`. An unknown id fails the load | [Built-in rule ids](#built-in-rule-ids) |
| `settings.private_cidrs` | RFC 1918, CGNAT, link-local | IPv4 networks the opt-in `private-ipv4` rule reports. A list **replaces** the defaults, for example to match only your VPN. An invalid CIDR fails the load | — |
| `settings.allowlist` | none | Exact values no rule reports. **A real bypass**: the value reaches the model unmasked | [Custom Rules](#custom-rules) |

Length and count limits are listed under [Configuration Validation](#configuration-validation).

### Built-in rule ids

Use these ids in `settings.rule_overrides`. All rules are on by default except the four opt-in rules marked below.

| Group | Ids |
|-------|-----|
| API keys and tokens | `openai-key`, `anthropic-key`, `google-key`, `aws-access-key`, `aws-secret`, `github-pat`, `github-fine-grained-pat`, `github-oauth-app`, `stripe-live-secret`, `stripe-live-publishable`, `slack-bot`, `slack-user-app`, `huggingface-token`, `jwt`, `generic-bearer` |
| Secrets and credentials | `generic-secret`, `pem-private-key`, `url-userinfo`, `db-connection`, `db-connection-ado` |
| Personal and financial data | `email`, `id-tw`, `credit-card`, `iban`, `public-ipv4`, `phone-tw` (opt-in), `phone-intl` (opt-in) |
| Network | `private-ipv4` (opt-in), `url` (opt-in) |

An example that keeps the default keywords, adds a private domain and turns on `private-ipv4` for one network:

```yaml
nda_keywords:
  - "CONFIDENTIAL"
  - "INTERNAL ONLY"
  - "DO NOT SHARE"
  - "NDA"
  # - "Project Phoenix"     # your own terms

private_domains:
  - "internal.example.com"

settings:
  encoding_detection: false
  rule_overrides:
    private-ipv4: true
  private_cidrs:
    - 10.20.0.0/16          # replaces the default private networks
```

After editing:
- **CLI**: Reloaded automatically on next run
- **OpenCode Plugin**: Restart OpenCode to reload the plugin configuration
- **pi extension**: Restart pi (`LEAKSHIELD_CONFIG` selects another file)
- **Claude Code proxy**: Restart the proxy (`--config` selects another file)
- **Web UI**: Restart the local server

### Exact `.env` Value Detection

Enable this only for files whose values should never enter an LLM context:

```yaml
settings:
  env_files:
    - .env
    - .env.local
```

Paths are relative to the workspace root and must remain inside it. LeakShield reads non-empty values of at least eight characters, then detects exact occurrences in text sent to the model. It does not automatically read `.env`, process environment variables, or send, log, or serialize the loaded values. After changing an enabled env file, restart the host or proxy that loaded it (only the CLI re-reads on every run). The opt-in `envQueries` plugin tools (see [Readonly env queries](docs/plugin/env-queries.md)) query these same files and never return their values.

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

### Configuration Validation

Input lengths for dynamic rules are validated when the config is loaded:

| Field | Max length |
|-------|-----------|
| `nda_keywords` entries | 200 characters |
| `private_domains` entries | 255 characters |
| `custom_rules` `description` / `pattern` | 200 characters |

Values exceeding these limits will cause `loadConfig()` to throw a Zod validation error, preventing oversized patterns from entering the scanner.

List sizes are capped too, and a config over a cap fails the load:

| Field | Max entries |
|-------|-------------|
| `nda_keywords` | 4096 |
| `private_domains` | 4096 |
| `custom_rules` | 1024 |

A `custom_rules` pattern that does not compile as a regular expression also makes `loadConfig()` throw, naming the rule's index and `description` (not the pattern): a rule that cannot be enforced must not load. A pattern that compiles but runs slowly on a fixed probe input is skipped as a ReDoS suspect, with a warning on stderr and a `custom-rules` warning in `leakshield --doctor`. That check is a timing heuristic, not a guarantee: it runs the pattern once and cannot interrupt it, so it cannot prove a pattern safe.

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
