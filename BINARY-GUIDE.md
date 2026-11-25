# leakshield — Binary Quick Start

You have a single `leakshield` (or `leakshield.exe`) executable. No Node.js, no npm, nothing else needed.

It is the LeakShield CLI in executable form: use it for explicit scans, redaction and the Web UI. It does not protect an AI agent by itself. The OpenCode plugin and the pi extension are loaded by their host from the npm package, and the Claude Code proxy has not been verified in this binary; for those, install the npm package (`npm install -g leakshield`) and see the [README](https://github.com/jwcrystal/leakshield#quickstart).

## Run

```bash
# Scan text
./leakshield --text 'OPENAI_KEY=sk-xxxx secret="supersecret"'

# Scan a file
./leakshield --file ./config.ts

# Scan a directory
./leakshield --dir ./src

# Read from stdin
cat .env | ./leakshield --stdin

# Start Web UI (default port 3000)
./leakshield --web
```

## Redact (sanitize before sharing)

```bash
# Redact stdin
cat .env | ./leakshield --redact --stdin

# Redact file to new file
./leakshield --redact --file .env --out .env.redacted

# Preview what would be redacted (no output)
./leakshield --redact --dry-run --file .env
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
| `~/.leakshield/guard.config.yaml` | All sessions (home) |

```bash
# Create a custom config at home (works everywhere)
mkdir -p ~/.leakshield
# Copy the example or create your own
# See: https://github.com/jwcrystal/leakshield/blob/main/config/guard.config.example.yaml
```

See full options: [Configuration Reference](https://github.com/jwcrystal/leakshield#configuration)

## Help

```bash
./leakshield    # shows usage and all options
```

This applies when you run it in a terminal. In a pipe, CI or a script, where stdin is not a terminal, it reads stdin until EOF instead; close or redirect stdin there so it does not wait.

## Build it yourself

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
