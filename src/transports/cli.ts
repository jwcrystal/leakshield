import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import type { FindingType, Finding, ScanResult } from "../types.js";
import { loadConfig } from "../config/loader.js";
import { scanText, redactText } from "../scanner/engine.js";
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

  function output(result: ScanResult, label: string) {
    const filtered = filterBySeverity(result, minSeverity);
    if (format === "json") {
      console.log(JSON.stringify({ label, ...filtered }, null, 2));
    } else {
      printCliResult(filtered, label);
    }
    return filtered;
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
      console.log(JSON.stringify({ label, ...result }, null, 2));
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
        if (format === "json") {
          jsonResults.push({ file: item.file, ...filtered });
        } else {
          printCliResult(filtered, item.file);
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
    const result = scanText(args[textIdx + 1], config);
    const filtered = output(result, t("cli.inline_label"));
    process.exit(filtered.safe ? 0 : 1);
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
    const result = scanText(fs.readFileSync(filePath, "utf-8"), config);
    const filtered = output(result, filePath);
    process.exit(filtered.safe ? 0 : 1);
  }

  // stdin 模式
  if (stdinMode || !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const result = scanText(Buffer.concat(chunks).toString("utf-8"), config);
    const filtered = output(result, "(stdin)");
    process.exit(filtered.safe ? 0 : 1);
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
