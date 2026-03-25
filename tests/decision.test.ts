import { describe, expect, it } from "vitest";
import { toDecisionResult } from "../src/decision/model.js";
import type { ScanResult } from "../src/types.js";

describe("toDecisionResult", () => {
  it("maps safe scan results to ALLOW / CONTINUE", () => {
    const scan: ScanResult = {
      safe: true,
      total_findings: 0,
      findings: [],
      summary: "✅",
      recommendation: "safe",
    };
    const result = toDecisionResult(scan, "safe content");
    expect(result.decision).toBe("ALLOW");
    expect(result.riskLevel).toBe("LOW");
    expect(result.recommendedAction).toBe("CONTINUE");
  });

  it("maps low-only findings to WARN", () => {
    const scan: ScanResult = {
      safe: false,
      total_findings: 1,
      findings: [{ type: "PII_PHONE_INTL", severity: "LOW", preview: "+123****67", description: "phone" }],
      summary: "warn",
      recommendation: "check",
    };
    expect(toDecisionResult(scan, "+1234567").decision).toBe("WARN");
  });

  it("maps medium/high findings to CONFIRM with the right recommendation", () => {
    const scan: ScanResult = {
      safe: false,
      total_findings: 1,
      findings: [{ type: "API_KEY", severity: "HIGH", preview: "sk-****ab", description: "key" }],
      summary: "unsafe",
      recommendation: "remove",
    };
    const result = toDecisionResult(scan, "sk-secret-value");
    expect(result.decision).toBe("CONFIRM");
    expect(result.riskLevel).toBe("HIGH");
    expect(result.recommendedAction).toBe("CANCEL");
  });

  it("maps medium-only findings to CONFIRM / SEND_REDACTED", () => {
    const scan: ScanResult = {
      safe: false,
      total_findings: 1,
      findings: [{ type: "PII_EMAIL", severity: "MEDIUM", preview: "****", description: "email" }],
      summary: "warn",
      recommendation: "check",
    };
    const result = toDecisionResult(scan, "user@example.com");
    expect(result.decision).toBe("CONFIRM");
    expect(result.riskLevel).toBe("MEDIUM");
    expect(result.recommendedAction).toBe("SEND_REDACTED");
  });

  it("WARN result has CONTINUE as recommendedAction", () => {
    const scan: ScanResult = {
      safe: false,
      total_findings: 1,
      findings: [{ type: "PII_PHONE_INTL", severity: "LOW", preview: "****", description: "phone" }],
      summary: "warn",
      recommendation: "check",
    };
    const result = toDecisionResult(scan, "+1234567");
    expect(result.recommendedAction).toBe("CONTINUE");
  });

  it("passes through findings with type/severity/preview/line", () => {
    const scan: ScanResult = {
      safe: false,
      total_findings: 1,
      findings: [{ type: "API_KEY", severity: "HIGH", preview: "sk-****ab", description: "key", line: 3 }],
      summary: "unsafe",
      recommendation: "remove",
    };
    const result = toDecisionResult(scan, "content");
    expect(result.findings[0].type).toBe("API_KEY");
    expect(result.findings[0].line).toBe(3);
    expect(result.findings[0].preview).toBe("sk-****ab");
  });
});
