// ─── CLI help text ───────────────────────────────────────────────────────────

export const HELP_TEXT = `leakshield — scan text for secrets and PII before sending it to AI

Usage:
  leakshield [--cli] [scan options]   Scan text, a file, a directory or stdin
  leakshield --web [--port <n>]       Start the local Web UI (default port 3000)
  leakshield --doctor [host]          Check one host (opencode, claude-code, pi) or all;
                                      use --doctor pi, not pi --doctor
  leakshield --doctor=<host>          Same target, inline form
  leakshield --claude-code-proxy      Start the local proxy for Claude Code (see below)
  leakshield --pi [...]               Run the pi coding agent behind the LeakShield boundary
  leakshield --pi-install             Register the LeakShield extension in pi's settings
  leakshield --forget --all           Delete all persisted transparent-mode mappings
  leakshield --forget --session <id>  Delete persisted mappings for one session
  leakshield --help                   Show this help

Scan input (stdin is read when none is given):
  --text <text>                  Scan the given text
  --file <path>                  Scan a single file
  --dir <path>                   Scan a directory recursively
  --ext <.ext ...>               With --dir, only scan these extensions
  --stdin                        Read text from stdin
  --allow-outside                Allow --file/--dir paths outside the working directory

Scan options:
  --format json                  JSON output (CI/CD friendly)
  --min-severity <level>         Only report high, medium or low and above (default: low)
  --enable-encoding-detection    Also decode Base64/hex/URL-encoded content before scanning

Redaction:
  --redact                       Replace findings with [REDACTED_TYPE] and print to stdout
  --redact --out <path>          Write the redacted text to a file
  --redact --dry-run             Report what would be redacted without writing output

Claude Code proxy options (then set ANTHROPIC_BASE_URL=http://127.0.0.1:<port>):
  --port <n>                     Listen port on 127.0.0.1 (default 8787)
  --upstream <url>               Anthropic API base URL (default https://api.anthropic.com)
  --config <path>                LeakShield config file (default: discovered from the working directory)
  --attachments block|allow      Refuse (default) or pass images/documents through unscanned

pi options (leakshield --pi --help lists them all):
  --provider <id>                pi provider to protect (required; must be a
                                 provider declared in models.json)
  --model <provider/id>          Model passed to pi

Forget options:
  --path <file>                  Mapping store location (default: ~/.local/share/leakshield/SGP.db)

Exit codes: 0 = safe, 1 = findings detected, 2 = file not found
`;

export function isHelpRequest(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}
