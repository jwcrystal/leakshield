import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import type { FindingType, Finding, ScanResult } from "../types.js";
import { loadConfig } from "../config/loader.js";
import { scanText } from "../scanner/engine.js";

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

// ─── File collector ───────────────────────────────────────────────────────────

export function collectFiles(dir: string, extensions?: string[], maxFiles = 200): string[] {
  const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__"]);
  const files: string[] = [];
  function walk(d: string) {
    if (files.length >= maxFiles) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (files.length >= maxFiles) break;
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) walk(path.join(d, entry.name));
      else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!extensions || extensions.includes(ext)) files.push(path.join(d, entry.name));
      }
    }
  }
  walk(dir);
  return files;
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
  const stdinMode = args.includes("--stdin");

  const format: "text" | "json" = args[fmtIdx + 1] === "json" ? "json" : "text";
  const minSeverity: MinSeverity =
    (["high", "medium", "low"].includes(args[sevIdx + 1]) ? args[sevIdx + 1] : "low") as MinSeverity;

  function output(result: ScanResult, label: string) {
    const filtered = filterBySeverity(result, minSeverity);
    if (format === "json") {
      console.log(JSON.stringify({ label, ...filtered }, null, 2));
    } else {
      printCliResult(filtered, label);
    }
    return filtered;
  }

  // --dir 模式
  if (dirIdx !== -1 && args[dirIdx + 1]) {
    const dirPath = path.resolve(args[dirIdx + 1]);
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

    const files = collectFiles(dirPath, extensions);
    if (format === "text") console.log(chalk.dim(`   找到 ${files.length} 個檔案\n`));

    const jsonResults: object[] = [];
    let anyUnsafe = false;

    for (const f of files) {
      try {
        const content = fs.readFileSync(f, "utf-8");
        const result = scanText(content, config);
        const filtered = filterBySeverity(result, minSeverity);
        if (!filtered.safe) {
          anyUnsafe = true;
          if (format === "json") {
            jsonResults.push({ file: f, ...filtered });
          } else {
            printCliResult(filtered, f);
          }
        }
      } catch { /* 跳過二進位檔案 */ }
    }

    if (format === "json") {
      console.log(JSON.stringify({ dir: dirPath, scanned_files: files.length, unsafe_files: jsonResults.length, results: jsonResults }, null, 2));
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
    const filePath = path.resolve(args[fileIdx + 1]);
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
  console.log("  npx tsx src/index.ts --cli --text '你的內容'");
  console.log("  npx tsx src/index.ts --cli --file ./path/to/file.ts");
  console.log("  npx tsx src/index.ts --cli --dir ./src");
  console.log("  npx tsx src/index.ts --cli --dir ./src --ext .ts .env .json");
  console.log("  cat file.ts | npx tsx src/index.ts --cli --stdin");
  console.log("");
  console.log("選項：");
  console.log("  --format json          輸出 JSON（適合 CI/CD）");
  console.log("  --min-severity high    只回報 HIGH（或 medium / low）");
  console.log("");
  console.log("MCP Server 模式（由 OpenCode 自動啟動）：");
  console.log("  node dist/index.js");
  console.log("");
}
