import { describe, expect, it } from "vitest";
import { ContentHashCache, protectText, protectUnknownStrings } from "../src/decision/ingress.js";
import { ExactValueDetector } from "../src/scanner/exact-values.js";
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

describe("ContentHashCache", () => {
  it("reuses identical allow decisions without retaining the input", () => {
    const cache = new ContentHashCache();
    const options = { mode: "block" as const, context: "history" };

    expect(cache.protect("safe content", config, options).action).toBe("allow");
    expect(cache.protect("safe content", config, options).text).toBe("safe content");

    expect(cache.size).toBe(1);
    expect(cache.stats).toEqual({ hits: 1, misses: 1 });
  });

  it("keys decisions by configuration, mode, and context", () => {
    const cache = new ContentHashCache();
    const options = { mode: "block" as const, context: "history" };
    const changedConfig: GuardConfig = {
      ...config,
      private_domains: ["internal.example.com"],
    };

    expect(cache.protect("internal.example.com", config, options).action).toBe("allow");
    expect(cache.protect("internal.example.com", changedConfig, options).action).toBe("block");
    expect(cache.protect("internal.example.com", changedConfig, { ...options, context: "tool output" }).action).toBe("block");

    expect(cache.size).toBe(3);
    expect(cache.stats).toEqual({ hits: 0, misses: 3 });
  });

  it("invalidates decisions when configured exact values change", () => {
    const cache = new ContentHashCache();
    const options = { mode: "block" as const, context: "history" };
    const opaqueValue = "unclassified-opaque-value-987654321";
    const previousConfig: GuardConfig = {
      ...config,
      exact_value_detector: new ExactValueDetector(["different-opaque-value-123456789"]),
    };
    const currentConfig: GuardConfig = {
      ...config,
      exact_value_detector: new ExactValueDetector([opaqueValue]),
    };

    expect(cache.protect(opaqueValue, previousConfig, options).action).toBe("allow");
    expect(cache.protect(opaqueValue, currentConfig, options).action).toBe("block");
    expect(cache.stats).toEqual({ hits: 0, misses: 2 });
  });

  it("evicts least recently used decisions when full", () => {
    const cache = new ContentHashCache(2);
    const options = { mode: "block" as const, context: "history" };

    cache.protect("first", config, options);
    cache.protect("second", config, options);
    cache.protect("third", config, options);
    cache.protect("first", config, options);

    expect(cache.size).toBe(2);
    expect(cache.stats).toEqual({ hits: 0, misses: 4 });
  });

  it("does not cache redacted text", () => {
    const cache = new ContentHashCache();
    const options = { mode: "redact" as const, context: "history" };

    cache.protect(`token=${secret}`, config, options);
    cache.protect(`token=${secret}`, config, options);

    expect(cache.size).toBe(0);
    expect(cache.stats).toEqual({ hits: 0, misses: 2 });
  });
});
