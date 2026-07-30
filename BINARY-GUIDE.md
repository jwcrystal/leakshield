# sensitive-guard — Binary Quick Start

You have a single `sensitive-guard` (or `sensitive-guard.exe`) executable. No Node.js, no npm, nothing else needed.

## Run

```bash
# Scan text
./sensitive-guard --text 'OPENAI_KEY=sk-xxxx secret="supersecret"'

# Scan a file
./sensitive-guard --file ./config.ts

# Scan a directory
./sensitive-guard --dir ./src

# Read from stdin
cat .env | ./sensitive-guard --stdin

# Start Web UI (default port 3000)
./sensitive-guard --web
```

## Redact (sanitize before sharing)

```bash
# Redact stdin
cat .env | ./sensitive-guard --redact --stdin

# Redact file to new file
./sensitive-guard --redact --file .env --out .env.redacted

# Preview what would be redacted (no output)
./sensitive-guard --redact --dry-run --file .env
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Safe — no sensitive content |
| 1 | Findings detected |
| 2 | Path error (file not found, etc.) |

## Custom Configuration

The binary works out of the box. To add custom rules (NDA keywords, private domains, custom regex), place a config file at one of these paths:

| Path | Scope |
|------|-------|
| `./config/guard.config.yaml` | Current directory |
| `~/.sensitive-guard/guard.config.yaml` | All sessions (home) |

```bash
# Create a custom config at home (works everywhere)
mkdir -p ~/.sensitive-guard
# Copy the example or create your own
# See: https://github.com/jwcrystal/sensitive-guard/blob/main/config/guard.config.example.yaml
```

See full options: [Configuration Reference](https://github.com/jwcrystal/sensitive-guard#configuration)

## Help

```bash
./sensitive-guard    # shows usage and all options
```
