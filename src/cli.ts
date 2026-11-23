#!/usr/bin/env node
/**
 * leakshield — entry point
 * CLI 掃描模式：npx tsx src/cli.ts --cli --text "..."
 * Web 模式：npx tsx src/cli.ts --web
 */

import { initWindowsEncoding } from "./utils/win-encoding.js";
import { runCli } from "./transports/cli.js";
import { runWeb } from "./transports/web.js";
import { HELP_TEXT, isHelpRequest } from "./help.js";

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
const piIndex = args.indexOf("--pi");
const isPiSubcommand = piIndex === -1 && args[2] === "pi";
const isPiMode = piIndex !== -1 || isPiSubcommand;
const isPiInstallMode = args.includes("--pi-install");
const valueOf = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined;
};

if (isHelpRequest(args) && !isPiMode) {
  console.log(HELP_TEXT);
} else if (isPiInstallMode) {
  const { runPiInstall } = await import("./pi/cli.js");
  process.exitCode = runPiInstall(args);
} else if (isPiMode) {
  const { runPi } = await import("./pi/cli.js");
  const piArgs = piIndex !== -1 ? args.slice(piIndex + 1) : args.slice(3);
  process.exitCode = await runPi(piArgs);
} else if (isForgetMode) {
  // W2/B5: active erasure of persisted mappings. Content-free output.
  const { runForget } = await import("./forget.js");
  const { defaultStorePath } = await import("./decision/mapping-key.js");
  process.exitCode = runForget({
    all: args.includes("--all"),
    session: valueOf("--session"),
    storePath: valueOf("--path") ?? defaultStorePath(),
  });
} else if (args.includes("--claude-code-proxy")) {
  const { runClaudeCodeProxy } = await import("./claude-code/cli.js");
  process.exitCode = await runClaudeCodeProxy(args);
} else if (isDoctorMode) {
  const { runDoctor, createDoctorDeps, formatDoctorReport, doctorExitCode } = await import("./doctor.js");
  const { runClaudeCodeDoctor, createClaudeCodeDoctorDeps } = await import("./claude-code/doctor.js");
  const { runPiDoctor, createPiDoctorDeps } = await import("./pi/doctor.js");
  const report = await runDoctor(createDoctorDeps());
  report.claudeCode = await runClaudeCodeDoctor(createClaudeCodeDoctorDeps());
  report.pi = await runPiDoctor(createPiDoctorDeps());
  console.log(formatDoctorReport(report));
  process.exitCode = doctorExitCode(report);
} else if (isWebMode) {
  const portIdx = args.indexOf("--port");
  const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) || 3000 : 3000;
  await runWeb(port);
} else if (isCliMode) {
  await runCli();
} else {
  await runCli();
}
