import { describe, expect, it } from "vitest";
import { GuardConfigSchema } from "../src/config/loader.js";
import { createPseudonymizer } from "../src/decision/pseudonymization.js";
import { redactText, scanText } from "../src/scanner/engine.js";
import { GuardConfig } from "../src/types.js";

type SyntheticRule = { description: string; pattern: string; severity: "HIGH" | "MEDIUM" | "LOW"; allow?: string[] };

function configWith(rules: SyntheticRule[], settings: Record<string, unknown> = {}): GuardConfig {
  return GuardConfigSchema.parse({ nda_keywords: [], custom_rules: rules, settings });
}

const LOW = { description: "synthetic-low", severity: "LOW" } as const;
const HIGH = { description: "synthetic-high", severity: "HIGH" } as const;

describe("rules of one type matching at one offset", () => {
  it.each([
    ["low rule first", [{ ...LOW, pattern: "alpha" }, { ...HIGH, pattern: "alpha" }]],
    ["high rule first", [{ ...HIGH, pattern: "alpha" }, { ...LOW, pattern: "alpha" }]],
  ])("reports one finding at the highest severity with the %s", (_name, rules) => {
    const result = scanText("alpha", configWith(rules));
    expect(result.findings.map((f) => [f.severity, f.description])).toEqual([["HIGH", "synthetic-high"]]);
    expect(result.total_findings).toBe(1);
  });

  it("keeps the highest severity with encoding detection on", () => {
    const config = configWith([{ ...LOW, pattern: "alpha" }, { ...HIGH, pattern: "alpha" }], { encoding_detection: true });
    expect(scanText("alpha", config).findings.map((f) => f.severity)).toEqual(["HIGH"]);
  });

  it.each([
    ["short low rule first", [{ ...LOW, pattern: "alpha" }, { ...HIGH, pattern: "alpha-[0-9]+" }]],
    ["long low rule first", [{ ...LOW, pattern: "alpha-[0-9]+" }, { ...HIGH, pattern: "alpha" }]],
    ["short high rule first", [{ ...HIGH, pattern: "alpha" }, { ...LOW, pattern: "alpha-[0-9]+" }]],
  ])("covers the longest span at the highest severity with the %s", (_name, rules) => {
    const [finding, ...rest] = scanText("x alpha-123 y", configWith(rules)).findings;
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      severity: "HIGH",
      description: "synthetic-high",
      match_start: 2,
      match_end: 11,
      match_text: "alpha-123",
    });
    expect(finding.preview).toBe(scanText("alpha-123", configWith([{ ...LOW, pattern: "alpha-123" }])).findings[0].preview);
  });

  it("lets the longer span win between equal severities without replacing the description", () => {
    const rules = [{ ...HIGH, pattern: "alpha" }, { ...HIGH, description: "synthetic-long", pattern: "alpha-[0-9]+" }];
    expect(scanText("alpha-123", configWith(rules)).findings).toMatchObject([
      { description: "synthetic-high", match_text: "alpha-123" },
    ]);
  });

  it("does not merge a rule whose own allow list suppressed the match", () => {
    const rules = [
      { ...HIGH, pattern: "alpha-[0-9]+", allow: ["alpha-123"] },
      { ...LOW, pattern: "alpha" },
    ];
    expect(scanText("alpha-123", configWith(rules)).findings).toMatchObject([
      { severity: "LOW", match_text: "alpha" },
    ]);
  });

  it("keeps separate findings at separate offsets", () => {
    const rules = [{ ...LOW, pattern: "alpha" }, { ...HIGH, pattern: "beta" }];
    expect(scanText("alpha beta", configWith(rules)).findings.map((f) => f.severity)).toEqual(["LOW", "HIGH"]);
  });

  it("transparent mode masks the whole of the longer match", () => {
    const created = createPseudonymizer(configWith([{ ...LOW, pattern: "alpha" }, { ...HIGH, pattern: "alpha-[0-9]+" }]));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const masked = created.protectText("s", "x alpha-123 y");
    expect(masked.ok).toBe(true);
    if (!masked.ok) return;
    expect(masked.text).toMatch(/^x \[SGP2:[^\]]+\] y$/);
  });

  it("redactText masks the longest span and reports the highest severity", () => {
    const rules = [{ ...LOW, pattern: "alpha" }, { ...HIGH, pattern: "alpha-[0-9]+" }];
    const result = redactText("x alpha-123 y", configWith(rules));
    expect(result.redacted).toBe("x [REDACTED_CUSTOM] y");
    expect(result.findings.map((f) => f.severity)).toEqual(["HIGH"]);
  });
});
