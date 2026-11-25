import { describe, it, expect } from "vitest";
import {
  buildSafePreview,
  buildRedactedContent,
  sanitizeFindingForExport,
  sanitizeFindingsForExport,
  sanitizeScanResultForExport,
  sanitizeRedactResultForExport,
} from "../src/decision/redaction.js";
import { scanText } from "../src/scanner/engine.js";
import { BUILTIN_RULES } from "../src/rules/builtin.js";
import type { Finding, FindingType, GuardConfig } from "../src/types.js";

// ─── PEM 全區塊端到端 ────────────────────────────────────────────────────────

describe("PEM full-block protection (end to end)", () => {
  const pemConfig: GuardConfig = {
    nda_keywords: [],
    private_domains: [],
    custom_rules: [],
    settings: {
      max_chars: 200000,
      show_line_numbers: true,
      preview_length: 60,
      encoding_detection: true,
    },
  };

  const PEM_BODY =
    "MIIEowIBAAKCAQEA0Z3VSZSJdyyY8wzwLS0cSBMubeJ6h1LpZfK0hVfX4mW2pQ9zRrTnXyBvGcE7dNaU5fHiJkOlM";
  const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${PEM_BODY}\n${PEM_BODY}\n-----END OPENSSH PRIVATE KEY-----`;

  it("scanner flags the whole block as one SECRET finding", () => {
    const result = scanText(`config:\n${pem}\ndone`, pemConfig);
    const finding = result.findings.find((f) => f.type === "SECRET");
    expect(finding).toBeDefined();
    expect(finding!.match_text).toBe(pem);
  });

  it("redaction removes the ENTIRE key body — nothing reconstructible remains", () => {
    const redacted = buildRedactedContent(`config:\n${pem}\ndone`, scanText(`config:\n${pem}\ndone`, pemConfig).findings);
    // The SECRET placeholder is historically named REDACTED_PASSWORD.
    expect(redacted).toContain("[REDACTED_PASSWORD]");
    expect(redacted).not.toContain(PEM_BODY);
    expect(redacted).not.toContain("BEGIN OPENSSH");
    expect(redacted).not.toContain("END OPENSSH");
  });

  it("builtin rule set carries exactly one PEM rule", () => {
    const pemRules = BUILTIN_RULES.filter((r) => r.description === "PEM Private Key");
    expect(pemRules).toHaveLength(1);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function finding(
  overrides: Partial<Finding> & Pick<Finding, "type">,
): Finding {
  return {
    severity: "HIGH",
    preview: "****",
    description: "test",
    ...overrides,
  };
}

// ─── buildRedactedContent ────────────────────────────────────────────────────

describe("buildRedactedContent", () => {
  it("replaces API keys with [REDACTED_API_KEY]", () => {
    const content = "key = sk-abcdefghij1234567890abcde;";
    const findings = [
      finding({
        type: "API_KEY",
        match_start: 6,
        match_end: 34,
        match_text: "sk-abcdefghij1234567890abcde",
      }),
    ];
    const result = buildRedactedContent(content, findings);
    expect(result).toBe("key = [REDACTED_API_KEY];");
  });

  it("gives the new identifier types their own placeholders", () => {
    const content = "abc DEF 12345678";
    const findings = [
      finding({ type: "PII_PASSPORT", match_start: 0, match_end: 3, match_text: "abc" }),
      finding({ type: "PII_SSN", match_start: 4, match_end: 7, match_text: "DEF" }),
      finding({ type: "TW_BUSINESS_NO", match_start: 8, match_end: 16, match_text: "12345678" }),
    ];
    const result = buildRedactedContent(content, findings);
    expect(result).toBe("[REDACTED_PASSPORT] [REDACTED_SSN] [REDACTED_BUSINESS_NO]");
  });

  it("replaces secrets/passwords with [REDACTED_PASSWORD]", () => {
    const content = "password = supersecret123";
    const findings = [
      finding({
        type: "SECRET",
        match_start: 11,
        match_end: 25,
        match_text: "supersecret123",
      }),
    ];
    const result = buildRedactedContent(content, findings);
    expect(result).toBe("password = [REDACTED_PASSWORD]");
  });

  it("replaces tokens with [REDACTED_TOKEN]", () => {
    const content = "token = ghp_abc123def456ghi789jkl012mno345pqr678";
    const findings = [
      finding({
        type: "TOKEN",
        match_start: 8,
        match_end: 48,
        match_text: "ghp_abc123def456ghi789jkl012mno345pqr678",
      }),
    ];
    const result = buildRedactedContent(content, findings);
    expect(result).toBe("token = [REDACTED_TOKEN]");
  });

  it("replaces emails with [REDACTED_EMAIL]", () => {
    const content = "email: user@example.com";
    const findings = [
      finding({
        type: "PII_EMAIL",
        match_start: 7,
        match_end: 23,
        match_text: "user@example.com",
      }),
    ];
    const result = buildRedactedContent(content, findings);
    expect(result).toBe("email: [REDACTED_EMAIL]");
  });

  it("replaces Taiwan phone numbers with [REDACTED_PHONE]", () => {
    const content = "phone: 0912345678";
    const findings = [
      finding({
        type: "PII_PHONE_TW",
        match_start: 7,
        match_end: 17,
        match_text: "0912345678",
      }),
    ];
    const result = buildRedactedContent(content, findings);
    expect(result).toBe("phone: [REDACTED_PHONE]");
  });

  it("replaces international phone numbers with [REDACTED_PHONE]", () => {
    const content = "tel: +14155552671";
    const findings = [
      finding({
        type: "PII_PHONE_INTL",
        match_start: 5,
        match_end: 18,
        match_text: "+14155552671",
      }),
    ];
    const result = buildRedactedContent(content, findings);
    expect(result).toBe("tel: [REDACTED_PHONE]");
  });

  it("replaces Taiwan IDs with [REDACTED_ID]", () => {
    const content = "id = A123456789";
    const findings = [
      finding({
        type: "PII_ID_TW",
        match_start: 5,
        match_end: 15,
        match_text: "A123456789",
      }),
    ];
    const result = buildRedactedContent(content, findings);
    expect(result).toBe("id = [REDACTED_ID]");
  });

  it("replaces DB URLs with [REDACTED_DB_CONNECTION]", () => {
    const content = "db = postgresql://admin:secret@localhost:5432/mydb";
    const findings = [
      finding({
        type: "DB_CONNECTION",
        match_start: 5,
        match_end: 50,
        match_text: "postgresql://admin:secret@localhost:5432/mydb",
      }),
    ];
    const result = buildRedactedContent(content, findings);
    expect(result).toBe("db = [REDACTED_DB_CONNECTION]");
  });

  it("replaces private domains with [REDACTED_PRIVATE_DOMAIN]", () => {
    const content = "url = https://internal.corp.com/api";
    const findings = [
      finding({
        type: "PRIVATE_DOMAIN",
        match_start: 14,
        match_end: 31,
        match_text: "internal.corp.com",
      }),
    ];
    const result = buildRedactedContent(content, findings);
    expect(result).toBe("url = https://[REDACTED_PRIVATE_DOMAIN]/api");
  });

  it("replaces NDA keywords with [REDACTED_NDA_TERM]", () => {
    const content = "This document is CONFIDENTIAL.";
    const findings = [
      finding({
        type: "NDA_KEYWORD",
        match_start: 17,
        match_end: 29,
        match_text: "CONFIDENTIAL",
      }),
    ];
    const result = buildRedactedContent(content, findings);
    expect(result).toBe("This document is [REDACTED_NDA_TERM].");
  });

  it("preserves line breaks and non-sensitive content exactly", () => {
    const content = "line1\nkey = sk-abcdefghij1234567890abcde\nline3";
    const findings = [
      finding({
        type: "API_KEY",
        match_start: 12,
        match_end: 40,
        match_text: "sk-abcdefghij1234567890abcde",
      }),
    ];
    const result = buildRedactedContent(content, findings);
    expect(result).toBe("line1\nkey = [REDACTED_API_KEY]\nline3");
  });

  it("preserves whitespace exactly", () => {
    const content = "  spaces  before  and  after  ";
    const findings = [
      finding({
        type: "API_KEY",
        match_start: 18,
        match_end: 21,
        match_text: "and",
      }),
    ];
    const result = buildRedactedContent(content, findings);
    expect(result).toBe("  spaces  before  [REDACTED_API_KEY]  after  ");
  });

  it("handles multiple findings in the same content", () => {
    const content = "email: user@example.com and key = sk-abcdefghij1234567890abcde";
    const findings = [
      finding({
        type: "PII_EMAIL",
        match_start: 7,
        match_end: 23,
        match_text: "user@example.com",
      }),
      finding({
        type: "API_KEY",
        match_start: 34,
        match_end: 62,
        match_text: "sk-abcdefghij1234567890abcde",
      }),
    ];
    const result = buildRedactedContent(content, findings);
    expect(result).toBe(
      "email: [REDACTED_EMAIL] and key = [REDACTED_API_KEY]",
    );
  });

  it("merges overlapping spans before replacement", () => {
    const content = "sk-abcdefghij1234567890abcde extra";
    // Two overlapping findings for the same match
    const findings = [
      finding({
        type: "API_KEY",
        match_start: 0,
        match_end: 28,
        match_text: "sk-abcdefghij1234567890abcde",
      }),
      finding({
        type: "TOKEN",
        match_start: 3,
        match_end: 28,
        match_text: "abcdefghij1234567890abcde",
      }),
    ];
    const result = buildRedactedContent(content, findings);
    // Overlapping spans should be merged into a single replacement
    expect(result).toBe("[REDACTED_API_KEY] extra");
  });

  it("returns undefined when content cannot be safely redacted (no match metadata)", () => {
    const content = "some content with no metadata";
    const findings = [
      finding({
        type: "API_KEY",
        // No match_start/match_end/match_text
      }),
    ];
    const result = buildRedactedContent(content, findings);
    expect(result).toBeUndefined();
  });

  it("returns undefined when findings array is empty", () => {
    const result = buildRedactedContent("clean content", []);
    expect(result).toBeUndefined();
  });

  it("returns undefined when a finding has partial metadata (missing match_end)", () => {
    const content = "key = sk-abcdefghij1234567890abcde";
    const findings = [
      finding({
        type: "API_KEY",
        match_start: 6,
        // match_end missing
        match_text: "sk-abcdefghij1234567890abcde",
      }),
    ];
    const result = buildRedactedContent(content, findings);
    expect(result).toBeUndefined();
  });

  it("handles findings sorted out of order correctly", () => {
    const content = "a b c";
    const findings = [
      finding({
        type: "API_KEY",
        match_start: 4,
        match_end: 5,
        match_text: "c",
      }),
      finding({
        type: "SECRET",
        match_start: 0,
        match_end: 1,
        match_text: "a",
      }),
    ];
    const result = buildRedactedContent(content, findings);
    expect(result).toBe("[REDACTED_PASSWORD] b [REDACTED_API_KEY]");
  });
});

// ─── buildSafePreview ─────────────────────────────────────────────────────────

describe("buildSafePreview", () => {
  it("returns a masked excerpt respecting preview_length", () => {
    const content = "key = sk-abcdefghij1234567890abcde and more text here";
    const findings = [
      finding({
        type: "API_KEY",
        match_start: 6,
        match_end: 34,
        match_text: "sk-abcdefghij1234567890abcde",
      }),
    ];
    const result = buildSafePreview(content, findings, {
      settings: { max_chars: 200000, show_line_numbers: true, preview_length: 20 },
      nda_keywords: [],
      private_domains: [],
    });
    // Should be at most preview_length characters
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(20);
    expect(result).toContain("[REDACTED_API_KEY]");
  });

  it("returns undefined when findings is empty", () => {
    const result = buildSafePreview("clean content", [], undefined);
    expect(result).toBeUndefined();
  });

  it("returns undefined when no match metadata is available", () => {
    const content = "some content";
    const findings = [
      finding({
        type: "API_KEY",
        // No match metadata
      }),
    ];
    const result = buildSafePreview(content, findings, undefined);
    expect(result).toBeUndefined();
  });

  it("uses default preview_length of 60 when config is not provided", () => {
    const content = "key = sk-abcdefghij1234567890abcde and more text here that extends beyond sixty characters for sure";
    const findings = [
      finding({
        type: "API_KEY",
        match_start: 6,
        match_end: 34,
        match_text: "sk-abcdefghij1234567890abcde",
      }),
    ];
    const result = buildSafePreview(content, findings);
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(60);
    expect(result).toContain("[REDACTED_API_KEY]");
  });

  it("preserves line breaks in preview when possible", () => {
    const content = "line1\nkey = sk-abcdefghij1234567890abcde\nline3";
    const findings = [
      finding({
        type: "API_KEY",
        match_start: 12,
        match_end: 40,
        match_text: "sk-abcdefghij1234567890abcde",
      }),
    ];
    const result = buildSafePreview(content, findings, {
      settings: { max_chars: 200000, show_line_numbers: true, preview_length: 50 },
      nda_keywords: [],
      private_domains: [],
    });
    expect(result).toBeDefined();
    expect(result).toContain("\n");
    expect(result).toContain("[REDACTED_API_KEY]");
  });

  it("excerpts from the area around the first finding", () => {
    const longPrefix = "a".repeat(100);
    const content = `${longPrefix} key = sk-abcdefghij1234567890abcde tail`;
    const findings = [
      finding({
        type: "API_KEY",
        match_start: 107,
        match_end: 134,
        match_text: "sk-abcdefghij1234567890abcde",
      }),
    ];
    const result = buildSafePreview(content, findings, {
      settings: { max_chars: 200000, show_line_numbers: true, preview_length: 40 },
      nda_keywords: [],
      private_domains: [],
    });
    expect(result).toBeDefined();
    expect(result).toContain("[REDACTED_API_KEY]");
    // Should NOT start with 100 'a's since that would exceed preview_length
    expect(result!.length).toBeLessThanOrEqual(40);
  });
});

// ─── Sanitization for transport exports ────────────────────────────────────────

describe("sanitizeFindingForExport", () => {
  it("strips match_start, match_end, and match_text from a finding", () => {
    const f: Finding = {
      type: "API_KEY",
      severity: "HIGH",
      line: 3,
      column: 5,
      preview: "****",
      description: "OpenAI API Key",
      match_start: 20,
      match_end: 50,
      match_text: "sk-abcdefghij1234567890abcde",
    };
    const safe = sanitizeFindingForExport(f);
    expect(safe.type).toBe("API_KEY");
    expect(safe.severity).toBe("HIGH");
    expect(safe.line).toBe(3);
    expect(safe.column).toBe(5);
    expect(safe.preview).toBe("****");
    expect(safe.description).toBe("OpenAI API Key");
    expect("match_start" in safe).toBe(false);
    expect("match_end" in safe).toBe(false);
    expect("match_text" in safe).toBe(false);
  });

  it("preserves a finding that never had internal metadata", () => {
    const f: Finding = {
      type: "PII_EMAIL",
      severity: "MEDIUM",
      preview: "****",
      description: "Email",
    };
    const safe = sanitizeFindingForExport(f);
    expect(safe).toEqual({ type: "PII_EMAIL", severity: "MEDIUM", preview: "****", description: "Email" });
  });
});

describe("sanitizeFindingsForExport", () => {
  it("strips internal metadata from every finding in the array", () => {
    const findings: Finding[] = [
      { type: "API_KEY", severity: "HIGH", preview: "****", description: "k", match_start: 0, match_end: 5, match_text: "abcde" },
      { type: "PII_EMAIL", severity: "MEDIUM", preview: "****", description: "e", match_start: 10, match_end: 20, match_text: "user@test" },
    ];
    const safe = sanitizeFindingsForExport(findings);
    expect(safe).toHaveLength(2);
    for (const f of safe) {
      expect("match_start" in f).toBe(false);
      expect("match_end" in f).toBe(false);
      expect("match_text" in f).toBe(false);
    }
  });

  it("returns a new array (does not mutate the original)", () => {
    const findings: Finding[] = [
      { type: "API_KEY", severity: "HIGH", preview: "****", description: "k", match_start: 0, match_end: 5, match_text: "abcde" },
    ];
    const safe = sanitizeFindingsForExport(findings);
    expect(safe).not.toBe(findings);
    expect(findings[0]).toHaveProperty("match_text");
  });

  it("returns empty array for empty input", () => {
    expect(sanitizeFindingsForExport([])).toEqual([]);
  });
});

describe("sanitizeScanResultForExport", () => {
  it("strips internal metadata from ScanResult findings", () => {
    const result = {
      safe: false,
      total_findings: 1,
      findings: [
        { type: "API_KEY" as const, severity: "HIGH" as const, preview: "****", description: "k", match_start: 0, match_end: 5, match_text: "abcde" },
      ],
      summary: "🚨",
      recommendation: "fix it",
    };
    const safe = sanitizeScanResultForExport(result);
    expect(safe.safe).toBe(false);
    expect(safe.total_findings).toBe(1);
    expect(safe.summary).toBe("🚨");
    expect(safe.recommendation).toBe("fix it");
    expect(safe.findings).toHaveLength(1);
    expect("match_start" in safe.findings[0]).toBe(false);
    expect("match_end" in safe.findings[0]).toBe(false);
    expect("match_text" in safe.findings[0]).toBe(false);
  });
});

describe("sanitizeRedactResultForExport", () => {
  it("strips internal metadata from RedactResult findings", () => {
    const result = {
      redacted: "clean text",
      findings: [
        { type: "SECRET" as const, severity: "HIGH" as const, preview: "****", description: "s", match_start: 0, match_end: 5, match_text: "hello" },
      ],
      total_findings: 1,
      summary: "🚨",
    };
    const safe = sanitizeRedactResultForExport(result);
    expect(safe.redacted).toBe("clean text");
    expect(safe.total_findings).toBe(1);
    expect(safe.summary).toBe("🚨");
    expect(safe.findings).toHaveLength(1);
    expect("match_start" in safe.findings[0]).toBe(false);
    expect("match_end" in safe.findings[0]).toBe(false);
    expect("match_text" in safe.findings[0]).toBe(false);
  });
});

describe("transport output serialization safety", () => {
  it("JSON.stringify of sanitized findings does not contain internal keys", () => {
    const findings: Finding[] = [
      { type: "API_KEY", severity: "HIGH", preview: "****", description: "OpenAI API Key", match_start: 6, match_end: 36, match_text: "sk-abcdefghij1234567890abcde" },
    ];
    const safe = sanitizeFindingsForExport(findings);
    const json = JSON.stringify(safe);
    expect(json).not.toContain("match_start");
    expect(json).not.toContain("match_end");
    expect(json).not.toContain("match_text");
    expect(json).toContain("API_KEY");
  });

  it("JSON.stringify of sanitized ScanResult does not contain internal keys", () => {
    const result = {
      safe: false,
      total_findings: 1,
      findings: [
        { type: "API_KEY" as const, severity: "HIGH" as const, preview: "****", description: "k", match_start: 0, match_end: 5, match_text: "abcde" },
      ],
      summary: "🚨",
      recommendation: "fix",
    };
    const safe = sanitizeScanResultForExport(result);
    const json = JSON.stringify(safe);
    expect(json).not.toContain("match_start");
    expect(json).not.toContain("match_end");
    expect(json).not.toContain("match_text");
  });

  it("unsanitized findings DO contain internal keys (regression guard)", () => {
    const findings: Finding[] = [
      { type: "API_KEY", severity: "HIGH", preview: "****", description: "k", match_start: 0, match_end: 5, match_text: "abcde" },
    ];
    const json = JSON.stringify(findings);
    expect(json).toContain("match_start");
    expect(json).toContain("match_end");
    expect(json).toContain("match_text");
  });
});
