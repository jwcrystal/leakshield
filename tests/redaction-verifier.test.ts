import { describe, expect, it } from "vitest";
import { redactAndVerify } from "../src/scanner/redaction-verifier.js";
import type { GuardConfig } from "../src/types.js";

const config: GuardConfig = {
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

const secret = "sk-abcdefghij1234567890abcde";

describe("redactAndVerify()", () => {
  it("verifies clean text unchanged", () => {
    const result = redactAndVerify("safe content", config);

    expect(result.verified).toBe(true);
    expect(result.redacted).toBe("safe content");
    expect(result.totalFindings).toBe(0);
    expect(result.residualFindings).toBe(0);
  });

  it("verifies redacted text when all secrets are removed", () => {
    const result = redactAndVerify(`token=${secret}`, config);

    expect(result.verified).toBe(true);
    expect(result.redacted).toContain("[REDACTED_API_KEY]");
    expect(result.redacted).not.toContain(secret);
    expect(result.totalFindings).toBeGreaterThan(0);
    expect(result.residualFindings).toBe(0);
  });

  it("does not verify when encoded residual remains after redaction", () => {
    const encodedSecret = Buffer.from(`token=${secret}`, "utf8").toString("base64");
    const result = redactAndVerify(`direct=${secret}\nencoded=${encodedSecret}`, config);

    expect(result.verified).toBe(false);
    expect(result.redacted).not.toContain(secret);
    expect(result.residualFindings).toBeGreaterThan(0);
  });

  it("does not verify truncated input regardless of redaction", () => {
    const smallConfig: GuardConfig = {
      ...config,
      settings: { ...config.settings, max_chars: 10 },
    };
    const result = redactAndVerify("safe ".repeat(21), smallConfig);

    expect(result.verified).toBe(false);
    expect(result.wasTruncated).toBe(true);
  });

  it("does not include match_text or raw secrets in the result", () => {
    const result = redactAndVerify(`token=${secret}`, config);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(secret);
  });
});