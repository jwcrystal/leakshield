#!/usr/bin/env node
/**
 * sensitive-guard — entry point
 * CLI 掃描模式：npx tsx src/cli.ts --cli --text "..."
 * Web 模式：npx tsx src/cli.ts --web
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
const isForgetMode = args.includes("--forget");
const valueOf = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined;
};

if (isForgetMode) {
  // W2/B5: active erasure of persisted mappings. Content-free output.
  const { runForget } = await import("./forget.js");
  const { defaultStorePath } = await import("./decision/mapping-key.js");
  process.exitCode = runForget({
    all: args.includes("--all"),
    session: valueOf("--session"),
    storePath: valueOf("--path") ?? defaultStorePath(),
  });
} else if (isDoctorMode) {
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
