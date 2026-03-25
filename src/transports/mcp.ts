import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import type { Finding } from "../types.js";
import type { GuardDecisionResult } from "../decision/model.js";
import { loadConfig } from "../config/loader.js";
import { scanText, redactText } from "../scanner/engine.js";
import { toDecisionResult } from "../decision/model.js";
import { collectFiles, runWithConcurrency } from "../utils/files.js";
import { resolveWorkspacePath, isPathInsideBase } from "../utils/path-security.js";

const SCAN_CONCURRENCY = 8;

// ─── Shared decision serializer ───────────────────────────────────────────────

/**
 * Shape the MCP response payload from a `GuardDecisionResult`.
 * Preserves the `safe` field for backward-compatible callers while adding the
 * full decision contract.  Never includes raw `match_text` in the output.
 */
export function serializeDecisionPayload({
  label,
  content: _content,
  result,
}: {
  label: string;
  content: string;
  result: GuardDecisionResult;
}): Record<string, unknown> {
  return {
    label,
    safe: result.decision === "ALLOW",
    decision: result.decision,
    riskLevel: result.riskLevel,
    summary: result.summary,
    findings: result.findings,
    recommendedAction: result.recommendedAction,
    ...(result.safePreview !== undefined ? { safePreview: result.safePreview } : {}),
    ...(result.redactedContent !== undefined ? { redactedContent: result.redactedContent } : {}),
  };
}

export function createMcpServer() {
  const configRef = { current: loadConfig() };
  const workspaceRoot = fs.realpathSync(process.cwd());
  const server = new McpServer({ name: "sensitive-guard", version: "1.0.0" });

  server.tool(
    "scan_text",
    "在將任何程式碼、文件或資料傳送給 AI 服務之前，先用此工具掃描是否含有敏感內容（API Key、PII、NDA 關鍵字、DB 連線字串等）。\n\n**REQUIRED BEHAVIOR**:\n- If result.decision === 'ALLOW' or 'WARN': you may continue, but surface the warning to the user.\n- If result.decision === 'CONFIRM': YOU MUST STOP. Do NOT send the original content to any AI service. Ask the user to choose one of: (1) cancel, (2) send redacted — use result.redactedContent if available, (3) send original anyway — only if the user explicitly says so with words like 'override', 'send original', or 'continue with original'.\n- Never treat an ambiguous acknowledgment ('ok', 'sure', 'continue') as an override.",
    {
      content: z.string().describe("要掃描的文字內容（程式碼、JSON、文件等）"),
      label: z.string().optional().describe("這段內容的說明標籤，方便識別（例如：config.ts、用戶資料 CSV）"),
    },
    async ({ content, label }) => {
      const scanResult = scanText(content, configRef.current);
      const decisionResult = toDecisionResult(scanResult, content);
      const lbl = label ?? "(未命名)";
      const payload = serializeDecisionPayload({ label: lbl, content, result: decisionResult });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    }
  );

  server.tool(
    "scan_file",
    "掃描本機檔案的敏感內容。在讀取並傳送檔案給 AI 之前，先呼叫此工具確認安全。\n\n**REQUIRED BEHAVIOR**: Same as scan_text — if result.decision === 'CONFIRM', YOU MUST STOP and ask the user to choose: cancel, send redacted, or explicit override. Do not proceed automatically.",
    {
      file_path: z.string().describe("要掃描的檔案絕對路徑或相對路徑"),
      allow_outside: z.boolean().optional().describe("允許掃描工作目錄以外的檔案（預設 false）。請謹慎使用，僅在明確需要掃描外部路徑時傳入 true"),
    },
    async ({ file_path, allow_outside = false }) => {
      const requestedPath = resolveWorkspacePath(process.cwd(), file_path);
      if (!fs.existsSync(requestedPath)) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: `找不到檔案：${requestedPath}` }, null, 2) }] };
      }
      const resolved = fs.realpathSync(requestedPath);
      if (!allow_outside && !isPathInsideBase(workspaceRoot, resolved) && resolved !== workspaceRoot) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Path is outside allowed workspace. Pass allow_outside: true to override." }, null, 2) }] };
      }
      const content = fs.readFileSync(resolved, "utf-8");
      const scanResult = scanText(content, configRef.current);
      const decisionResult = toDecisionResult(scanResult, content);
      const payload = serializeDecisionPayload({ label: resolved, content, result: decisionResult });
      return { content: [{ type: "text" as const, text: JSON.stringify({ file: resolved, ...payload }, null, 2) }] };
    }
  );

  server.tool(
    "scan_dir",
    "掃描一個目錄下所有文字檔的敏感內容。會遞迴掃描並彙整報告，在讓 AI 讀取專案目錄前使用。",
    {
      dir_path: z.string().describe("要掃描的目錄絕對路徑或相對路徑"),
      extensions: z.array(z.string()).optional().describe("只掃描指定副檔名，例如 ['.ts', '.env', '.json']。不填則掃描所有文字檔"),
      max_files: z.number().optional().describe("最多掃描幾個檔案（預設 100）"),
      allow_outside: z.boolean().optional().describe("允許掃描工作目錄以外的目錄（預設 false）。請謹慎使用，僅在明確需要掃描外部路徑時傳入 true"),
    },
    async ({ dir_path, extensions, max_files = 100, allow_outside = false }) => {
      const requestedPath = resolveWorkspacePath(process.cwd(), dir_path);
      if (!fs.existsSync(requestedPath)) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: `目錄不存在：${requestedPath}` }, null, 2) }] };
      }
      const resolved = fs.realpathSync(requestedPath);
      if (!allow_outside && !isPathInsideBase(workspaceRoot, resolved) && resolved !== workspaceRoot) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Path is outside allowed workspace. Pass allow_outside: true to override." }, null, 2) }] };
      }

      const files = collectFiles(resolved, extensions, max_files);
      const dirResults: { file: string; safe: boolean; total_findings: number; findings: Finding[] }[] = [];
      let totalFindings = 0;
      let unsafeFiles = 0;
      let skippedFiles = 0;

      const tasks = files.map((f) => async () => {
        try {
          const content = await fs.promises.readFile(f, "utf-8");
          return { file: f, result: scanText(content, configRef.current) };
        } catch {
          return null;
        }
      });

      const scanResults = await runWithConcurrency(tasks, SCAN_CONCURRENCY);

      for (const item of scanResults) {
        if (!item) { skippedFiles++; continue; }
        totalFindings += item.result.total_findings;
        if (!item.result.safe) {
          unsafeFiles++;
          dirResults.push({ file: item.file, safe: item.result.safe, total_findings: item.result.total_findings, findings: item.result.findings });
        }
      }

      const output = {
        dir: resolved,
        scanned_files: files.length,
        skipped_files: skippedFiles,
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
    "redact_text",
    "將文字中的敏感內容（API Key、PII、DB 連線字串等）替換為 [REDACTED_TYPE] 佔位符，回傳脫敏後文字與命中清單。使用 dry_run: true 可只預覽命中位置，不回傳脫敏文字。",
    {
      content: z.string().describe("要脫敏的文字內容"),
      label: z.string().optional().describe("內容說明標籤（例如：config.ts、用戶資料）"),
      dry_run: z.boolean().optional().default(false).describe("true 時只回傳 findings 清單，不回傳脫敏文字（用於確認範圍）"),
    },
    async ({ content, label, dry_run }) => {
      const result = redactText(content, configRef.current);
      const output = dry_run
        ? { label: label ?? "(未命名)", dry_run: true, total_findings: result.total_findings, summary: result.summary, findings: result.findings }
        : { label: label ?? "(未命名)", ...result };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
      };
    }
  );

  server.tool(
    "reload_config",
    "重新載入 guard.config.yaml 設定檔（修改 NDA 關鍵字或私有域名後使用）。",
    {},
    async () => {
      try {
        const newConfig = loadConfig();
        configRef.current = newConfig;
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: "設定檔已重新載入", nda_keywords: newConfig.nda_keywords, private_domains: newConfig.private_domains }, null, 2) }],
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("[sensitive-guard] reload_config failed:", message);
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: message }, null, 2) }] };
      }
    }
  );

  return server;
}
