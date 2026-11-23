/**
 * Doctor report shape and rendering, shared by every host adapter.
 *
 * OpenCode's status still decides an aggregate run; the Claude Code and pi
 * section checks are reported next to it and only decide a run when OpenCode
 * is absent (see `doctorExitCode`).
 */

import { capabilityCapText, capabilitySection } from "./doctor-capabilities.js";
import type { HostCapabilities } from "./types/capabilities.js";

export type DoctorStatus = "PROTECTED" | "PARTIAL" | "BROKEN" | "NOT_REGISTERED" | "HOST_MISSING";

export interface DoctorCheck {
  id: string;
  state: "ok" | "warn" | "fail" | "skip";
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  status: DoctorStatus;
  hostVersion: string | null;
  hostGeneration: "v1" | "v2" | null;
  configPath: string | null;
  checks: DoctorCheck[];
  /** Copy-paste registration snippet for the OpenCode v2 config. */
  snippet?: string;
  /** Claude Code proxy checks; reported separately from the OpenCode status. */
  claudeCode?: DoctorCheck[];
  /** pi adapter checks; reported separately from the OpenCode status. */
  pi?: DoctorCheck[];
  /** OpenCode's declared coverage, printed under the checks. */
  capabilities?: HostCapabilities;
  /** Claude Code's declared coverage, printed with its checks. */
  claudeCodeCapabilities?: HostCapabilities;
  /** pi's declared coverage, printed with its checks. */
  piCapabilities?: HostCapabilities;
}

export function formatDoctorReport(report: DoctorReport): string {
  const icon = { ok: "[OK]  ", warn: "[WARN]", fail: "[FAIL]", skip: "[SKIP]" } as const;
  const lines: string[] = [];
  lines.push(`leakshield doctor — ${new Date().toISOString()}`);
  for (const check of report.checks) {
    lines.push(`${icon[check.state]} ${check.id}: ${check.detail}`);
    if (check.fix) lines.push(`       fix: ${check.fix}`);
  }
  if (report.snippet) {
    lines.push("");
    lines.push("Registration snippet for your opencode.json:");
    lines.push(report.snippet);
  }
  const capText = report.capabilities ? capabilityCapText(report.capabilities) : null;
  if (report.capabilities) {
    lines.push("");
    lines.push(...capabilitySection(report.capabilities));
  }
  lines.push("");
  const verdict =
    report.status === "PROTECTED"
      ? capText === null
        ? "PROTECTED — install-level checks pass."
        : `PARTIAL — install-level checks pass, but ${capText}; see Host capabilities above.`
      : report.status === "PARTIAL"
        ? "PARTIAL — hook-first protection; final outbound HTTP bodies are not inspected."
        : report.status === "BROKEN"
          ? "BROKEN — registered but would not protect; fix the [FAIL] items above."
          : report.status === "NOT_REGISTERED"
            ? "NOT REGISTERED — LeakShield is not in the OpenCode config; sessions are unprotected."
            : "HOST MISSING — no OpenCode binary found.";
  lines.push(verdict);
  if (report.claudeCode && report.claudeCode.length > 0) {
    lines.push("");
    lines.push("Claude Code:");
    for (const check of report.claudeCode) {
      lines.push(`${icon[check.state]} ${check.id}: ${check.detail}`);
      if (check.fix) lines.push(`       fix: ${check.fix}`);
    }
    if (report.claudeCodeCapabilities) {
      lines.push("");
      lines.push(...capabilitySection(report.claudeCodeCapabilities));
    }
  }
  if (report.pi && report.pi.length > 0) {
    lines.push("");
    lines.push("pi:");
    for (const check of report.pi) {
      lines.push(`${icon[check.state]} ${check.id}: ${check.detail}`);
      if (check.fix) lines.push(`       fix: ${check.fix}`);
    }
    if (report.piCapabilities) {
      lines.push("");
      lines.push(...capabilitySection(report.piCapabilities));
    }
  }
  lines.push("");
  lines.push("Scope: model-conversation leak protection. This is NOT a tool-egress firewall: permitted local tools (curl, remote MCP, …) can still transmit originals. See README.");
  return lines.join("\n");
}

/**
 * The OpenCode status decides as before. Only when OpenCode is absent
 * (HOST_MISSING) can Claude Code or an installed pi extension make the run
 * pass, unless a provider or host setting bypasses it; a failed Claude Code
 * check still fails it. A pi failure only decides the run when OpenCode is
 * absent, so a broken ~/.pi never fails a protected OpenCode run.
 */
export function doctorExitCode(report: DoctorReport): number {
  const claudeCode = report.claudeCode ?? [];
  const pi = report.pi ?? [];
  if (claudeCode.some((check) => check.state === "fail")) return 1;
  // pi checks are supplementary: a broken ~/.pi must not fail an otherwise
  // protected OpenCode run. They decide the run only when OpenCode is absent.
  if (pi.some((check) => check.state === "fail") && report.status === "HOST_MISSING") return 1;
  if (report.status === "PROTECTED" || report.status === "PARTIAL") return 0;
  if (report.status !== "HOST_MISSING") return 1;
  // A bypassing provider or host-managed endpoint means requests may not reach
  // the proxy even though it answers at the configured base URL.
  const bypassed = claudeCode.some((check) => check.id === "claude-code-provider" || check.id === "claude-code-host-managed");
  if (bypassed) return 1;
  const claudeCodeProtected = claudeCode.some((check) => check.id === "claude-code-proxy" && check.state === "ok");
  const piProtected = pi.some((check) =>
    check.id === "pi-extension-registered" && (check.state === "ok" || check.state === "warn"))
    && !pi.some((check) => check.state === "fail");
  return claudeCodeProtected || piProtected ? 0 : 1;
}
