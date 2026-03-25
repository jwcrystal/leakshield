import { describe, it, expect } from "vitest";
import { toDecisionResult } from "../src/decision/model.js";
import type { ScanResult, Finding } from "../src/types.js";
import type { GuardDecisionResult } from "../src/decision/model.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeScan(): ScanResult {
  return {
    safe: true,
    total_findings: 0,
    findings: [],
    summary: "✅ No sensitive content detected.",
    recommendation: "Content is safe to send.",
  };
}

function scanWith(findings: Finding[]): ScanResult {
  return {
    safe: findings.length === 0,
    total_findings: findings.length,
    findings,
    summary:
      findings.length > 0
        ? `🚨 ${findings.length} sensitive items found.`
        : "✅ No sensitive content detected.",
    recommendation:
      findings.length > 0
        ? "Review before sending."
        : "Content is safe to send.",
  };
}

const HIGH: Finding = {
  type: "API_KEY",
  severity: "HIGH",
  line: 1,
  column: 1,
  preview: "****",
  description: "OpenAI API Key",
};

const MEDIUM: Finding = {
  type: "PII_EMAIL",
  severity: "MEDIUM",
  line: 2,
  column: 1,
  preview: "****",
  description: "Email address",
};

const LOW: Finding = {
  type: "PRIVATE_DOMAIN",
  severity: "LOW",
  line: 3,
  column: 1,
  preview: "****",
  description: "Private domain reference",
};

// ─── Safe scan → ALLOW ─────────────────────────────────────────────────────

describe("toDecisionResult() — safe scan", () => {
  it("returns ALLOW for a clean scan (no findings)", () => {
    const result = toDecisionResult(safeScan(), "hello world");
    expect(result.decision).toBe("ALLOW");
    expect(result.riskLevel).toBe("LOW");
  });

  it("maps findings to GuardDecisionFinding[] (empty for safe)", () => {
    const result = toDecisionResult(safeScan(), "hello world");
    expect(result.findings).toEqual([]);
  });
});

// ─── Low-only findings → WARN ──────────────────────────────────────────────

describe("toDecisionResult() — low-only findings", () => {
  it("returns WARN when only LOW severity findings exist", () => {
    const result = toDecisionResult(scanWith([LOW]), "some text");
    expect(result.decision).toBe("WARN");
    expect(result.riskLevel).toBe("MEDIUM");
  });

  it("includes the LOW findings in the result", () => {
    const result = toDecisionResult(scanWith([LOW, LOW]), "some text");
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0].severity).toBe("LOW");
  });
});

// ─── Medium / High findings → CONFIRM ──────────────────────────────────────

describe("toDecisionResult() — medium findings", () => {
  it("returns CONFIRM with recommendedAction=REVIEW when MEDIUM findings exist", () => {
    const result = toDecisionResult(scanWith([MEDIUM]), "some text");
    expect(result.decision).toBe("CONFIRM");
    expect(result.riskLevel).toBe("HIGH");
    expect(result.recommendedAction).toBe("REVIEW");
  });
});

describe("toDecisionResult() — high findings", () => {
  it("returns CONFIRM with recommendedAction=BLOCK when HIGH findings exist", () => {
    const result = toDecisionResult(scanWith([HIGH]), "some text");
    expect(result.decision).toBe("CONFIRM");
    expect(result.riskLevel).toBe("CRITICAL");
    expect(result.recommendedAction).toBe("BLOCK");
  });
});

describe("toDecisionResult() — mixed findings", () => {
  it("returns CONFIRM with recommendedAction=BLOCK when both HIGH and LOW exist", () => {
    const result = toDecisionResult(scanWith([LOW, HIGH]), "mixed text");
    expect(result.decision).toBe("CONFIRM");
    expect(result.recommendedAction).toBe("BLOCK");
  });

  it("returns CONFIRM with recommendedAction=BLOCK when both MEDIUM and HIGH exist", () => {
    const result = toDecisionResult(
      scanWith([MEDIUM, HIGH]),
      "mixed text"
    );
    expect(result.decision).toBe("CONFIRM");
    expect(result.recommendedAction).toBe("BLOCK");
  });
});

// ─── GuardDecisionResult shape ─────────────────────────────────────────────

describe("toDecisionResult() — result shape", () => {
  it("returns an object with all expected fields", () => {
    const result = toDecisionResult(safeScan(), "hello");
    // Core fields always present
    expect(result).toHaveProperty("decision");
    expect(result).toHaveProperty("riskLevel");
    expect(result).toHaveProperty("findings");
    expect(result).toHaveProperty("originalContent");
    // Optional fields — type-level check via the import of GuardDecisionResult
    const _typeCheck: GuardDecisionResult = result;
    void _typeCheck;
  });

  it("originalContent is passed through unchanged", () => {
    const content = "my secret text";
    const result = toDecisionResult(safeScan(), content);
    expect(result.originalContent).toBe(content);
  });

  it("safePreview and redactedContent are undefined when scan is safe (stub behaviour)", () => {
    const result = toDecisionResult(safeScan(), "hello");
    expect(result.safePreview).toBeUndefined();
    expect(result.redactedContent).toBeUndefined();
  });
});
