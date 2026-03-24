import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import type { Finding } from "../types.js";
import { loadConfig } from "../config/loader.js";
import { scanText } from "../scanner/engine.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__"]);

function collectFiles(dir: string, extensions?: string[], maxFiles = 100): string[] {
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

export function createMcpServer() {
  const config = loadConfig();
  const server = new McpServer({ name: "sensitive-guard", version: "1.0.0" });

  server.tool(
    "scan_text",
    "在將任何程式碼、文件或資料傳送給 AI 服務之前，先用此工具掃描是否含有敏感內容（API Key、PII、NDA 關鍵字、DB 連線字串等）。若偵測到問題，會攔截並報告，不會自動修改內容。",
    {
      content: z.string().describe("要掃描的文字內容（程式碼、JSON、文件等）"),
      label: z.string().optional().describe("這段內容的說明標籤，方便識別（例如：config.ts、用戶資料 CSV）"),
    },
    async ({ content, label }) => {
      const result = scanText(content, config);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ label: label ?? "(未命名)", ...result }, null, 2) }],
      };
    }
  );

  server.tool(
    "scan_file",
    "掃描本機檔案的敏感內容。在讀取並傳送檔案給 AI 之前，先呼叫此工具確認安全。",
    { file_path: z.string().describe("要掃描的檔案絕對路徑或相對路徑") },
    async ({ file_path }) => {
      const resolved = path.resolve(file_path);
      if (!fs.existsSync(resolved)) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: `找不到檔案：${resolved}` }, null, 2) }] };
      }
      const content = fs.readFileSync(resolved, "utf-8");
      const result = scanText(content, config);
      return { content: [{ type: "text" as const, text: JSON.stringify({ file: resolved, ...result }, null, 2) }] };
    }
  );

  server.tool(
    "scan_dir",
    "掃描一個目錄下所有文字檔的敏感內容。會遞迴掃描並彙整報告，在讓 AI 讀取專案目錄前使用。",
    {
      dir_path: z.string().describe("要掃描的目錄絕對路徑或相對路徑"),
      extensions: z.array(z.string()).optional().describe("只掃描指定副檔名，例如 ['.ts', '.env', '.json']。不填則掃描所有文字檔"),
      max_files: z.number().optional().describe("最多掃描幾個檔案（預設 100）"),
    },
    async ({ dir_path, extensions, max_files = 100 }) => {
      const resolved = path.resolve(dir_path);
      if (!fs.existsSync(resolved)) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: `目錄不存在：${resolved}` }, null, 2) }] };
      }

      const files = collectFiles(resolved, extensions, max_files);
      const dirResults: { file: string; safe: boolean; total_findings: number; findings: Finding[] }[] = [];
      let totalFindings = 0;
      let unsafeFiles = 0;

      for (const f of files) {
        try {
          const content = fs.readFileSync(f, "utf-8");
          const result = scanText(content, config);
          totalFindings += result.total_findings;
          if (!result.safe) {
            unsafeFiles++;
            dirResults.push({ file: f, safe: result.safe, total_findings: result.total_findings, findings: result.findings });
          }
        } catch { /* 跳過無法讀取的檔案 */ }
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

      return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
    }
  );

  server.tool(
    "reload_config",
    "重新載入 guard.config.yaml 設定檔（修改 NDA 關鍵字或私有域名後使用）。",
    {},
    async () => {
      try {
        const newConfig = loadConfig();
        Object.assign(config, newConfig);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: "設定檔已重新載入", nda_keywords: newConfig.nda_keywords, private_domains: newConfig.private_domains }, null, 2) }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: String(e) }, null, 2) }] };
      }
    }
  );

  return server;
}
