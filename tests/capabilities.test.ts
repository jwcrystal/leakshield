// Component under test: src/types/capabilities.ts — the declaration contract
// every host fills in, and the invariants a declaration must satisfy.
import { describe, expect, it } from "vitest";
import {
  assertCapabilities,
  capabilityAt,
  capabilityVerdict,
  CapabilityInvariantError,
  CAPABILITY_ROWS,
  type Capability,
  type HostCapabilities,
} from "../src/types/capabilities.js";

const ok: Capability = { state: "protected", mechanism: "core.onHttpRequest", evidence: "tests/capabilities.test.ts" };

function declaration(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
  return {
    host: "synthetic",
    verifiedVersion: "1.0.0",
    interception: "in-process-host-hook",
    transports: {
      http: ok,
      websocket: { state: "not-present", mechanism: "no WS in the host", evidence: "tests/capabilities.test.ts" },
      nonFetch: { state: "unknown", mechanism: "unaudited", note: "Unaudited (#1)." },
    },
    surfaces: {
      toolArgs: ok,
      replyDisplay: ok,
      background: ok,
    },
    credentials: "in-process",
    persistence: "none",
    residuals: [],
    ...overrides,
  };
}

const audit = { fileExists: () => true };

function errorOf(capabilities: HostCapabilities): string {
  try {
    assertCapabilities(capabilities, audit);
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityInvariantError);
    return (error as Error).message;
  }
  throw new Error("expected the declaration to be rejected");
}

function withRow(row: (typeof CAPABILITY_ROWS)[number], capability: Capability): HostCapabilities {
  const base = declaration();
  const [section, field] = row.split(".") as ["transports" | "surfaces", string];
  const next = structuredClone(base) as Record<string, Record<string, Capability>>;
  next[section]![field] = capability;
  return next as unknown as HostCapabilities;
}

describe("capability declaration", () => {
  it("accepts a complete declaration", () => {
    expect(() => assertCapabilities(declaration(), audit)).not.toThrow();
  });

  it("reads every row by name", () => {
    const capabilities = declaration();
    expect(CAPABILITY_ROWS.map((row) => capabilityAt(capabilities, row))).toHaveLength(6);
  });

  it("caps the verdict at PARTIAL for an unknown row", () => {
    const verdict = capabilityVerdict(declaration());
    expect(verdict.verdict).toBe("PARTIAL");
    expect(verdict.unknown).toEqual(["transports.nonFetch"]);
  });

  it("reports PROTECTED when every row is covered", () => {
    const capabilities = declaration();
    capabilities.transports.nonFetch = { state: "refused", mechanism: "unsupported API", evidence: "tests/pi-guard.test.ts" };
    expect(capabilityVerdict(capabilities)).toEqual({ verdict: "PROTECTED", unknown: [], outside: [] });
  });

  it("rejects a protected row without evidence", () => {
    const capabilities = withRow("transports.http", { state: "protected", mechanism: "core.onHttpRequest" });
    expect(errorOf(capabilities)).toContain("transports.http is protected without an evidence path");
  });

  it("rejects evidence that does not exist", () => {
    const capabilities = withRow("transports.http", {
      state: "protected",
      mechanism: "core.onHttpRequest",
      evidence: "tests/does-not-exist.test.ts",
    });
    const missing = (filePath: string) => filePath !== "tests/does-not-exist.test.ts";
    expect(() => assertCapabilities(capabilities, { fileExists: missing })).toThrow(
      /transports\.http evidence does not exist/,
    );
  });

  it("rejects a not-present row without probe evidence", () => {
    const capabilities = withRow("transports.websocket", { state: "not-present", mechanism: "no WS in the host" });
    expect(errorOf(capabilities)).toContain("transports.websocket is not-present without an evidence path");
  });

  it("rejects a refused row with no runtime test or e2e record", () => {
    const capabilities = withRow("transports.nonFetch", { state: "refused", mechanism: "unsupported API" });
    expect(errorOf(capabilities)).toContain("refused without a runtime test or evidence");
  });

  it("rejects refused evidence that is only prose", () => {
    const capabilities = withRow("transports.nonFetch", {
      state: "refused",
      mechanism: "unsupported API",
      evidence: "README.md",
    });
    expect(errorOf(capabilities)).toContain("is not a runtime test or an e2e record");
  });

  it("requires an outside row to explain itself in residuals", () => {
    const capabilities = withRow("transports.nonFetch", {
      state: "outside",
      mechanism: "none",
      note: "the host has no hook",
    });
    expect(errorOf(capabilities)).toContain("has no matching entry in residuals");
  });

  it("requires an outside row to carry a note", () => {
    const capabilities = withRow("transports.nonFetch", { state: "outside", mechanism: "none" });
    capabilities.residuals = ["transports.nonFetch: the host has no hook"];
    expect(errorOf(capabilities)).toContain("is outside without a note");
  });

  it("accepts an outside row with a note and a matching residual", () => {
    const capabilities = withRow("transports.nonFetch", {
      state: "outside",
      mechanism: "none",
      note: "the host has no hook",
    });
    capabilities.residuals = ["transports.nonFetch: the host has no hook"];
    expect(() => assertCapabilities(capabilities, audit)).not.toThrow();
  });

  it("rejects an unknown row without a tracking issue", () => {
    const capabilities = withRow("transports.nonFetch", { state: "unknown", mechanism: "unaudited" });
    expect(errorOf(capabilities)).toContain("unknown without a tracking issue");
  });

  it("requires credentials and persistence to be declared", () => {
    expect(errorOf({ ...declaration(), credentials: undefined as never })).toContain("credentials must be declared");
    expect(errorOf({ ...declaration(), persistence: undefined as never })).toContain("persistence must be declared");
  });

  it("rejects an unknown state word", () => {
    const capabilities = withRow("surfaces.replyDisplay", {
      state: "covered" as never,
      mechanism: "core.onHttpResponse",
    });
    expect(errorOf(capabilities)).toContain("unknown state covered");
  });
});
