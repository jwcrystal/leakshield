export const en = {
  // engine — scan
  "scan.safe_summary": "✅ No sensitive content detected, safe to send.",
  "scan.unsafe_summary":
    "🚨 Found {count} potential sensitive item(s) (HIGH: {high}, MEDIUM: {med}, LOW: {low})",
  "scan.safe_recommendation":
    "Content looks safe, but please verify there are no business-logic secrets.",
  "scan.unsafe_recommendation":
    "⛔ Please address the above sensitive items before sending to AI services. Use placeholder data or remove sensitive fields, then retry.",

  // engine — redact
  "redact.safe_summary": "✅ No sensitive content detected, nothing to redact.",
  "redact.unsafe_summary": "🔒 Redacted {count} sensitive item(s).",

  // cli — print result
  "cli.scan_target": "📋 Scan target: {label}",
  "cli.hits": "{count} hit(s)",
  "cli.location": " (line {line}, col {col})",
  "cli.preview": "      Preview: {preview}",
  "cli.more_of_type": "    … {count} more of the same type",

  // cli — errors
  "cli.error_file_not_found": "❌ File not found: {path}",
  "cli.error_dir_not_found": "❌ Directory not found: {path}",
  "cli.error_redact_no_input": "❌ --redact requires --text, --file, or --stdin",
  "cli.error_path": "❌ {error}",

  // cli — redact / dry-run
  "cli.dryrun_header": "\n[DRY-RUN] Would redact {count} finding(s) in {label}:",
  "cli.dryrun_safe": "  ✅ No sensitive content detected, nothing to redact.",
  "cli.dryrun_location": " line {line}, col {col}",
  "cli.dryrun_preview": "    preview: {preview} → [REDACTED_{type}]",
  "cli.redact_written": "✅ Redacted content written to: {path}",
  "cli.redact_footer": "[sensitive-guard] {summary}",

  // cli — dir mode
  "cli.scan_dir": "\n🔍 Scanning directory: {path}",
  "cli.ext_filter": "   Extension filter: {exts}",
  "cli.found_files": "   Found {count} file(s)\n",
  "cli.skipped_files": "   Skipped {count} unreadable file(s)\n",
  "cli.dir_complete": "✅ Scan complete, {count} file(s) all clean.\n",

  // cli — inline label
  "cli.inline_label": "(inline text)",

  // cli — decision-aware output
  "cli.decision_warn_header": "Reminder — {risk} risk: {count} sensitive item(s) detected",
  "cli.decision_confirm_header": "Warning — {risk} risk: {count} sensitive item(s) detected (recommended: {action})",
  "cli.confirm_next_step": "Next: use --format json to get redactedContent, or --redact for sanitized output. Exit code 1 = blocked.",

  // cli — usage
  "cli.usage_title": "\n🛡️  sensitive-guard — Sensitive content guard\n",
  "cli.usage_heading": "Usage:",
  "cli.usage_text": "  npm run scan -- --text 'your content'",
  "cli.usage_file": "  npm run scan -- --file ./path/to/file.ts",
  "cli.usage_dir": "  npm run scan -- --dir ./src",
  "cli.usage_dir_ext": "  npm run scan -- --dir ./src --ext .ts .env .json",
  "cli.usage_stdin": "  cat file.ts | npm run scan -- --stdin",
  "cli.usage_redact_heading": "\nRedact mode:",
  "cli.usage_redact_text": "  npm run scan -- --redact --text 'your content'",
  "cli.usage_redact_file": "  npm run scan -- --redact --file ./secret.env",
  "cli.usage_redact_out": "  npm run scan -- --redact --file ./secret.env --out ./redacted.env",
  "cli.usage_redact_stdin": "  cat file.ts | npm run scan -- --redact --stdin",
  "cli.usage_redact_dryrun":
    "  npm run scan -- --redact --dry-run --file ./secret.env   # preview only, no output",
  "cli.usage_options_heading": "\nOptions:",
  "cli.usage_opt_format": "  --format json          JSON output (suitable for CI/CD)",
  "cli.usage_opt_severity": "  --min-severity high    Report HIGH only (or medium / low)",
  "cli.usage_opt_redact": "  --redact               Redact mode (output sanitized text)",
  "cli.usage_opt_dryrun": "  --dry-run              Preview only, no output (use with --redact)",
  "cli.usage_opt_out": "  --out <path>           Output path (use with --redact --file)",
  "cli.usage_opt_outside":
    "  --allow-outside        Allow scanning paths outside the working directory (disabled by default)",
  "cli.usage_mcp_heading": "\nMCP Server mode (auto-started by OpenCode):",
  "cli.usage_mcp": "  node dist/index.js",

  // web — server start
  "web.server_title": "🛡️  sensitive-guard web UI",
  "web.server_url": "   http://localhost:{port}",
  "web.server_stop": "   Press Ctrl+C to stop",
};
