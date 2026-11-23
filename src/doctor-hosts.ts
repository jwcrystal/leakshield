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
  doctorExitCode,
  formatDoctorReport,
  runDoctor,
  type DoctorCheck,
} from "./doctor.js";
import { createClaudeCodeDoctorDeps, runClaudeCodeDoctor } from "./claude-code/doctor.js";
import { createPiDoctorDeps, runPiDoctor } from "./pi/doctor.js";

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

function printSection(title: string, checks: readonly DoctorCheck[], verdict: string): void {
  const lines = [`leakshield doctor — ${title}`];
  for (const check of checks) {
    lines.push(`${ICON[check.state]} ${check.id}: ${check.detail}`);
    if (check.fix) lines.push(`       fix: ${check.fix}`);
  }
  lines.push("");
  lines.push(`Verdict: ${verdict}`);
  console.log(lines.join("\n"));
}

/** A Claude Code check is protected only behind a healthy LeakShield proxy. */
export function claudeCodeVerdict(checks: readonly DoctorCheck[]): { exit: number; verdict: string } {
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
export function piVerdict(checks: readonly DoctorCheck[]): { exit: number; verdict: string } {
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
    console.log(formatDoctorReport(report));
    return doctorExitCode(report);
  }
  if (target === "opencode") {
    const report = await runDoctor(createDoctorDeps());
    console.log(formatDoctorReport(report));
    return report.status === "PROTECTED" || report.status === "PARTIAL" ? 0 : 1;
  }
  if (target === "claude-code") {
    const checks = await runClaudeCodeDoctor(createClaudeCodeDoctorDeps());
    const { exit, verdict } = claudeCodeVerdict(checks);
    printSection("Claude Code", checks, verdict);
    return exit;
  }
  const checks = await runPiDoctor(createPiDoctorDeps());
  const { exit, verdict } = piVerdict(checks);
  printSection("pi", checks, verdict);
  return exit;
}
