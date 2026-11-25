# CLI and Web UI

[← README](../README.md) · 🌐 English | [繁體中文](cli.zh-TW.md)

The CLI and the Web UI scan text you give them; they never send content to a model. For the host integrations that guard model requests, see the [README](../README.md#quickstart).

## CLI

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

### Redaction Mode

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

### CLI Options

| Option | Description |
|--------|-------------|
| `--format json` | JSON output (CI/CD friendly) |
| `--min-severity high` | Only report HIGH (or `medium` / `low`) |
| `--allow-outside` | Allow scanning paths outside the current working directory (disabled by default) |
| `--enable-encoding-detection` | Also decode Base64, URL-encoded and hex content before scanning (disabled by default) |

### Encoding Detection

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

### Workspace Path Restriction

By default, `--file` and `--dir` only accept paths **inside the current working directory**. Attempts to scan outside (e.g. `../shared.env` or `/etc/passwd`) will be rejected with an error.

To intentionally scan a path outside the workspace, pass `--allow-outside`:

```bash
npm run scan -- --file ../shared.env --allow-outside
```

> ⚠️ Outside-workspace scanning is opt-in. Only use it when you explicitly need to scan a file that lives outside the project root.

### Ignore Directives

The CLI and Web UI skip any line containing `leakshield-ignore`, `guard:skip`, `guard:ignore`, `sg-ignore`, `no-scan` or `skip-guard` (case-insensitive). A real secret on that line reports as `ALLOW`.

> ⚠️ Anyone who can edit a scanned file can add a directive, so a CLI scan is not a gate against untrusted changes. The host integrations (OpenCode plugin, pi extension, Claude Code proxy) do not honor directives.

## Web UI

Start a local web server and use it in your browser:

```bash
# Installed package (default port 3000)
leakshield --web

# From a checkout, without building
npx tsx src/cli.ts --web

# Custom port
npx tsx src/cli.ts --web --port 3001

# Built version
node dist/cli.js --web --port 3001
```

Open `http://localhost:3001` in your browser, paste content, and press **Scan** or `Ctrl+Enter`.

### REST API

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

## Decision Model

Every scan produces a **decision** that tells the caller how to handle the content. The CLI and Web UI report it directly; the host integrations act on findings instead (mask in transparent mode, replace or refuse in `redact` and `block`).

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
