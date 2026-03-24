import { describe, it, expect } from "vitest";
import { filterBySeverity } from "../src/transports/cli.js";
import type { ScanResult } from "../src/types.js";

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
