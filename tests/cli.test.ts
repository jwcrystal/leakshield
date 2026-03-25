import { describe, it, expect } from "vitest";
import {
  filterBySeverity,
  validateCliScanPath,
  formatCliDecision,
  buildDecisionJsonOutput,
} from "../src/transports/cli.js";
import type { ScanResult } from "../src/types.js";
import type { GuardDecisionResult } from "../src/decision/model.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function makeDecision(decision: GuardDecisionResult["decision"], overrides?: Partial<GuardDecisionResult>): GuardDecisionResult {
  const base: GuardDecisionResult = {
    decision,
    riskLevel: decision === "ALLOW" ? "LOW" : decision === "WARN" ? "MEDIUM" : "HIGH",
    findings: [
      { type: "API_KEY", severity: "HIGH", preview: "sk-a****de", description: "OpenAI API Key" },
    ],
    originalContent: "some secret content here",
    ...overrides,
  };
  return base;
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

// ─── formatCliDecision() ─────────────────────────────────────────────────────

describe("formatCliDecision()", () => {
  it("returns lines (array of strings) for ALLOW decision", () => {
    const decision = makeDecision("ALLOW", {
      findings: [],
      riskLevel: "LOW",
    });
    const lines = formatCliDecision(decision, "(inline text)");
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    // ALLOW output should contain the scan target label
    const joined = lines.join("\n");
    expect(joined).toContain("(inline text)");
    // ALLOW should not contain confirm actions
    expect(joined).not.toContain("cancel");
    expect(joined).not.toContain("send redacted");
    expect(joined).not.toContain("send original anyway");
  });

  it("returns lines containing reminder for WARN decision", () => {
    const decision = makeDecision("WARN", {
      riskLevel: "MEDIUM",
      findings: [
        { type: "PRIVATE_DOMAIN", severity: "LOW", preview: "****", description: "Private domain" },
      ],
    });
    const lines = formatCliDecision(decision, "my-file.ts");
    expect(Array.isArray(lines)).toBe(true);
    const joined = lines.join("\n");
    expect(joined).toContain("my-file.ts");
    // WARN should show a reminder, not confirm actions
    expect(joined).not.toContain("cancel");
    expect(joined).not.toContain("send redacted");
  });

  it("returns lines with confirm card for CONFIRM decision", () => {
    const decision = makeDecision("CONFIRM", {
      riskLevel: "CRITICAL",
      recommendedAction: "BLOCK",
      findings: [
        { type: "API_KEY", severity: "HIGH", preview: "sk-a****de", description: "OpenAI API Key" },
      ],
    });
    const lines = formatCliDecision(decision, "config.ts");
    expect(Array.isArray(lines)).toBe(true);
    const joined = lines.join("\n");
    expect(joined).toContain("config.ts");
    // CONFIRM must present the three action options
    expect(joined).toContain("cancel");
    expect(joined).toContain("send redacted");
    expect(joined).toContain("send original anyway");
  });

  it("CONFIRM with REVIEW action includes the action label", () => {
    const decision = makeDecision("CONFIRM", {
      riskLevel: "HIGH",
      recommendedAction: "REVIEW",
      findings: [
        { type: "PII_EMAIL", severity: "MEDIUM", preview: "****", description: "Email" },
      ],
    });
    const lines = formatCliDecision(decision, "data.csv");
    const joined = lines.join("\n");
    expect(joined).toContain("REVIEW");
  });

  it("CONFIRM with BLOCK action includes the action label", () => {
    const decision = makeDecision("CONFIRM", {
      riskLevel: "CRITICAL",
      recommendedAction: "BLOCK",
      findings: [
        { type: "API_KEY", severity: "HIGH", preview: "****", description: "API Key" },
      ],
    });
    const lines = formatCliDecision(decision, "config.ts");
    const joined = lines.join("\n");
    expect(joined).toContain("BLOCK");
  });

  it("includes finding descriptions in output when findings exist", () => {
    const decision = makeDecision("WARN", {
      riskLevel: "MEDIUM",
      findings: [
        { type: "PRIVATE_DOMAIN", severity: "LOW", preview: "****", description: "Private domain reference" },
      ],
    });
    const lines = formatCliDecision(decision, "doc.md");
    const joined = lines.join("\n");
    expect(joined).toContain("Private domain reference");
  });

  it("does not include originalContent in any output lines", () => {
    const decision = makeDecision("CONFIRM", {
      originalContent: "sk-proj-12345-secret-key-value",
    });
    const lines = formatCliDecision(decision, "secret.env");
    const joined = lines.join("\n");
    expect(joined).not.toContain("sk-proj-12345-secret-key-value");
  });
});

// ─── buildDecisionJsonOutput() ───────────────────────────────────────────────

describe("buildDecisionJsonOutput()", () => {
  it("returns a JSON-stringifiable object with decision-oriented fields", () => {
    const decision = makeDecision("ALLOW", { findings: [], riskLevel: "LOW" });
    const obj = buildDecisionJsonOutput(decision, "(inline text)");
    const parsed = JSON.parse(JSON.stringify(obj));
    expect(parsed.label).toBe("(inline text)");
    expect(parsed.decision).toBe("ALLOW");
    expect(parsed.riskLevel).toBe("LOW");
    expect(parsed.findings).toEqual([]);
  });

  it("never includes originalContent in JSON output", () => {
    const decision = makeDecision("CONFIRM", {
      originalContent: "super-secret-password-12345",
    });
    const obj = buildDecisionJsonOutput(decision, "config.ts");
    const json = JSON.stringify(obj);
    expect(json).not.toContain("super-secret-password-12345");
  });

  it("includes safePreview when available (CONFIRM decision)", () => {
    const decision = makeDecision("CONFIRM", {
      safePreview: "some [REDACTED_API_KEY] content",
    });
    const obj = buildDecisionJsonOutput(decision, "file.ts");
    expect(obj.safePreview).toBe("some [REDACTED_API_KEY] content");
  });

  it("includes redactedContent when available (CONFIRM decision)", () => {
    const decision = makeDecision("CONFIRM", {
      redactedContent: "const key = [REDACTED_API_KEY];",
    });
    const obj = buildDecisionJsonOutput(decision, "file.ts");
    expect(obj.redactedContent).toBe("const key = [REDACTED_API_KEY];");
  });

  it("includes recommendedAction for CONFIRM decisions", () => {
    const decision = makeDecision("CONFIRM", {
      recommendedAction: "BLOCK",
    });
    const obj = buildDecisionJsonOutput(decision, "file.ts");
    expect(obj.recommendedAction).toBe("BLOCK");
  });

  it("omits recommendedAction for WARN decisions", () => {
    const decision = makeDecision("WARN", { riskLevel: "MEDIUM" });
    const obj = buildDecisionJsonOutput(decision, "file.ts");
    expect(obj.recommendedAction).toBeUndefined();
  });

  it("findings have only transport-safe fields (no match_start, match_end, match_text)", () => {
    const decision = makeDecision("CONFIRM", {
      findings: [
        { type: "API_KEY", severity: "HIGH", preview: "****", description: "API Key" },
      ],
    });
    const obj = buildDecisionJsonOutput(decision, "file.ts");
    for (const f of obj.findings) {
      expect(f).not.toHaveProperty("match_start");
      expect(f).not.toHaveProperty("match_end");
      expect(f).not.toHaveProperty("match_text");
    }
  });
});
