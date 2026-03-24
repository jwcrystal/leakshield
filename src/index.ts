#!/usr/bin/env node
/**
 * sensitive-guard
 * MCP Server + CLI: 發送給 AI 前的敏感內容守門員
 *
 * 使用方式：
 *   MCP Server：由 OpenCode / Claude Code 自動呼叫
 *   CLI 掃描：npx tsx src/index.ts --cli --text "你的內容"
 *              npx tsx src/index.ts --cli --file ./yourfile.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as yaml from "js-yaml";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";

// ─── 型別定義 ───────────────────────────────────────────────────────────────

export interface GuardConfig {
  nda_keywords: string[];
  private_domains: string[];
  settings: {
    max_chars: number;
    show_line_numbers: boolean;
    preview_length: number;
  };
}

interface Finding {
  type: FindingType;
  severity: "HIGH" | "MEDIUM" | "LOW";
  line?: number;
  column?: number;
  preview: string; // 遮蔽後的預覽（不含真實敏感值）
  description: string;
}

type FindingType =
  | "API_KEY"
  | "SECRET"
  | "TOKEN"
  | "PII_EMAIL"
  | "PII_PHONE_TW"
  | "PII_PHONE_INTL"
  | "PII_ID_TW"
  | "DB_CONNECTION"
  | "PRIVATE_DOMAIN"
  | "NDA_KEYWORD";

interface ScanResult {
  safe: boolean;
  total_findings: number;
  findings: Finding[];
  summary: string;
  recommendation: string;
}

// ─── 設定檔載入 ──────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadConfig(): GuardConfig {
  const configPaths = [
    path.resolve(process.cwd(), "config/guard.config.yaml"),
    path.resolve(__dirname, "../config/guard.config.yaml"),
    path.resolve(process.env.HOME ?? "~", ".sensitive-guard/guard.config.yaml"),
  ];

  for (const p of configPaths) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      return yaml.load(raw) as GuardConfig;
    }
  }

  // 預設設定（找不到 config 時）
  return {
    nda_keywords: ["CONFIDENTIAL", "INTERNAL ONLY", "DO NOT SHARE", "NDA"],
    private_domains: [],
    settings: { max_chars: 200000, show_line_numbers: true, preview_length: 60 },
  };
}

// ─── 偵測規則 ────────────────────────────────────────────────────────────────

interface Rule {
  type: FindingType;
  severity: Finding["severity"];
  description: string;
  pattern: RegExp;
}

export const BUILTIN_RULES: Rule[] = [
  // ── API Keys / Secrets / Tokens ──────────────────────────────────────────
  {
    type: "API_KEY",
    severity: "HIGH",
    description: "OpenAI API Key",
    pattern: /sk-[A-Za-z0-9]{20,60}/g,
  },
  {
    type: "API_KEY",
    severity: "HIGH",
    description: "Anthropic API Key",
    pattern: /sk-ant-[A-Za-z0-9\-_]{20,80}/g,
  },
  {
    type: "API_KEY",
    severity: "HIGH",
    description: "Google API Key",
    pattern: /AIza[0-9A-Za-z\-_]{35}/g,
  },
  {
    type: "API_KEY",
    severity: "HIGH",
    description: "AWS Access Key ID",
    pattern: /(?<![A-Z0-9])[A-Z0-9]{20}(?![A-Z0-9])/g,
  },
  {
    type: "SECRET",
    severity: "HIGH",
    description: "AWS Secret Access Key",
    pattern: /(?:aws.{0,10})?['\"]([A-Za-z0-9\/+]{40})['"]/gi,
  },
  {
    type: "TOKEN",
    severity: "HIGH",
    description: "GitHub Personal Access Token",
    pattern: /ghp_[A-Za-z0-9]{36}/g,
  },
  {
    type: "TOKEN",
    severity: "HIGH",
    description: "GitHub OAuth / App Token",
    pattern: /gho_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}/g,
  },
  {
    type: "TOKEN",
    severity: "HIGH",
    description: "Generic Bearer Token（長度 ≥ 32 的字串）",
    pattern: /bearer\s+[A-Za-z0-9\-_\.]{32,}/gi,
  },
  {
    type: "SECRET",
    severity: "HIGH",
    description: "Generic Secret / Password 賦值",
    pattern:
      /(?:password|passwd|secret|private_key|client_secret)\s*[:=]\s*['"]([^'"]{8,})['"]/gi,
  },
  {
    type: "TOKEN",
    severity: "HIGH",
    description: "JWT Token",
    pattern: /eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_.+/=]+/g,
  },

  // ── PII ──────────────────────────────────────────────────────────────────
  {
    type: "PII_EMAIL",
    severity: "MEDIUM",
    description: "Email 地址",
    pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
  },
  {
    type: "PII_PHONE_TW",
    severity: "MEDIUM",
    description: "台灣手機號碼",
    pattern: /(?:(?:\+886)|0)9\d{2}[-\s]?\d{3}[-\s]?\d{3}/g,
  },
  {
    type: "PII_PHONE_INTL",
    severity: "LOW",
    description: "國際電話號碼",
    pattern: /\+[1-9]\d{6,14}\b/g,
  },
  {
    type: "PII_ID_TW",
    severity: "HIGH",
    description: "台灣身份證字號",
    pattern: /[A-Z][12]\d{8}/g,
  },

  // ── 資料庫連線字串 ────────────────────────────────────────────────────────
  {
    type: "DB_CONNECTION",
    severity: "HIGH",
    description: "資料庫連線字串（含密碼）",
    pattern:
      /(?:mongodb|postgresql|postgres|mysql|redis|mssql):\/\/[^:\s]+:[^@\s]+@[^\s"']+/gi,
  },
  {
    type: "DB_CONNECTION",
    severity: "HIGH",
    description: "DB Connection String（ADO 格式）",
    pattern: /(?:Data Source|Server|Host)\s*=\s*[^;]+;\s*(?:Password|Pwd)\s*=\s*[^;]+/gi,
  },
];

// ─── 核心掃描器 ──────────────────────────────────────────────────────────────

export function redact(value: string, previewLen: number): string {
  if (value.length <= 8) return "****";
  return value.slice(0, 4) + "****" + value.slice(-2);
}

export function buildDynamicRules(config: GuardConfig): Rule[] {
  const rules: Rule[] = [];

  // NDA 關鍵字（大小寫不敏感）
  for (const kw of config.nda_keywords) {
    rules.push({
      type: "NDA_KEYWORD",
      severity: "HIGH",
      description: `NDA 關鍵字「${kw}」`,
      pattern: new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
    });
  }

  // 私有域名
  for (const domain of config.private_domains) {
    rules.push({
      type: "PRIVATE_DOMAIN",
      severity: "MEDIUM",
      description: `私有域名「${domain}」`,
      pattern: new RegExp(domain.replace(/\./g, "\\."), "gi"),
    });
  }

  return rules;
}

export function getLineCol(text: string, index: number): { line: number; col: number } {
  const before = text.slice(0, index);
  const lines = before.split("\n");
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

export function scanText(text: string, config: GuardConfig): ScanResult {
  const truncated = text.slice(0, config.settings.max_chars);
  const allRules = [...BUILTIN_RULES, ...buildDynamicRules(config)];
  const findings: Finding[] = [];
  const seen = new Set<string>(); // 避免同類型同位置重複

  for (const rule of allRules) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = rule.pattern.exec(truncated)) !== null) {
      const matchedText = match[0];
      const key = `${rule.type}:${match.index}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const { line, col } = getLineCol(truncated, match.index);
      const preview = redact(matchedText, config.settings.preview_length);

      findings.push({
        type: rule.type,
        severity: rule.severity,
        line: config.settings.show_line_numbers ? line : undefined,
        column: config.settings.show_line_numbers ? col : undefined,
        preview,
        description: rule.description,
      });
    }
  }

  const safe = findings.length === 0;
  const highCount = findings.filter((f) => f.severity === "HIGH").length;
  const medCount = findings.filter((f) => f.severity === "MEDIUM").length;

  const summary = safe
    ? "✅ 未偵測到敏感內容，可以安全傳送。"
    : `🚨 發現 ${findings.length} 個潛在敏感項目（HIGH: ${highCount}, MEDIUM: ${medCount}, LOW: ${findings.length - highCount - medCount}）`;

  const recommendation = safe
    ? "內容看起來安全，但仍請確認沒有業務邏輯上的機密資訊。"
    : "⛔ 建議先處理上述敏感項目後再傳送給 AI 服務。請用假資料、佔位符或移除敏感欄位後再重試。";

  return { safe, total_findings: findings.length, findings, summary, recommendation };
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

function createMcpServer() {
  const config = loadConfig();
  const server = new McpServer({
    name: "sensitive-guard",
    version: "1.0.0",
  });

  // Tool 1: scan_text — 掃描文字內容
  server.tool(
    "scan_text",
    "在將任何程式碼、文件或資料傳送給 AI 服務之前，先用此工具掃描是否含有敏感內容（API Key、PII、NDA 關鍵字、DB 連線字串等）。若偵測到問題，會攔截並報告，不會自動修改內容。",
    {
      content: z.string().describe("要掃描的文字內容（程式碼、JSON、文件等）"),
      label: z
        .string()
        .optional()
        .describe("這段內容的說明標籤，方便識別（例如：config.ts、用戶資料 CSV）"),
    },
    async ({ content, label }) => {
      const result = scanText(content, config);
      const labelStr = label ? ` [${label}]` : "";

      const output = {
        label: label ?? "(未命名)",
        ...result,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(output, null, 2),
          },
        ],
      };
    }
  );

  // Tool 2: scan_file — 掃描檔案（路徑）
  server.tool(
    "scan_file",
    "掃描本機檔案的敏感內容。在讀取並傳送檔案給 AI 之前，先呼叫此工具確認安全。",
    {
      file_path: z.string().describe("要掃描的檔案絕對路徑或相對路徑"),
    },
    async ({ file_path }) => {
      const resolved = path.resolve(file_path);

      if (!fs.existsSync(resolved)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `找不到檔案：${resolved}` }, null, 2),
            },
          ],
        };
      }

      const content = fs.readFileSync(resolved, "utf-8");
      const result = scanText(content, config);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ file: resolved, ...result }, null, 2),
          },
        ],
      };
    }
  );

  // Tool 3: scan_dir — 掃描整個目錄
  server.tool(
    "scan_dir",
    "掃描一個目錄下所有文字檔的敏感內容。會遞迴掃描並彙整報告，在讓 AI 讀取專案目錄前使用。",
    {
      dir_path: z.string().describe("要掃描的目錄絕對路徑或相對路徑"),
      extensions: z
        .array(z.string())
        .optional()
        .describe("只掃描指定副檔名，例如 ['.ts', '.env', '.json']。不填則掃描所有文字檔"),
      max_files: z
        .number()
        .optional()
        .describe("最多掃描幾個檔案（預設 100）"),
    },
    async ({ dir_path, extensions, max_files = 100 }) => {
      const resolved = path.resolve(dir_path);
      if (!fs.existsSync(resolved)) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `目錄不存在：${resolved}` }, null, 2) }],
        };
      }

      // 遞迴收集檔案
      const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__"]);
      const files: string[] = [];

      function collect(dir: string) {
        if (files.length >= max_files) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (files.length >= max_files) break;
          if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) collect(path.join(dir, entry.name));
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (!extensions || extensions.includes(ext)) {
              files.push(path.join(dir, entry.name));
            }
          }
        }
      }
      collect(resolved);

      const dirResults: { file: string; safe: boolean; total_findings: number; findings: Finding[] }[] = [];
      let totalFindings = 0;
      let unsafeFiles = 0;

      for (const f of files) {
        try {
          const content = fs.readFileSync(f, "utf-8");
          const result = scanText(content, config);
          totalFindings += result.total_findings;
          if (!result.safe) unsafeFiles++;
          if (!result.safe) {
            dirResults.push({ file: f, safe: result.safe, total_findings: result.total_findings, findings: result.findings });
          }
        } catch {
          // 跳過無法讀取的檔案（二進位等）
        }
      }

      const output = {
        dir: resolved,
        scanned_files: files.length,
        unsafe_files: unsafeFiles,
        total_findings: totalFindings,
        safe: unsafeFiles === 0,
        summary: unsafeFiles === 0
          ? `✅ 掃描 ${files.length} 個檔案，未發現敏感內容`
          : `🚨 掃描 ${files.length} 個檔案，${unsafeFiles} 個檔案含敏感內容，共 ${totalFindings} 個命中`,
        details: dirResults,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
      };
    }
  );

  // Tool 5: reload_config — 重新載入設定檔（修改 YAML 後不用重啟）
  server.tool(
    "reload_config",
    "重新載入 guard.config.yaml 設定檔（修改 NDA 關鍵字或私有域名後使用）。",
    {},
    async () => {
      try {
        const newConfig = loadConfig();
        Object.assign(config, newConfig);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  message: "設定檔已重新載入",
                  nda_keywords: newConfig.nda_keywords,
                  private_domains: newConfig.private_domains,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: String(e) }, null, 2),
            },
          ],
        };
      }
    }
  );

  return server;
}

// ─── CLI 模式 ─────────────────────────────────────────────────────────────────

function printCliResult(result: ScanResult, label: string) {
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
        // 最多顯示 5 個
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

function collectFiles(dir: string, extensions?: string[], maxFiles = 200): string[] {
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

async function runCli() {
  const args = process.argv.slice(2);
  const config = loadConfig();

  // 解析 --text 或 --file 或 --dir
  const textIdx = args.indexOf("--text");
  const fileIdx = args.indexOf("--file");
  const dirIdx = args.indexOf("--dir");
  const extIdx = args.indexOf("--ext");
  const stdinMode = args.includes("--stdin");

  // --dir 模式：掃描整個目錄
  if (dirIdx !== -1 && args[dirIdx + 1]) {
    const dirPath = path.resolve(args[dirIdx + 1]);
    if (!fs.existsSync(dirPath)) {
      console.error(chalk.red(`❌ 找不到目錄：${dirPath}`));
      process.exit(2);
    }
    const extensions = extIdx !== -1
      ? args.slice(extIdx + 1).filter(a => a.startsWith("."))
      : undefined;

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
      } catch { /* 跳過二進位檔案 */ }
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
    // 從 stdin 讀取
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const content = Buffer.concat(chunks).toString("utf-8");
    const result = scanText(content, config);
    printCliResult(result, "(stdin)");
    process.exit(result.safe ? 0 : 1);
  }

  // 沒有給任何輸入時顯示用法
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

// ─── 進入點 ───────────────────────────────────────────────────────────────────

const isCliMode = process.argv.includes("--cli");

if (isCliMode) {
  await runCli();
} else {
  // MCP Server 模式
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server 持續運行直到被關閉
}
