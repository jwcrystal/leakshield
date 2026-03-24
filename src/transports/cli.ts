import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import type { FindingType, Finding, ScanResult } from "../types.js";
import { loadConfig } from "../config/loader.js";
import { scanText } from "../scanner/engine.js";

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
    result.safe ? chalk.green("💡 " + result.recommendation) : chalk.red("⚠️  " + result.recommendation)
  );
  console.log("─".repeat(60));
  console.log("");
}

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

export async function runCli() {
  const args = process.argv.slice(2);
  const config = loadConfig();

  const textIdx = args.indexOf("--text");
  const fileIdx = args.indexOf("--file");
  const dirIdx = args.indexOf("--dir");
  const extIdx = args.indexOf("--ext");
  const stdinMode = args.includes("--stdin");

  if (dirIdx !== -1 && args[dirIdx + 1]) {
    const dirPath = path.resolve(args[dirIdx + 1]);
    if (!fs.existsSync(dirPath)) {
      console.error(chalk.red(`❌ 找不到目錄：${dirPath}`));
      process.exit(2);
    }
    const extensions =
      extIdx !== -1 ? args.slice(extIdx + 1).filter((a) => a.startsWith(".")) : undefined;

    console.log(chalk.bold(`\n🔍 掃描目錄：${dirPath}`));
    if (extensions) console.log(chalk.dim(`   副檔名篩選：${extensions.join(", ")}`));

    const files = collectFiles(dirPath, extensions);
    console.log(chalk.dim(`   找到 ${files.length} 個檔案\n`));

    let anyUnsafe = false;
    for (const f of files) {
      try {
        const content = fs.readFileSync(f, "utf-8");
        const result = scanText(content, config);
        if (!result.safe) {
          anyUnsafe = true;
          printCliResult(result, f);
        }
      } catch {
        /* 跳過二進位檔案 */
      }
    }

    if (!anyUnsafe) {
      console.log(chalk.green(`✅ 掃描完成，${files.length} 個檔案均未發現敏感內容。\n`));
    }
    process.exit(anyUnsafe ? 1 : 0);
  }

  if (textIdx !== -1 && args[textIdx + 1]) {
    const text = args[textIdx + 1];
    const result = scanText(text, config);
    printCliResult(result, "(直接輸入文字)");
    process.exit(result.safe ? 0 : 1);
  }

  if (fileIdx !== -1 && args[fileIdx + 1]) {
    const filePath = path.resolve(args[fileIdx + 1]);
    if (!fs.existsSync(filePath)) {
      console.error(chalk.red(`❌ 找不到檔案：${filePath}`));
      process.exit(2);
    }
    const content = fs.readFileSync(filePath, "utf-8");
    const result = scanText(content, config);
    printCliResult(result, filePath);
    process.exit(result.safe ? 0 : 1);
  }

  if (stdinMode || !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const content = Buffer.concat(chunks).toString("utf-8");
    const result = scanText(content, config);
    printCliResult(result, "(stdin)");
    process.exit(result.safe ? 0 : 1);
  }

  console.log(chalk.bold("\n🛡️  sensitive-guard — 敏感內容守門員\n"));
  console.log("用法：");
  console.log("  npx tsx src/index.ts --cli --text '你的內容'");
  console.log("  npx tsx src/index.ts --cli --file ./path/to/file.ts");
  console.log("  npx tsx src/index.ts --cli --dir ./src");
  console.log("  npx tsx src/index.ts --cli --dir ./src --ext .ts .env .json");
  console.log("  cat file.ts | npx tsx src/index.ts --cli --stdin");
  console.log("\nMCP Server 模式（由 OpenCode 自動啟動）：");
  console.log("  node dist/index.js");
  console.log("");
}
