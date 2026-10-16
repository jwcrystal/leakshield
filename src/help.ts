// ─── CLI help text ───────────────────────────────────────────────────────────

export const HELP_TEXT = `sensitive-guard — scan text for secrets and PII before sending it to AI

Usage:
  sensitive-guard [--cli] [scan options]   Scan text, a file, a directory or stdin
  sensitive-guard --web [--port <n>]       Start the local Web UI (default port 3000)
  sensitive-guard --doctor                 Check the OpenCode plugin installation
  sensitive-guard --forget --all           Delete all persisted transparent-mode mappings
  sensitive-guard --forget --session <id>  Delete persisted mappings for one session
  sensitive-guard --help                   Show this help

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

Forget options:
  --path <file>                  Mapping store location (default: ~/.local/share/sensitive-guard/SGP.db)

Exit codes: 0 = safe, 1 = findings detected, 2 = file not found
`;

export function isHelpRequest(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}
