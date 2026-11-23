/**
 * `leakshield --doctor [host]` dispatch.
 *
 * Every host keeps its own checks and verdict. With no target the aggregate
 * report decides as before; a target prints only that host and returns an exit
 * code for it, so CI can check one integration without another host's state
 * changing the answer.
 */
import {
  createDoctorDeps,
  runDoctor,
} from "./adapters/opencode/doctor.js";
import { doctorExitCode, formatDoctorReport, type DoctorCheck } from "./doctor-report.js";
import { createClaudeCodeDoctorDeps, runClaudeCodeDoctor } from "./adapters/claude-code/doctor.js";
import { createPiDoctorDeps, runPiDoctor } from "./adapters/pi/doctor.js";
import { CLAUDE_CODE_CAPABILITIES } from "./adapters/claude-code/capabilities.js";
import { PI_CAPABILITIES } from "./adapters/pi/capabilities.js";
import { OPENCODE_CAPABILITIES } from "./adapters/opencode/capabilities.js";
import { capabilityCapText, capabilitySection } from "./doctor-capabilities.js";
import { capabilityVerdict, type HostCapabilities } from "./types/capabilities.js";

export type DoctorTarget = "all" | "opencode" | "claude-code" | "pi";

const TARGETS: ReadonlySet<string> = new Set(["all", "opencode", "claude-code", "pi"]);

/** Reads `--doctor=pi`, `--doctor pi`, or a bare `--doctor` (all). */
export function parseDoctorTarget(args: readonly string[]): DoctorTarget | { error: string } {
  const inline = args.find((arg) => arg.startsWith("--doctor="));
  let raw: string | undefined;
  if (inline !== undefined) {
    raw = inline.slice("--doctor=".length);
  } else {
    const index = args.indexOf("--doctor");
    const next = index === -1 ? undefined : args[index + 1];
    if (next !== undefined && !next.startsWith("-")) raw = next;
  }
  if (raw === undefined) return "all";
  if (raw.length === 0) return { error: "doctor target is missing; use opencode, claude-code, pi or all" };
  if (raw === "all") return "all";
  if (TARGETS.has(raw)) return raw as DoctorTarget;
  return { error: `unknown doctor target "${raw}"; use opencode, claude-code, pi or all` };
}

const ICON = { ok: "[OK]  ", warn: "[WARN]", fail: "[FAIL]", skip: "[SKIP]" } as const;

function printSection(
  title: string,
  checks: readonly DoctorCheck[],
  verdict: string,
  capabilities?: HostCapabilities,
): void {
  const lines = [`leakshield doctor — ${title}`];
  for (const check of checks) {
    lines.push(`${ICON[check.state]} ${check.id}: ${check.detail}`);
    if (check.fix) lines.push(`       fix: ${check.fix}`);
  }
  if (capabilities) {
    lines.push("");
    lines.push(...capabilitySection(capabilities));
  }
  lines.push("");
  lines.push(`Verdict: ${verdict}`);
  console.log(lines.join("\n"));
}

/**
 * A declaration can only lower a verdict. `unknown` and `outside` rows cap the
 * host at PARTIAL even when its install-level checks pass; a broken install
 * keeps its own failing verdict.
 */
function withCoverage(
  result: { exit: number; verdict: string },
  capabilities?: HostCapabilities,
): { exit: number; verdict: string } {
  if (capabilities === undefined) return result;
  if (capabilityVerdict(capabilities).verdict === "PROTECTED") return result;
  if (!result.verdict.startsWith("PROTECTED")) return result;
  return {
    exit: result.exit,
    verdict: `PARTIAL — coverage is partial: ${capabilityCapText(capabilities)}; see the capability rows above.`,
  };
}

/** A Claude Code check is protected only behind a healthy LeakShield proxy. */
export function claudeCodeVerdict(
  checks: readonly DoctorCheck[],
  capabilities?: HostCapabilities,
): { exit: number; verdict: string } {
  return withCoverage(claudeCodeInstallVerdict(checks), capabilities);
}

function claudeCodeInstallVerdict(checks: readonly DoctorCheck[]): { exit: number; verdict: string } {
  if (checks.some((check) => check.state === "fail")) return { exit: 1, verdict: "BROKEN" };
  if (checks.every((check) => check.state === "skip")) {
    return { exit: 1, verdict: "NOT INSTALLED — claude is not on PATH" };
  }
  if (checks.some((check) => check.id === "claude-code-provider" || check.id === "claude-code-host-managed")) {
    return { exit: 1, verdict: "BYPASSED — a provider or host-managed setting skips the proxy" };
  }
  if (checks.some((check) => check.id === "claude-code-proxy" && check.state === "ok")) {
    return { exit: 0, verdict: "PROTECTED — Claude Code is behind the LeakShield proxy" };
  }
  return { exit: 1, verdict: "NOT PROTECTED — Claude Code is not behind the proxy" };
}

/** An installed pi extension protects the process; load order is a caveat. */
export function piVerdict(
  checks: readonly DoctorCheck[],
  capabilities?: HostCapabilities,
): { exit: number; verdict: string } {
  return withCoverage(piInstallVerdict(checks), capabilities);
}

function piInstallVerdict(checks: readonly DoctorCheck[]): { exit: number; verdict: string } {
  if (checks.every((check) => check.state === "skip")) {
    return { exit: 1, verdict: "NOT INSTALLED — pi is not on PATH" };
  }
  if (checks.some((check) => check.state === "fail")) return { exit: 1, verdict: "BROKEN" };
  const registered = checks.find((check) => check.id === "pi-extension-registered");
  if (registered?.state === "ok") {
    return { exit: 0, verdict: "PROTECTED — the extension guards pi's provider requests" };
  }
  if (registered?.state === "warn") {
    return { exit: 0, verdict: "PARTIAL — pi's own requests are guarded; an extension loaded before LeakShield can bypass" };
  }
  return { exit: 1, verdict: "NOT VERIFIED — the extension is not in settings.extensions; a `-e` run is invisible to the doctor" };
}

export async function runDoctorCommand(args: readonly string[]): Promise<number> {
  const target = parseDoctorTarget(args);
  if (typeof target === "object") {
    console.error(`leakshield: ${target.error}`);
    return 2;
  }
  if (target === "all") {
    const report = await runDoctor(createDoctorDeps());
    report.claudeCode = await runClaudeCodeDoctor(createClaudeCodeDoctorDeps());
    report.pi = await runPiDoctor(createPiDoctorDeps());
    report.capabilities = OPENCODE_CAPABILITIES;
    report.claudeCodeCapabilities = CLAUDE_CODE_CAPABILITIES;
    report.piCapabilities = PI_CAPABILITIES;
    console.log(formatDoctorReport(report));
    return doctorExitCode(report);
  }
  if (target === "opencode") {
    const report = await runDoctor(createDoctorDeps());
    report.capabilities = OPENCODE_CAPABILITIES;
    console.log(formatDoctorReport(report));
    return report.status === "PROTECTED" || report.status === "PARTIAL" ? 0 : 1;
  }
  if (target === "claude-code") {
    const checks = await runClaudeCodeDoctor(createClaudeCodeDoctorDeps());
    const { exit, verdict } = claudeCodeVerdict(checks, CLAUDE_CODE_CAPABILITIES);
    printSection("Claude Code", checks, verdict, CLAUDE_CODE_CAPABILITIES);
    return exit;
  }
  const checks = await runPiDoctor(createPiDoctorDeps());
  const { exit, verdict } = piVerdict(checks, PI_CAPABILITIES);
  printSection("pi", checks, verdict, PI_CAPABILITIES);
  return exit;
}
