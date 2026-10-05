#!/usr/bin/env node
/**
 * sensitive-guard — entry point
 * CLI 掃描模式：npx tsx src/index.ts --cli --text "..."
 * Web 模式：npx tsx src/index.ts --web
 */

import { initWindowsEncoding } from "./utils/win-encoding.js";
import { runCli } from "./transports/cli.js";
import { runWeb } from "./transports/web.js";

// Re-export for tests and external consumers
export type { GuardConfig, Finding, ScanResult, FindingType, Rule } from "./types.js";
export { BUILTIN_RULES } from "./rules/builtin.js";
export { buildDynamicRules } from "./rules/dynamic.js";
export { redact, getLineCol, getIgnoredLines } from "./scanner/utils.js";
export { scanText } from "./scanner/engine.js";
export type {
  GuardDecision,
  GuardRiskLevel,
  GuardRecommendedAction,
  GuardDecisionFinding,
  GuardDecisionResult,
} from "./decision/model.js";
export { toDecisionResult } from "./decision/model.js";
export { protectText, protectUnknownStrings } from "./decision/ingress.js";
export type { IngressMode, ProtectionAction, ProtectedText, ProtectionOptions } from "./decision/ingress.js";

// Security enhancement exports
export { scanTextWithDecoding } from "./scanner/engine.js";
export type { ScanWithDecodingResult } from "./scanner/encoding.js";
export {
  sanitizeForScanning,
  isLikelyHomographAttack,
  detectSuspiciousUnicode,
} from "./scanner/unicode.js";

// ─── Bootstrap ───────────────────────────────────────────────────────────────

// Ensure UTF-8 console on Windows before any I/O
initWindowsEncoding();

const args = process.argv;
const isCliMode = args.includes("--cli");
const isWebMode = args.includes("--web");
const isDoctorMode = args.includes("--doctor");

if (isDoctorMode) {
  const { runDoctor, createDoctorDeps, formatDoctorReport } = await import("./doctor.js");
  const report = await runDoctor(createDoctorDeps());
  console.log(formatDoctorReport(report));
  process.exitCode = report.status === "PROTECTED" || report.status === "PARTIAL" ? 0 : 1;
} else if (isWebMode) {
  const portIdx = args.indexOf("--port");
  const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) || 3000 : 3000;
  await runWeb(port);
} else if (isCliMode) {
  await runCli();
} else {
  await runCli();
}
