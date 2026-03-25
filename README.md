# 🛡️ sensitive-guard

> 🌐 English | [繁體中文](./README.zh-TW.md)

**A gatekeeper that scans for sensitive content before you feed code, documents, or data to AI services.**

Three usage modes:
- **MCP Server**: Integrates with OpenCode / Claude Code — automatically triggers before AI reads any file
- **CLI**: Manually scan text, files, or directories
- **Web UI**: Browser interface — paste content and scan instantly; also exposes a REST API

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

## Installation

```bash
git clone <this repo>
cd sensitive-guard
npm install
npm run build
```

### npm Scripts Reference

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript → `dist/` |
| `npm run dev` | Dev mode (MCP, no build needed) |
| `npm run scan` | CLI scan (no build needed) |
| `npm test` | Run unit tests |

---

## Usage

### Mode 1: CLI

```bash
# Scan text
npm run cli -- --text 'sk-1234abcd my_password="super_secret"'

# Scan a single file
npm run cli -- --file ./src/config.ts

# Scan an entire directory
npm run cli -- --dir ./src

# Scan specific file extensions only
npm run cli -- --dir ./src --ext .ts .env .json

# Read from stdin
cat .env | npm run cli -- --stdin

# Built version
node dist/index.js --cli --file ./config.ts
```

Exit codes: `0` = safe, `1` = findings detected, `2` = file not found

---

### Mode 2: Web UI

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
    { "type": "API_KEY", "severity": "HIGH", "line": 1, ... }
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

### Mode 3: MCP Server (OpenCode / Claude Code Integration)

#### Step 1: Build

```bash
npm run build
```

#### Step 2: Configure OpenCode

Add the following to your OpenCode config file (typically `~/.config/opencode/config.json` or `opencode.json`):

```json
{
  "mcp": {
    "servers": {
      "sensitive-guard": {
        "type": "local",
        "command": "node",
        "args": ["/absolute/path/to/sensitive-guard/dist/index.js"],
        "env": {}
      }
    }
  }
}
```

> ⚠️ **Always use absolute paths** — do not use `~` or relative paths.

#### Step 3: Add a Guard Rule to Your System Prompt

Add the following instruction to your OpenCode system prompt so the AI calls the scan tool before reading any file or processing code you provide:

```
Before reading any local file, or processing any code / config / data I provide,
call sensitive-guard's scan_file or scan_text tool.
If the scan result's safe field is false, stop immediately and tell me what was found.
Wait for my confirmation before continuing. Do not auto-fix or proceed with sensitive content.
```

For **Claude Code**, add to your `CLAUDE.md`:

```
Before reading any file, call the sensitive-guard MCP tool (scan_file or scan_text).
Stop and report if safe is false.
```

#### MCP Tools

| Tool | Purpose |
|------|---------|
| `scan_text` | Scan a text snippet (code / data you paste in) |
| `scan_file` | Scan a single local file |
| `scan_dir` | Scan an entire directory (recursive, skips node_modules / .git) |
| `reload_config` | Reload YAML config without restarting the server |

---

## Configuration

Edit `config/guard.config.yaml`:

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
- **MCP Server**: Call the `reload_config` tool, or restart the server

---

## Practical Examples

### Scenario 1: Asking OpenCode to review a config file

```
You (to OpenCode): Please review this config.ts for issues
OpenCode (auto): [calls scan_file config.ts]
→ API_KEY found, HIGH severity, line 12
→ Stops and reports to you
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

## Notes

- This tool performs **static pattern matching** and cannot guarantee 100% coverage
- **Common false positives**: test/dummy keys (e.g. `sk-test123456`), placeholder values in example code
- The tool is meant to **warn**, not guarantee — final judgment is always yours
- Keep NDA keywords focused on truly confidential terms to avoid excessive false positives
