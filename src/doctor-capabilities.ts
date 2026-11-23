/**
 * Renders a host's capability declaration for `leakshield --doctor`.
 *
 * The declaration is the only input: the doctor cannot print a row the adapter
 * does not declare, and a test compares this output with the constant. `outside`
 * and `unknown` rows are warnings because the host verdict is capped at PARTIAL
 * by them.
 */
import {
  CAPABILITY_ROWS,
  capabilityAt,
  capabilityVerdict,
  type CapabilityState,
  type HostCapabilities,
} from "./types/capabilities.js";

export interface CapabilityLine {
  /** e.g. `cap.nonFetch` */
  id: string;
  state: "ok" | "warn";
  detail: string;
  note?: string;
}

const WARN_STATES: ReadonlySet<CapabilityState> = new Set(["outside", "unknown"]);

function shortRow(row: string): string {
  return row.split(".")[1] ?? row;
}

export function capabilityLines(capabilities: HostCapabilities): CapabilityLine[] {
  return CAPABILITY_ROWS.map((row) => {
    const capability = capabilityAt(capabilities, row);
    return {
      id: `cap.${shortRow(row)}`,
      state: WARN_STATES.has(capability.state) ? "warn" : "ok",
      detail: `${capability.state === "unknown" ? "UNKNOWN" : capability.state} — ${capability.mechanism}`,
      note: capability.note,
    };
  });
}

export function capabilityHeader(capabilities: HostCapabilities): string {
  return `Host capabilities — ${capabilities.host} (verified ${capabilities.verifiedVersion}, ${capabilities.interception})`;
}

export function capabilitySection(capabilities: HostCapabilities): string[] {
  const icon = { ok: "[OK]  ", warn: "[WARN]" } as const;
  const lines = [capabilityHeader(capabilities)];
  for (const line of capabilityLines(capabilities)) {
    lines.push(`${icon[line.state]} ${line.id}: ${line.detail}`);
    if (line.note !== undefined) lines.push(`       note: ${line.note}`);
  }
  const coverage = capabilityVerdict(capabilities);
  const reasons = [...coverage.unknown.map((row) => `${row} unknown`), ...coverage.outside.map((row) => `${row} outside`)];
  lines.push(
    coverage.verdict === "PROTECTED"
      ? "Coverage: PROTECTED — every declared row is covered."
      : `Coverage: PARTIAL — ${reasons.join("; ")}.`,
  );
  return lines;
}

/** One sentence for the host verdict line, or null when coverage is full. */
export function capabilityCapText(capabilities: HostCapabilities): string | null {
  const coverage = capabilityVerdict(capabilities);
  if (coverage.verdict === "PROTECTED") return null;
  const rows = [...coverage.unknown, ...coverage.outside];
  return `${rows.length} declared row${rows.length === 1 ? "" : "s"} unknown or outside (${rows.join(", ")})`;
}
