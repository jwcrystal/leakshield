import { describe, expect, it } from "vitest";
import { scanText } from "../src/scanner/engine.js";
import { buildRedactedContent, buildSafePreview } from "../src/decision/redaction.js";
import type { GuardConfig } from "../src/types.js";

const defaultConfig: GuardConfig = {
  nda_keywords: ["CONFIDENTIAL"],
  private_domains: ["internal.corp.com"],
  custom_rules: [],
  settings: { max_chars: 200000, show_line_numbers: true, preview_length: 60 },
};

describe("buildRedactedContent", () => {
  it("replaces API keys with semantic placeholders", () => {
    const text = "const key = 'sk-abcdefghij1234567890abcde';";
    const scan = scanText(text, defaultConfig);
    expect(buildRedactedContent(text, scan.findings)).toContain("[REDACTED_API_KEY]");
  });

  it("preserves line breaks and non-sensitive content", () => {
    const text = "user@example.com\nconst env = 'prod'";
    const scan = scanText(text, defaultConfig);
    expect(buildRedactedContent(text, scan.findings)).toBe("[REDACTED_EMAIL]\nconst env = 'prod'");
  });

  it("returns undefined when content cannot be safely redacted", () => {
    expect(buildRedactedContent("\u0000\u0001binary", [])).toBeUndefined();
  });

  it("replaces NDA keywords with [REDACTED_NDA_TERM]", () => {
    const text = "This is CONFIDENTIAL data.";
    const scan = scanText(text, defaultConfig);
    expect(buildRedactedContent(text, scan.findings)).toContain("[REDACTED_NDA_TERM]");
  });

  it("handles multiple findings in one line", () => {
    const text = "user@example.com and 0912345678";
    const scan = scanText(text, defaultConfig);
    const result = buildRedactedContent(text, scan.findings);
    expect(result).toContain("[REDACTED_EMAIL]");
    expect(result).toContain("[REDACTED_PHONE]");
    expect(result).not.toContain("@");
    expect(result).not.toContain("0912345678");
  });

  it("content with no findings is returned unchanged", () => {
    const text = "hello world";
    const scan = scanText(text, defaultConfig);
    expect(buildRedactedContent(text, scan.findings)).toBe("hello world");
  });

  it("handles overlapping or adjacent findings without corruption", () => {
    // Two findings that share the same region (deduped by scanner)
    const text = "sk-abcdefghij1234567890abcde";
    const scan = scanText(text, defaultConfig);
    const result = buildRedactedContent(text, scan.findings);
    expect(result).toBe("[REDACTED_API_KEY]");
  });
});

describe("buildSafePreview", () => {
  it("returns a masked excerpt that respects preview_length", () => {
    const text = "sk-abcdefghij1234567890abcde more content here";
    const scan = scanText(text, defaultConfig);
    const preview = buildSafePreview(text, scan.findings);
    expect(preview).toContain("****");
    expect(preview!.length).toBeLessThanOrEqual(defaultConfig.settings.preview_length);
  });

  it("returns undefined when content has no findings", () => {
    const text = "safe content";
    const scan = scanText(text, defaultConfig);
    // No findings → no preview needed
    expect(buildSafePreview(text, scan.findings)).toBeUndefined();
  });

  it("truncates long content to preview_length", () => {
    const text = "user@example.com " + "x".repeat(100);
    const scan = scanText(text, defaultConfig);
    const preview = buildSafePreview(text, scan.findings, 60);
    expect(preview!.length).toBeLessThanOrEqual(60);
  });
});

describe("scanText raw match metadata", () => {
  it("stores match span data needed for deterministic replacement", () => {
    const scan = scanText("sk-abcdefghij1234567890abcde", defaultConfig);
    expect(scan.findings[0]).toMatchObject({ match_start: 0 });
    expect(scan.findings[0]?.match_text).toBeTypeOf("string");
  });

  it("match_start and match_end are consistent with match_text length", () => {
    const text = "prefix sk-abcdefghij1234567890abcde suffix";
    const scan = scanText(text, defaultConfig);
    const f = scan.findings.find((x) => x.type === "API_KEY");
    expect(f).toBeDefined();
    expect(f!.match_end! - f!.match_start!).toBe(f!.match_text!.length);
  });

  it("match_start correctly reflects byte offset in text", () => {
    const text = "const key = 'sk-abcdefghij1234567890abcde';";
    const scan = scanText(text, defaultConfig);
    const f = scan.findings.find((x) => x.type === "API_KEY");
    expect(f).toBeDefined();
    expect(text.slice(f!.match_start!, f!.match_end!)).toBe(f!.match_text);
  });
});
