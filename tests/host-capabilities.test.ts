// Component under test: the three host declarations and the doctor output they
// produce. The doctor must print exactly what the adapter declares.
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_CAPABILITIES } from "../src/adapters/claude-code/capabilities.js";
import { capabilitySection, capabilityLines } from "../src/doctor-capabilities.js";
import { claudeCodeVerdict, piVerdict } from "../src/doctor-hosts.js";
import { formatDoctorReport, type DoctorReport } from "../src/doctor-report.js";
import { OPENCODE_CAPABILITIES } from "../src/adapters/opencode/capabilities.js";
import { PI_CAPABILITIES } from "../src/adapters/pi/capabilities.js";
import {
  assertCapabilities,
  capabilityAt,
  capabilityVerdict,
  CAPABILITY_ROWS,
  CAPABILITY_ROW_TITLES,
  type HostCapabilities,
} from "../src/types/capabilities.js";

const HOSTS: readonly HostCapabilities[] = [OPENCODE_CAPABILITIES, CLAUDE_CODE_CAPABILITIES, PI_CAPABILITIES];

function capabilityReport(capabilities: HostCapabilities): DoctorReport {
  return {
    status: "PROTECTED",
    hostVersion: capabilities.verifiedVersion,
    hostGeneration: "v2",
    configPath: null,
    checks: [],
    capabilities,
  };
}

function printCapabilityRows(text: string): string[] {
  return text.split("\n").filter((line) => /^\[(?:OK|WARN)\]\s+cap\./.test(line));
}

describe("host declarations", () => {
  it.each(HOSTS.map((capabilities) => [capabilities.host, capabilities] as const))(
    "%s satisfies every invariant with evidence on disk",
    (_host, capabilities) => {
      expect(() => assertCapabilities(capabilities)).not.toThrow();
    },
  );

  it("declares exactly one row per matrix entry", () => {
    for (const capabilities of HOSTS) {
      expect(capabilityLines(capabilities).map((line) => line.id)).toEqual(
        CAPABILITY_ROWS.map((row) => `cap.${row.split(".")[1]}`),
      );
    }
  });

  it("names a mechanism for every row", () => {
    for (const capabilities of HOSTS) {
      for (const row of CAPABILITY_ROWS) {
        expect(capabilityAt(capabilities, row).mechanism.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("doctor capability output", () => {
  it("prints one row per declaration, with the declared state", () => {
    for (const capabilities of HOSTS) {
      const rows = printCapabilityRows(formatDoctorReport(capabilityReport(capabilities)));
      expect(rows).toHaveLength(CAPABILITY_ROWS.length);
      for (const row of CAPABILITY_ROWS) {
        const state = capabilityAt(capabilities, row).state;
        const label = state === "unknown" ? "UNKNOWN" : state;
        const line = rows.find((entry) => entry.includes(`cap.${row.split(".")[1]}:`));
        expect(line, `${capabilities.host} ${row}`).toBeDefined();
        expect(line).toContain(label);
      }
    }
  });

  it("shows the row title so a reader can map it to the matrix", () => {
    const section = capabilitySection(OPENCODE_CAPABILITIES).join("\n");
    for (const row of CAPABILITY_ROWS) expect(section).toContain(`cap.${row.split(".")[1]}`);
    expect(CAPABILITY_ROW_TITLES["transports.nonFetch"]).toBe("non-fetch");
  });

  it("prints the residual note of an outside row", () => {
    const section = capabilitySection(CLAUDE_CODE_CAPABILITIES).join("\n");
    expect(section).toContain("Bedrock, Vertex and Foundry");
  });

  it("never prints PROTECTED coverage when a row is unknown or outside", () => {
    for (const capabilities of HOSTS) {
      const verdict = capabilityVerdict(capabilities);
      const section = capabilitySection(capabilities).join("\n");
      if (verdict.verdict === "PROTECTED") {
        expect(section).toContain("Coverage: PROTECTED");
        expect(verdict.unknown).toHaveLength(0);
        expect(verdict.outside).toHaveLength(0);
      } else {
        expect(section).toContain("Coverage: PARTIAL");
        expect(section).not.toContain("Coverage: PROTECTED");
      }
    }
  });

  it("caps a passing OpenCode install at PARTIAL while a row is unknown", () => {
    const text = formatDoctorReport(capabilityReport(OPENCODE_CAPABILITIES));
    expect(text).toContain("PARTIAL — install-level checks pass, but");
    expect(text).toContain("transports.nonFetch unknown");
    expect(text).not.toContain("PROTECTED — install-level checks pass.");
  });

  it("keeps a PROTECTED verdict when a host declares full coverage", () => {
    const full: HostCapabilities = PI_CAPABILITIES;
    expect(capabilityVerdict(full).verdict).toBe("PROTECTED");
    const text = formatDoctorReport({ ...capabilityReport(full), status: "PARTIAL" });
    expect(text).toContain("PARTIAL — hook-first protection");
    expect(text).toContain("Coverage: PROTECTED");
  });

  it("cap: line count equals the declaration, so the two cannot drift apart", () => {
    for (const capabilities of HOSTS) {
      const rows = printCapabilityRows(formatDoctorReport(capabilityReport(capabilities)));
      const declared = CAPABILITY_ROWS.filter((row) => capabilityAt(capabilities, row) !== undefined);
      expect(rows.length).toBe(declared.length);
    }
  });
});

describe("host verdicts respect the declaration", () => {
  const passing = [{ id: "claude-code-proxy", state: "ok" as const, detail: "proxy answers" }];

  it("lowers a passing Claude Code install that has unknown rows", () => {
    expect(claudeCodeVerdict(passing).verdict).toContain("PROTECTED");
    expect(claudeCodeVerdict(passing, CLAUDE_CODE_CAPABILITIES).verdict).toContain("PARTIAL");
  });

  it("does not turn a failing install into a pass", () => {
    const failed = [{ id: "claude-code", state: "skip" as const, detail: "claude not on PATH" }];
    expect(claudeCodeVerdict(failed, CLAUDE_CODE_CAPABILITIES).verdict).not.toContain("PROTECTED");
  });

  it("keeps pi's own PARTIAL reason instead of replacing it", () => {
    const registered = [{ id: "pi-extension-registered", state: "warn" as const, detail: "an extension loads first" }];
    expect(piVerdict(registered, PI_CAPABILITIES).verdict).toContain("PARTIAL");
  });
});
