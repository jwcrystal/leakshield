import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import type { FindingType, Finding, ScanResult } from "../types.js";
import { loadConfig } from "../config/loader.js";
import { scanText, redactText } from "../scanner/engine.js";
import { collectFiles, runWithConcurrency } from "../utils/files.js";
import { validateCliScanPath } from "../utils/path-security.js";

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
    ? "✅ 未偵測到敏感內容，可以安全傳送。"
    : `🚨 發現 ${findings.length} 個潛在敏感項目（HIGH: ${highCount}, MEDIUM: ${medCount}, LOW: ${findings.length - highCount - medCount}）`;
  return { ...result, findings, total_findings: findings.length, safe, summary };
}

// ─── Text output ─────────────────────────────────────────────────────────────

export function printCliResult(result: ScanResult, label: string) {
  console.log("");
  console.log(chalk.bold(`📋 掃描目標：${label}`));
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

      console.log(color(`\n  [${severity}] ${type} — ${items.length} 個命中`));
      for (const item of items.slice(0, 5)) {
        const loc = item.line ? chalk.dim(` (第 ${item.line} 行, 欄 ${item.column})`) : "";
        console.log(`    • ${item.description}${loc}`);
        console.log(chalk.dim(`      預覽：${item.preview}`));
      }
      if (items.length > 5) {
        console.log(chalk.dim(`    … 還有 ${items.length - 5} 個相同類型`));
      }
    }
  }

  console.log("");
  console.log(
    result.safe
      ? chalk.green("💡 " + result.recommendation)
      : chalk.red("⚠️  " + result.recommendation)
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
        console.error(chalk.red(`❌ 找不到檔案：${filePath}`));
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
      console.error(chalk.red("❌ --redact 需搭配 --text、--file 或 --stdin"));
      process.exit(2);
    }

    const result = redactText(inputText, config);

    if (dryRun) {
      // Dry-run: show preview only, do not output redacted text
      console.error(chalk.bold(`\n[DRY-RUN] Would redact ${result.total_findings} finding(s) in ${label}:`));
      if (result.total_findings === 0) {
        console.error(chalk.green("  ✅ No sensitive content detected, nothing to redact."));
      } else {
        for (const f of result.findings) {
          const loc = f.line ? chalk.dim(` line ${f.line}, col ${f.column}`) : "";
          console.error(`  ${chalk.yellow(f.type)}${loc} — ${f.description}`);
          console.error(chalk.dim(`    preview: ${f.preview} → [REDACTED_${f.type}]`));
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
        console.error(chalk.green(`✅ Redacted content written to: ${path.resolve(outPath)}`));
      } else {
        process.stdout.write(result.redacted);
      }
      console.error(chalk.dim(`\n[sensitive-guard] ${result.summary}`));
    }
    process.exit(0);
  }

  // --dir 模式
  if (dirIdx !== -1 && args[dirIdx + 1]) {
    let dirPath: string;
    try {
      dirPath = validateCliScanPath(process.cwd(), args[dirIdx + 1], allowOutside);
    } catch (e) {
      console.error(chalk.red(`❌ ${e instanceof Error ? e.message : String(e)}`));
      process.exit(2);
    }
    if (!fs.existsSync(dirPath)) {
      console.error(chalk.red(`❌ 找不到目錄：${dirPath}`));
      process.exit(2);
    }
    const extensions =
      extIdx !== -1 ? args.slice(extIdx + 1).filter((a) => a.startsWith(".")) : undefined;

    if (format === "text") {
      console.log(chalk.bold(`\n🔍 掃描目錄：${dirPath}`));
      if (extensions) console.log(chalk.dim(`   副檔名篩選：${extensions.join(", ")}`));
    }

    const files = collectFiles(dirPath, extensions, 200);
    if (format === "text") console.log(chalk.dim(`   找到 ${files.length} 個檔案\n`));

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
      console.log(chalk.dim(`   跳過 ${skippedFiles} 個無法讀取的檔案\n`));
    }

    if (format === "json") {
      console.log(JSON.stringify({ dir: dirPath, scanned_files: files.length, skipped_files: skippedFiles, unsafe_files: jsonResults.length, results: jsonResults }, null, 2));
    } else if (!anyUnsafe) {
      console.log(chalk.green(`✅ 掃描完成，${files.length} 個檔案均未發現敏感內容。\n`));
    }
    process.exit(anyUnsafe ? 1 : 0);
  }

  // --text 模式
  if (textIdx !== -1 && args[textIdx + 1]) {
    const result = scanText(args[textIdx + 1], config);
    const filtered = output(result, "(直接輸入文字)");
    process.exit(filtered.safe ? 0 : 1);
  }

  // --file 模式
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    let filePath: string;
    try {
      filePath = validateCliScanPath(process.cwd(), args[fileIdx + 1], allowOutside);
    } catch (e) {
      console.error(chalk.red(`❌ ${e instanceof Error ? e.message : String(e)}`));
      process.exit(2);
    }
    if (!fs.existsSync(filePath)) {
      console.error(chalk.red(`❌ 找不到檔案：${filePath}`));
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

  // 無輸入 → 顯示用法
  console.log(chalk.bold("\n🛡️  sensitive-guard — 敏感內容守門員\n"));
  console.log("用法：");
  console.log("  npm run scan -- --text '你的內容'");
  console.log("  npm run scan -- --file ./path/to/file.ts");
  console.log("  npm run scan -- --dir ./src");
  console.log("  npm run scan -- --dir ./src --ext .ts .env .json");
  console.log("  cat file.ts | npm run scan -- --stdin");
  console.log("");
  console.log("脫敏模式：");
  console.log("  npm run scan -- --redact --text '你的內容'");
  console.log("  npm run scan -- --redact --file ./secret.env");
  console.log("  npm run scan -- --redact --file ./secret.env --out ./redacted.env");
  console.log("  cat file.ts | npm run scan -- --redact --stdin");
  console.log("  npm run scan -- --redact --dry-run --file ./secret.env   # 只預覽，不輸出");
  console.log("");
  console.log("選項：");
  console.log("  --format json          輸出 JSON（適合 CI/CD）");
  console.log("  --min-severity high    只回報 HIGH（或 medium / low）");
  console.log("  --redact               脫敏模式（輸出替換後文字）");
  console.log("  --dry-run              搭配 --redact，只預覽不輸出");
  console.log("  --out <path>           搭配 --redact --file，指定輸出路徑");
  console.log("  --allow-outside        允許掃描工作目錄以外的路徑（預設禁止）");
  console.log("");
  console.log("MCP Server 模式（由 OpenCode 自動啟動）：");
  console.log("  node dist/index.js");
  console.log("");
}
