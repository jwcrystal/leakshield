import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import type { FindingType, Finding, ScanResult } from "../types.js";
import { loadConfig } from "../config/loader.js";
import { scanText, redactText } from "../scanner/engine.js";
import { sanitizeRedactResultForExport } from "../decision/redaction.js";
import { toDecisionResult } from "../decision/model.js";
import type { GuardDecisionResult, GuardDecisionFinding } from "../decision/model.js";
import { collectFiles, runWithConcurrency } from "../utils/files.js";
import { validateCliScanPath } from "../utils/path-security.js";
import { t } from "../i18n/index.js";

export { validateCliScanPath };

const SCAN_CONCURRENCY = 8;

// ─── Severity filter ─────────────────────────────────────────────────────────

const SEVERITY_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 } as const;

type MinSeverity = "high" | "medium" | "low";

export function filterBySeverity(result: ScanResult, min: MinSeverity): ScanResult {
  const threshold = SEVERITY_RANK[min.toUpperCase() as keyof typeof SEVERITY_RANK];
  const findings = result.findings.filter((f) => SEVERITY_RANK[f.severity] >= threshold);
  const safe = findings.length === 0;
  const highCount = findings.filter((f) => f.severity === "HIGH").length;
  const medCount = findings.filter((f) => f.severity === "MEDIUM").length;
  const summary = safe
    ? t("scan.safe_summary")
    : t("scan.unsafe_summary", {
        count: findings.length,
        high: highCount,
        med: medCount,
        low: findings.length - highCount - medCount,
      });
  return { ...result, findings, total_findings: findings.length, safe, summary };
}

// ─── Decision-aware CLI formatting ──────────────────────────────────────────

const SEPARATOR = "─".repeat(60);

/**
 * Pure function that formats a GuardDecisionResult into CLI output lines.
 *
 * Does NOT write to console — returns an array of strings so callers can
 * test formatting without capturing stdout.
 *
 * | decision | Behaviour                                   |
 * |----------|---------------------------------------------|
 * | ALLOW    | Clean summary, continue normally            |
 * | WARN     | Reminder with findings, then continue       |
 * | CONFIRM  | Warning card with actions (non-interactive) |
 */
export function formatCliDecision(
  decision: GuardDecisionResult,
  label: string,
): string[] {
  const lines: string[] = [];

  lines.push("");
  lines.push(chalk.bold(t("cli.scan_target", { label })));
  lines.push(SEPARATOR);

  const DECISION_COLOR = {
    ALLOW: chalk.green,
    WARN: chalk.yellow,
    CONFIRM: chalk.red,
  } as const;

  const colorFn = DECISION_COLOR[decision.decision] ?? ((s: string) => s);

  if (decision.decision === "ALLOW") {
    lines.push(colorFn(t("scan.safe_summary")));
  } else {
    // Decision + Risk title line
    const actionPart = decision.recommendedAction
      ? `  |  Action: ${decision.recommendedAction}`
      : "";
    lines.push(colorFn(
      `Decision: ${decision.decision}  |  Risk: ${decision.riskLevel}${actionPart}`,
    ));

    lines.push(decision.summary);
    lines.push("");

    // Group findings by type
    const byType: Partial<Record<string, GuardDecisionFinding[]>> = {};
    for (const f of decision.findings) {
      if (!byType[f.type]) byType[f.type] = [];
      byType[f.type]!.push(f);
    }

    for (const [type, items] of Object.entries(byType)) {
      if (!items) continue;
      const severity = items[0].severity;
      const color =
        severity === "HIGH" ? chalk.red : severity === "MEDIUM" ? chalk.yellow : chalk.gray;
      lines.push(
        color(`  [${severity}] ${type} — ${t("cli.hits", { count: items.length })}`),
      );
      for (const item of items.slice(0, 5)) {
        const loc = item.line
          ? chalk.dim(` (line ${item.line})`)
          : "";
        lines.push(`    • ${item.description}${loc}`);
        lines.push(chalk.dim(t("cli.preview", { preview: item.preview })));
      }
      if (items.length > 5) {
        lines.push(
          chalk.dim(t("cli.more_of_type", { count: items.length - 5 })),
        );
      }
    }

    // CONFIRM: next step hint
    if (decision.decision === "CONFIRM") {
      lines.push("");
      lines.push(
        chalk.dim(
          `💡 ${t("cli.confirm_next_step")}`,
        ),
      );
    }
  }

  lines.push("");
  lines.push(SEPARATOR);
  lines.push("");

  return lines;
}

/**
 * Build a decision-oriented JSON object safe for CLI/CI export.
 *
 * Strips `originalContent` and ensures findings carry only transport-safe fields.
 */
export function buildDecisionJsonOutput(
  decision: GuardDecisionResult,
  label: string,
): Record<string, unknown> {
  const { originalContent: _oc, ...safeDecision } = decision;

  return {
    label,
    safe: safeDecision.decision === "ALLOW",
    decision: safeDecision.decision,
    riskLevel: safeDecision.riskLevel,
    summary: safeDecision.summary,
    findings: safeDecision.findings.map((f) => ({
      type: f.type,
      severity: f.severity,
      description: f.description,
      preview: f.preview,
      ...(f.line !== undefined ? { line: f.line } : {}),
    })),
    ...(safeDecision.recommendedAction !== undefined
      ? { recommendedAction: safeDecision.recommendedAction }
      : {}),
    ...(safeDecision.safePreview !== undefined
      ? { safePreview: safeDecision.safePreview }
      : {}),
    ...(safeDecision.redactedContent !== undefined
      ? { redactedContent: safeDecision.redactedContent }
      : {}),
  };
}

/**
 * Print decision-aware output to console (text mode).
 */
function printCliDecision(decision: GuardDecisionResult, label: string): void {
  const lines = formatCliDecision(decision, label);
  for (const line of lines) {
    console.log(line);
  }
}

// ─── Text output ─────────────────────────────────────────────────────────────

export function printCliResult(result: ScanResult, label: string) {
  console.log("");
  console.log(chalk.bold(t("cli.scan_target", { label })));
  console.log("─".repeat(60));

  if (result.safe) {
    console.log(chalk.green(result.summary));
  } else {
    console.log(chalk.red(result.summary));
    console.log("");

    const byType: Partial<Record<FindingType, Finding[]>> = {};
    for (const f of result.findings) {
      if (!byType[f.type]) byType[f.type] = [];
      byType[f.type]!.push(f);
    }

    for (const [type, items] of Object.entries(byType)) {
      const severity = items[0].severity;
      const color =
        severity === "HIGH" ? chalk.red : severity === "MEDIUM" ? chalk.yellow : chalk.gray;

      console.log(color(`\n  [${severity}] ${type} — ${t("cli.hits", { count: items.length })}`));
      for (const item of items.slice(0, 5)) {
        const loc = item.line
          ? chalk.dim(t("cli.location", { line: item.line, col: item.column ?? 0 }))
          : "";
        console.log(`    • ${item.description}${loc}`);
        console.log(chalk.dim(t("cli.preview", { preview: item.preview })));
      }
      if (items.length > 5) {
        console.log(chalk.dim(t("cli.more_of_type", { count: items.length - 5 })));
      }
    }
  }

  console.log("");
  console.log(
    result.safe ? chalk.green("💡 " + result.recommendation) : chalk.red("⚠️  " + result.recommendation)
  );
  console.log("─".repeat(60));
  console.log("");
}

// ─── CLI entry ───────────────────────────────────────────────────────────────

export async function runCli() {
  const args = process.argv.slice(2);
  const config = loadConfig();

  const textIdx = args.indexOf("--text");
  const fileIdx = args.indexOf("--file");
  const dirIdx = args.indexOf("--dir");
  const extIdx = args.indexOf("--ext");
  const fmtIdx = args.indexOf("--format");
  const sevIdx = args.indexOf("--min-severity");
  const outIdx = args.indexOf("--out");
  const stdinMode = args.includes("--stdin");
  const redactMode = args.includes("--redact");
  const dryRun = args.includes("--dry-run");

  const format: "text" | "json" = args[fmtIdx + 1] === "json" ? "json" : "text";
  const minSeverity: MinSeverity =
    (["high", "medium", "low"].includes(args[sevIdx + 1]) ? args[sevIdx + 1] : "low") as MinSeverity;
  const allowOutside = args.includes("--allow-outside");

  function output(result: ScanResult, label: string, originalContent: string) {
    const filtered = filterBySeverity(result, minSeverity);
    const decision = toDecisionResult(filtered, originalContent, config);
    if (format === "json") {
      console.log(JSON.stringify(buildDecisionJsonOutput(decision, label), null, 2));
    } else {
      printCliDecision(decision, label);
    }
    return { filtered, decision };
  }

  // --redact / --dry-run mode (supports --text, --file, --stdin)
  if (redactMode) {
    let inputText: string | null = null;
    let label = "(inline text)";

    if (textIdx !== -1 && args[textIdx + 1]) {
      inputText = args[textIdx + 1];
    } else if (fileIdx !== -1 && args[fileIdx + 1]) {
      const filePath = path.resolve(args[fileIdx + 1]);
      if (!fs.existsSync(filePath)) {
        console.error(chalk.red(t("cli.error_file_not_found", { path: filePath })));
        process.exit(2);
      }
      inputText = fs.readFileSync(filePath, "utf-8");
      label = filePath;
    } else if (stdinMode || !process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      inputText = Buffer.concat(chunks).toString("utf-8");
      label = "(stdin)";
    }

    if (inputText === null) {
      console.error(chalk.red(t("cli.error_redact_no_input")));
      process.exit(2);
    }

    const result = redactText(inputText, config);

    if (dryRun) {
      // Dry-run: show preview only, do not output redacted text
      console.error(chalk.bold(t("cli.dryrun_header", { count: result.total_findings, label })));
      if (result.total_findings === 0) {
        console.error(chalk.green(t("cli.dryrun_safe")));
      } else {
        for (const f of result.findings) {
          const loc = f.line
            ? chalk.dim(t("cli.dryrun_location", { line: f.line, col: f.column ?? 0 }))
            : "";
          console.error(`  ${chalk.yellow(f.type)}${loc} — ${f.description}`);
          console.error(chalk.dim(t("cli.dryrun_preview", { preview: f.preview, type: f.type })));
        }
      }
      process.exit(result.total_findings > 0 ? 1 : 0);
    }

    if (format === "json") {
      console.log(JSON.stringify({ label, ...sanitizeRedactResultForExport(result) }, null, 2));
    } else {
      // Write redacted text to stdout (or file); summary goes to stderr
      const outPath = outIdx !== -1 ? args[outIdx + 1] : undefined;
      if (outPath) {
        fs.writeFileSync(path.resolve(outPath), result.redacted, "utf-8");
        console.error(chalk.green(t("cli.redact_written", { path: path.resolve(outPath) })));
      } else {
        process.stdout.write(result.redacted);
      }
      console.error(chalk.dim("\n" + t("cli.redact_footer", { summary: result.summary })));
    }
    process.exit(0);
  }

  // --dir 模式
  if (dirIdx !== -1 && args[dirIdx + 1]) {
    let dirPath: string;
    try {
      dirPath = validateCliScanPath(process.cwd(), args[dirIdx + 1], allowOutside);
    } catch (e) {
      console.error(chalk.red(t("cli.error_path", { error: e instanceof Error ? e.message : String(e) })));
      process.exit(2);
    }
    if (!fs.existsSync(dirPath)) {
      console.error(chalk.red(t("cli.error_dir_not_found", { path: dirPath })));
      process.exit(2);
    }
    const extensions =
      extIdx !== -1 ? args.slice(extIdx + 1).filter((a) => a.startsWith(".")) : undefined;

    if (format === "text") {
      console.log(chalk.bold(t("cli.scan_dir", { path: dirPath })));
      if (extensions) console.log(chalk.dim(t("cli.ext_filter", { exts: extensions.join(", ") })));
    }

    const files = collectFiles(dirPath, extensions, 200);
    if (format === "text") console.log(chalk.dim(t("cli.found_files", { count: files.length })));

    const jsonResults: object[] = [];
    let anyUnsafe = false;
    let skippedFiles = 0;

    const tasks = files.map((f) => async () => {
      try {
        const content = await fs.promises.readFile(f, "utf-8");
        return { file: f, content };
      } catch {
        return null;
      }
    });

    const readResults = await runWithConcurrency(tasks, SCAN_CONCURRENCY);

    for (const item of readResults) {
      if (!item) { skippedFiles++; continue; }
      const result = scanText(item.content, config);
      const filtered = filterBySeverity(result, minSeverity);
      if (!filtered.safe) {
        anyUnsafe = true;
        const decision = toDecisionResult(filtered, item.content, config);
        if (format === "json") {
          jsonResults.push({ file: item.file, ...buildDecisionJsonOutput(decision, item.file) });
        } else {
          printCliDecision(decision, item.file);
        }
      }
    }

    if (skippedFiles > 0 && format === "text") {
      console.log(chalk.dim(t("cli.skipped_files", { count: skippedFiles })));
    }

    if (format === "json") {
      console.log(JSON.stringify({ dir: dirPath, scanned_files: files.length, skipped_files: skippedFiles, unsafe_files: jsonResults.length, results: jsonResults }, null, 2));
    } else if (!anyUnsafe) {
      console.log(chalk.green(t("cli.dir_complete", { count: files.length })));
    }
    process.exit(anyUnsafe ? 1 : 0);
  }

  // --text mode
  if (textIdx !== -1 && args[textIdx + 1]) {
    const originalContent = args[textIdx + 1];
    const result = scanText(originalContent, config);
    const { decision } = output(result, t("cli.inline_label"), originalContent);
    process.exit(decision.decision === "ALLOW" ? 0 : 1);
  }

  // --file mode
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    let filePath: string;
    try {
      filePath = validateCliScanPath(process.cwd(), args[fileIdx + 1], allowOutside);
    } catch (e) {
      console.error(chalk.red(t("cli.error_path", { error: e instanceof Error ? e.message : String(e) })));
      process.exit(2);
    }
    if (!fs.existsSync(filePath)) {
      console.error(chalk.red(t("cli.error_file_not_found", { path: filePath })));
      process.exit(2);
    }
    const originalContent = fs.readFileSync(filePath, "utf-8");
    const result = scanText(originalContent, config);
    const { decision } = output(result, filePath, originalContent);
    process.exit(decision.decision === "ALLOW" ? 0 : 1);
  }

  // stdin 模式
  if (stdinMode || !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const originalContent = Buffer.concat(chunks).toString("utf-8");
    const result = scanText(originalContent, config);
    const { decision } = output(result, "(stdin)", originalContent);
    process.exit(decision.decision === "ALLOW" ? 0 : 1);
  }

  // No input → show usage
  console.log(chalk.bold(t("cli.usage_title")));
  console.log(t("cli.usage_heading"));
  console.log(t("cli.usage_text"));
  console.log(t("cli.usage_file"));
  console.log(t("cli.usage_dir"));
  console.log(t("cli.usage_dir_ext"));
  console.log(t("cli.usage_stdin"));
  console.log("");
  console.log(t("cli.usage_redact_heading"));
  console.log(t("cli.usage_redact_text"));
  console.log(t("cli.usage_redact_file"));
  console.log(t("cli.usage_redact_out"));
  console.log(t("cli.usage_redact_stdin"));
  console.log(t("cli.usage_redact_dryrun"));
  console.log("");
  console.log(t("cli.usage_options_heading"));
  console.log(t("cli.usage_opt_format"));
  console.log(t("cli.usage_opt_severity"));
  console.log(t("cli.usage_opt_redact"));
  console.log(t("cli.usage_opt_dryrun"));
  console.log(t("cli.usage_opt_out"));
  console.log(t("cli.usage_opt_outside"));
  console.log("");
  console.log(t("cli.usage_mcp_heading"));
  console.log(t("cli.usage_mcp"));
  console.log("");
}
