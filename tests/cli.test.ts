import { describe, it, expect } from "vitest";
import { filterBySeverity, validateCliScanPath, formatCliDecision } from "../src/transports/cli.js";
import type { ScanResult } from "../src/types.js";
import type { GuardDecisionResult } from "../src/decision/model.js";

// 建立假的 ScanResult，包含三種嚴重度的 findings
function makeMockResult(): ScanResult {
  return {
    safe: false,
    total_findings: 3,
    findings: [
      { type: "API_KEY",    severity: "HIGH",   preview: "sk-a****de", description: "OpenAI API Key" },
      { type: "PII_EMAIL",  severity: "MEDIUM", preview: "user****om", description: "Email 地址" },
      { type: "PII_PHONE_INTL", severity: "LOW", preview: "+123****67", description: "國際電話號碼" },
    ],
    summary: "🚨 發現 3 個潛在敏感項目",
    recommendation: "⛔ 建議先處理",
  };
}

// ─── validateCliScanPath() ─────────────────────────────────────────────────────

describe("validateCliScanPath()", () => {
  it("accepts a path inside the workspace", () => {
    const result = validateCliScanPath("/repo", "/repo/src/index.ts", false);
    expect(result).toBe("/repo/src/index.ts");
  });

  it("rejects a path outside the workspace by default", () => {
    expect(() => validateCliScanPath("/repo", "/etc/passwd", false)).toThrow(
      /outside allowed workspace/
    );
  });

  it("accepts an outside path when allowOutside=true", () => {
    const result = validateCliScanPath("/repo", "/etc/passwd", true);
    expect(result).toBe("/etc/passwd");
  });

  it("resolves relative paths against baseDir", () => {
    const result = validateCliScanPath("/repo", "src/index.ts", false);
    expect(result).toBe("/repo/src/index.ts");
  });

  it("rejects .. traversal by default", () => {
    expect(() => validateCliScanPath("/repo", "../secret", false)).toThrow(
      /outside allowed workspace/
    );
  });
});

describe("formatCliDecision()", () => {
  it("shows a reminder for WARN and continues", () => {
    const result: GuardDecisionResult = {
      decision: "WARN",
      riskLevel: "LOW",
      summary: "warn",
      findings: [],
      recommendedAction: "CONTINUE",
    };
    const view = formatCliDecision({ label: "(stdin)", result });
    expect(view).toContain("WARN");
    expect(view.toLowerCase()).toContain("continue");
  });

  it("shows explicit confirm actions for CONFIRM / HIGH", () => {
    const result: GuardDecisionResult = {
      decision: "CONFIRM",
      riskLevel: "HIGH",
      summary: "unsafe",
      findings: [{ type: "API_KEY", severity: "HIGH", preview: "sk-****ab" }],
      recommendedAction: "CANCEL",
    };
    const view = formatCliDecision({ label: "secret.env", result });
    expect(view.toLowerCase()).toContain("send redacted");
    expect(view.toLowerCase()).toContain("send original anyway");
  });

  it("includes target label in output", () => {
    const result: GuardDecisionResult = {
      decision: "WARN",
      riskLevel: "LOW",
      summary: "warn",
      findings: [],
      recommendedAction: "CONTINUE",
    };
    const view = formatCliDecision({ label: "myfile.ts", result });
    expect(view).toContain("myfile.ts");
  });

  it("shows ALLOW as safe/clean", () => {
    const result: GuardDecisionResult = {
      decision: "ALLOW",
      riskLevel: "LOW",
      summary: "✅ No sensitive content detected, safe to send.",
      findings: [],
      recommendedAction: "CONTINUE",
    };
    const view = formatCliDecision({ label: "safe.ts", result });
    expect(view).toContain("ALLOW");
  });

  it("includes finding type for CONFIRM", () => {
    const result: GuardDecisionResult = {
      decision: "CONFIRM",
      riskLevel: "MEDIUM",
      summary: "unsafe",
      findings: [{ type: "PII_EMAIL", severity: "MEDIUM", preview: "****" }],
      recommendedAction: "SEND_REDACTED",
    };
    const view = formatCliDecision({ label: "data.csv", result });
    expect(view).toContain("PII_EMAIL");
  });
});

describe("filterBySeverity()", () => {
  it("min=low 時保留全部 findings", () => {
    const result = filterBySeverity(makeMockResult(), "low");
    expect(result.total_findings).toBe(3);
    expect(result.findings.map((f) => f.severity)).toEqual(["HIGH", "MEDIUM", "LOW"]);
  });

  it("min=medium 時過濾掉 LOW", () => {
    const result = filterBySeverity(makeMockResult(), "medium");
    expect(result.total_findings).toBe(2);
    expect(result.findings.every((f) => f.severity !== "LOW")).toBe(true);
  });

  it("min=high 時只保留 HIGH", () => {
    const result = filterBySeverity(makeMockResult(), "high");
    expect(result.total_findings).toBe(1);
    expect(result.findings[0].severity).toBe("HIGH");
  });

  it("過濾後全部移除時 safe 應為 true", () => {
    const onlyLow: ScanResult = {
      safe: false,
      total_findings: 1,
      findings: [{ type: "PII_PHONE_INTL", severity: "LOW", preview: "+123****67", description: "國際電話號碼" }],
      summary: "🚨",
      recommendation: "⛔",
    };
    const result = filterBySeverity(onlyLow, "high");
    expect(result.safe).toBe(true);
    expect(result.total_findings).toBe(0);
  });

  it("過濾後 total_findings 應與 findings.length 一致", () => {
    const result = filterBySeverity(makeMockResult(), "medium");
    expect(result.total_findings).toBe(result.findings.length);
  });

  it("safe=true 的結果過濾後仍為 safe", () => {
    const safe: ScanResult = {
      safe: true, total_findings: 0, findings: [],
      summary: "✅", recommendation: "安全",
    };
    expect(filterBySeverity(safe, "high").safe).toBe(true);
  });
});
