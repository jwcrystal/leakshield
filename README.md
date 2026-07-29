# 🛡️ sensitive-guard

> 🌐 English | [繁體中文](./README.zh-TW.md)

**A gatekeeper that scans for sensitive content before you feed code, documents, or data to AI services.**

Three supported modes:
- **OpenCode Plugin**: The enforced ingress gate for OpenCode. Use this when OpenCode sends content to a model.
- **CLI**: Manual or CI scanning of text, files, and directories; supports redaction.
- **Web UI**: Local browser interface and REST endpoint for manual scanning.

MCP server mode has been removed. It depended on the model voluntarily calling a scan tool after it had already received the relevant context, so it cannot provide the plugin's security boundary.

| Mode | Start it with | Use it for |
|------|---------------|------------|
| OpenCode Plugin | Add `dist/opencode.js` to `opencode.json` | Automatic, fail-closed protection for OpenCode model inputs and tool outputs |
| CLI | `npx sensitive-guard --file ./path` | Explicit local or CI scans; it never sends content to a model |
| Web UI | `npm run web` | Manual browser scans at `http://localhost:3000` |

---

## Detection Coverage

| Type | Description | Severity |
|------|-------------|----------|
| API Key | OpenAI, Anthropic, Google, AWS | 🔴 HIGH |
| Secret / Password | Generic password assignments, AWS Secret | 🔴 HIGH |
| Token | GitHub PAT, JWT, Bearer Token | 🔴 HIGH |
| DB Connection String | MongoDB, PostgreSQL, MySQL, Redis, etc. | 🔴 HIGH |
| Taiwan National ID | Format validation | 🔴 HIGH |
| Email Address | All email formats | 🟡 MEDIUM |
| Taiwan Mobile Number | 09xx-xxx-xxx | 🟡 MEDIUM |
| International Phone | +country-code format | 🟢 LOW |
| NDA Keywords | Custom (see `config/guard.config.yaml`) | 🔴 HIGH |
| Private Domains | Custom (see `config/guard.config.yaml`) | 🟡 MEDIUM |

---

## Decision Model

Every scan produces a **decision** that tells the caller how to handle the content:

| Decision | When | Risk Level | Meaning |
|----------|------|-----------|---------|
| `ALLOW` | No findings | LOW | Content is clean — safe to send |
| `WARN` | LOW-severity findings only | MEDIUM | Minor items detected — reminder shown, content can be sent |
| `CONFIRM` | MEDIUM or HIGH findings | HIGH / CRITICAL | Sensitive content detected — user must explicitly confirm |

### CONFIRM Actions

When the decision is `CONFIRM`, the CLI presents three options:

1. **cancel** — do not send this content
2. **send redacted** — use the sanitized version with sensitive spans replaced by `[REDACTED_TYPE]` placeholders
3. **send original** — proceed at your own risk

The `CONFIRM` decision also includes:
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

```bash
git clone https://github.com/jwcrystal/sensitive-guard.git
cd sensitive-guard
npm install
npm run build
```

After building, use `npx sensitive-guard`. If installed globally, use
`sensitive-guard` directly. `npm run scan -- ...` remains available for local
development from this repository.

### npm Scripts Reference

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript → `dist/` |
| `npm run dev` | CLI mode (no build needed) |
| `npm run scan` | CLI scan (no build needed) |
| `npm run web` | Start the local Web UI (no build needed) |
| `npm test` | Run unit tests |

---

## Usage

### CLI

```bash
# Scan text
npx sensitive-guard --text 'sk-proj-test1234567890abcdef my_password="super_secret"'

# Scan a single file
npx sensitive-guard --file ./src/config.ts

# Scan an entire directory
npx sensitive-guard --dir ./src

# Scan specific file extensions only
npx sensitive-guard --dir ./src --ext .ts .env .json

# Read from stdin
cat .env | npx sensitive-guard --stdin

# Global installation
sensitive-guard --file ./config.ts
```

Exit codes: `0` = safe (ALLOW), `1` = findings detected (WARN or CONFIRM), `2` = file not found

#### Redaction Mode

Replace sensitive content with `[REDACTED_TYPE]` placeholders instead of just reporting it:

```bash
# Redact stdin and print to stdout
echo 'token=sk-proj-test1234567890abcdef' | npx sensitive-guard --redact --stdin

# Redact a file and write result to a new file
npx sensitive-guard --redact --file .env --out .env.redacted

# Dry-run: preview what would be redacted without producing any output
npx sensitive-guard --redact --dry-run --file .env
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

#### Workspace Path Restriction

By default, `--file` and `--dir` only accept paths **inside the current working directory**. Attempts to scan outside (e.g. `../shared.env` or `/etc/passwd`) will be rejected with an error.

To intentionally scan a path outside the workspace, pass `--allow-outside`:

```bash
npx sensitive-guard --file ../shared.env --allow-outside
```

> ⚠️ Outside-workspace scanning is opt-in. Only use it when you explicitly need to scan a file that lives outside the project root.

---

### Web UI

Start a local web server and use it in your browser:

```bash
# Default port 3000
npx tsx src/index.ts --web

# Custom port
npx tsx src/index.ts --web --port 3001

# Built version
node dist/index.js --web --port 3001
```

Open `http://localhost:3001` in your browser, paste content, and press **Scan** or `Ctrl+Enter`.

#### REST API

You can also call the API directly:

```bash
# Scan text
curl -s -X POST http://localhost:3001/scan \
  -H 'Content-Type: application/json' \
  -d '{"content": "sk-proj-abc123 secret_key=test"}' | jq

# Response format
{
  "safe": false,
  "total_findings": 2,
  "findings": [
    { "type": "API_KEY", "severity": "HIGH", "line": 1, "preview": "****", "description": "OpenAI API Key" }
  ],
  "summary": "...",
  "recommendation": "..."
}
```

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Web UI HTML |
| `/scan` | POST | Scan `{ "content": string }`, returns JSON |

---

### OpenCode Plugin (recommended)

When loaded successfully, the OpenCode plugin is the enforced integration. It scans and blocks user text before OpenCode persists or sends it to a model, sanitizes system prompts and tool definitions, protects tool output before the next model turn, and re-scans history before replay. It always enables encoded-content detection. Invalid plugin options or scanner configuration make every protected hook fail closed and abort the model request. A bounded SHA-256 decision cache avoids repeatedly scanning unchanged history without retaining original or redacted content.

Build the project, then add the compiled plugin to `opencode.json`:

```json
{
  "plugin": [
    [
      "file:///absolute/path/to/sensitive-guard/dist/opencode.js",
      { "mode": "block" }
    ]
  ]
}
```

`block` is the default and replaces unsafe content with a disclosure-free notice. Set `mode` to `redact` only when you explicitly want recognized direct matches replaced with `[REDACTED_TYPE]` placeholders.

Attachments are blocked because the text scanner cannot safely inspect arbitrary binary or remote attachment content. Existing sessions may already contain raw content; begin a new session after installing the plugin. The plugin protects OpenCode model requests only, not other AI clients or local tools.

OpenCode currently logs and skips modules that fail before their plugin factory can run, such as a missing package or JavaScript syntax error. After installation or upgrade, run a smoke test with a synthetic key matching `sk-` followed by at least 20 letters or digits and verify that Sensitive Guard replaces the message before using real sensitive data.

#### Isolated smoke test

Run this from the project root. It uses a temporary OpenCode configuration directory and a synthetic value, not a real credential:

```bash
npm run build
SMOKE_DIR="$(mktemp -d)"
PROJECT_DIR="$(pwd)"
cat > "$SMOKE_DIR/opencode.json" <<EOF
{
  "plugin": [
    ["file://$PROJECT_DIR/dist/opencode.js", { "mode": "block" }]
  ]
}
EOF
OPENCODE_CONFIG_DIR="$SMOKE_DIR" opencode --prompt \
  "Smoke test only. Do not reveal or use this token: sk-AAAAAAAAAAAAAAAAAAAA"
rm -rf "$SMOKE_DIR"
```

The model-facing message must contain the Sensitive Guard block notice and must not contain the synthetic token. Do not use a real credential for this test.

After publishing to npm, the same plugin can be configured as `"sensitive-guard"` instead of the `file:` URL.

<!-- Legacy transport row intentionally hidden.
| `scan_dir` | Scan an entire directory (recursive, skips node_modules / .git). Returns per-file results |
-->

---

## Configuration

Edit `config/guard.config.yaml`:

### Exact `.env` Value Detection

Enable this only for files whose values should never enter an LLM context:

```yaml
settings:
  env_files:
    - .env
    - .env.local
```

Paths are relative to the workspace root and must remain inside it. Sensitive Guard reads non-empty values of at least eight characters, then detects exact occurrences in text sent to the model. It does not automatically read `.env`, process environment variables, or send, log, or serialize the loaded values. Restart OpenCode after changing an enabled env file.

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

---

## Practical Examples

### Scenario 1: Asking OpenCode to review a config file

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
npm run cli -- --dir ./my-project
# If exit code = 1, there are findings — fix them before sharing with AI
```

### Scenario 3: CI/CD integration (block sensitive prompts from the pipeline)

```bash
# Add to your CI script
node dist/index.js --cli --dir ./prompts
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

Values exceeding these limits will cause `loadConfig()` to throw a Zod validation error, preventing oversized patterns from entering the scanner.

## Secret Preview Behavior

All secret previews in scan results are **fully masked** as `****`, regardless of the secret's length. No prefix or suffix characters from the original value are preserved. This eliminates partial secret exposure in logs, CI output, and Web UI responses.

## Internationalization (i18n)

CLI output language is controlled by the `SENSITIVE_GUARD_LANG` environment variable.

| Value | Language |
|-------|----------|
| `en` (default) | English |
| `zh-TW` or `zh` | Traditional Chinese |

```bash
# English output (default)
npx sensitive-guard --text "your content"

# Traditional Chinese output
SENSITIVE_GUARD_LANG=zh-TW npx sensitive-guard --text "你的內容"
```

You can also set it persistently in your shell profile:

```bash
export SENSITIVE_GUARD_LANG=zh-TW
```

## Notes

- This tool performs **static pattern matching** and cannot guarantee 100% coverage
- **Common false positives**: test/dummy keys (e.g. `sk-test123456`), placeholder values in example code
- The tool is meant to **warn**, not guarantee — final judgment is always yours
- Keep NDA keywords focused on truly confidential terms to avoid excessive false positives
