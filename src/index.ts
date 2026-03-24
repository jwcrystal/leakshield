#!/usr/bin/env node
/**
 * sensitive-guard — entry point
 * MCP Server 模式：由 OpenCode / Claude Code 自動呼叫
 * CLI 掃描模式：npx tsx src/index.ts --cli --text "..."
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./transports/mcp.js";
import { runCli } from "./transports/cli.js";

// Re-export for tests and external consumers
export type { GuardConfig, Finding, ScanResult, FindingType, Rule } from "./types.js";
export { BUILTIN_RULES } from "./rules/builtin.js";
export { buildDynamicRules } from "./rules/dynamic.js";
export { redact, getLineCol } from "./scanner/utils.js";
export { scanText } from "./scanner/engine.js";

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const isCliMode = process.argv.includes("--cli");

if (isCliMode) {
  await runCli();
} else {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
