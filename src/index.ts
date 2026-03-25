#!/usr/bin/env node
/**
 * sensitive-guard — entry point
 * MCP Server 模式：由 OpenCode / Claude Code 自動呼叫
 * CLI 掃描模式：npx tsx src/index.ts --cli --text "..."
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./transports/mcp.js";
import { runCli } from "./transports/cli.js";
import { runWeb } from "./transports/web.js";

// Re-export for tests and external consumers
export type { GuardConfig, Finding, ScanResult, FindingType, Rule } from "./types.js";
export { BUILTIN_RULES } from "./rules/builtin.js";
export { buildDynamicRules } from "./rules/dynamic.js";
export { redact, getLineCol } from "./scanner/utils.js";
export { scanText } from "./scanner/engine.js";

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const args = process.argv;
const isCliMode = args.includes("--cli");
const isWebMode = args.includes("--web");

if (isWebMode) {
  const portIdx = args.indexOf("--port");
  const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) || 3000 : 3000;
  await runWeb(port);
} else if (isCliMode) {
  await runCli();
} else {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
