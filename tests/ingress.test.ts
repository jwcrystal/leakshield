import { describe, expect, it } from "vitest";
import { protectText, protectUnknownStrings } from "../src/decision/ingress.js";
import type { GuardConfig } from "../src/types.js";

const config: GuardConfig = {
  nda_keywords: [],
  private_domains: [],
  custom_rules: [],
  settings: {
    max_chars: 100,
    show_line_numbers: true,
    preview_length: 60,
    encoding_detection: true,
  },
};

const secret = "sk-12345678901234567890";

describe("protectText()", () => {
  it("passes safe content through unchanged", () => {
    expect(protectText("safe content", config, { mode: "block", context: "message text" })).toEqual({
      action: "allow",
      text: "safe content",
      totalFindings: 0,
    });
  });

  it("blocks sensitive content by default without retaining the secret", () => {
    const result = protectText(`token=${secret}`, config, { mode: "block", context: "tool output" });

    expect(result.action).toBe("block");
    expect(result.text).not.toContain(secret);
    expect(result.text).toContain("Sensitive Guard blocked tool output");
  });

  it("redacts direct matches only when redaction mode is explicitly enabled", () => {
    const result = protectText(`token=${secret}`, config, { mode: "redact", context: "message text" });

    expect(result.action).toBe("redact");
    expect(result.text).toContain("[REDACTED_API_KEY]");
    expect(result.text).not.toContain(secret);
  });

  it("blocks the payload when encoded sensitive content remains after redaction", () => {
    const encodedSecret = Buffer.from(`token=${secret}`, "utf8").toString("base64");
    const result = protectText(`direct=${secret}\nencoded=${encodedSecret}`, config, {
      mode: "redact",
      context: "message text",
    });

    expect(result.action).toBe("block");
    expect(result.text).not.toContain(secret);
    expect(result.text).not.toContain(encodedSecret);
  });

  it("blocks content exceeding the scan limit rather than forwarding an unscanned suffix", () => {
    const result = protectText("safe ".repeat(21), config, { mode: "redact", context: "message text" });

    expect(result.action).toBe("block");
    expect(result.text).not.toContain("safe safe");
  });
});

describe("protectUnknownStrings()", () => {
  it("returns a new structure with nested sensitive strings removed", () => {
    const original = { output: `token=${secret}`, nested: ["safe", { note: `key=${secret}` }] };
    const protectedValue = protectUnknownStrings(original, config, { mode: "block", context: "tool metadata" });
    const serialized = JSON.stringify(protectedValue);

    expect(protectedValue).not.toBe(original);
    expect(serialized).not.toContain(secret);
    expect(original.output).toContain(secret);
  });

  it("preserves cyclic JSON-like structures without recursion failures", () => {
    const original: { self?: unknown } = {};
    original.self = original;

    const protectedValue = protectUnknownStrings(original, config, { mode: "block", context: "tool metadata" }) as { self: unknown };

    expect(protectedValue).not.toBe(original);
    expect(protectedValue.self).toBe(protectedValue);
  });
});
