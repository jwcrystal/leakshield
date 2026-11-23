import { describe, expect, it } from "vitest";
import { validatePluginOptions } from "../src/guard-options.js";

describe("transparent wire protection options", () => {
  it.each([undefined, true, false])("accepts wireProtection=%s without changing omission semantics", (wireProtection) => {
    const result = validatePluginOptions({ mode: "transparent", ...(wireProtection === undefined ? {} : { wireProtection }) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.options.wireProtection).toBe(wireProtection);
  });

  it.each(["false", 0, null])("rejects invalid wireProtection %#", (wireProtection) => {
    expect(validatePluginOptions({ mode: "transparent", wireProtection }).ok).toBe(false);
  });

  it.each(["block", "redact"])("rejects an explicitly selected wire policy outside transparent mode: %s", (mode) => {
    expect(validatePluginOptions({ mode, wireProtection: false }).ok).toBe(false);
  });
});

describe("default mode", () => {
  it("fills in transparent when mode is omitted", () => {
    for (const input of [undefined, null, {}, { configPath: "guard.yaml" }]) {
      const result = validatePluginOptions(input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.options.mode).toBe("transparent");
    }
  });

  it.each(["block", "redact", "transparent"] as const)("keeps an explicit mode %s", (mode) => {
    const result = validatePluginOptions({ mode });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.options.mode).toBe(mode);
  });

  it("rejects envQueries without an explicit mode, since the default is transparent", () => {
    const result = validatePluginOptions({ envQueries: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("envQueries is not supported in mode 'transparent'");
    expect(validatePluginOptions({ mode: "block", envQueries: true }).ok).toBe(true);
  });

  it.each(["block", 1, ["mode"]])("rejects non-object options %#", (input) => {
    expect(validatePluginOptions(input).ok).toBe(false);
  });

  it("rejects options parsed without a filled-in mode", async () => {
    const { PluginOptionsSchema } = await import("../src/guard-options.js");
    expect(PluginOptionsSchema.safeParse({}).success).toBe(false);
  });
});

describe("persistence option (zod 4)", () => {
  it("omitted persistence gets inner defaults", () => {
    const result = validatePluginOptions({ mode: "transparent" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.options.persistence).toEqual({ enabled: false, ttlDays: 7, keyFile: false });
  });

  it.each([new Date(), new Map(), new Uint8Array(1), [], "x", null])("rejects non-mapping persistence %#", (persistence) => {
    expect(validatePluginOptions({ mode: "transparent", persistence }).ok).toBe(false);
  });

  it("never throws on a Date root", () => {
    expect(() => validatePluginOptions(new Date())).not.toThrow();
  });

  it("keeps each refinement message", () => {
    const error = (input: unknown) => {
      const r = validatePluginOptions(input);
      return r.ok ? "" : r.error;
    };
    expect(error({ mode: "block", deidentify: true })).toContain("deidentify requires mode 'redact'");
    expect(error({ mode: "transparent", envQueries: true })).toContain("envQueries is not supported in mode 'transparent'");
    expect(error({ mode: "block", attachments: "allow" })).toContain('attachments "allow" requires mode "transparent"');
    expect(error({ mode: "block", wireProtection: false })).toContain('wireProtection requires mode "transparent"');
    expect(error({ mode: "block", persistence: { enabled: true } })).toContain('persistence requires mode "transparent"');
  });

  it("does not echo rejected values in the error", () => {
    const SENTINEL = "sk-LEAKCHECK-value";
    for (const input of [{ mode: SENTINEL }, { mode: "transparent", attachments: SENTINEL }]) {
      const result = validatePluginOptions(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toContain(SENTINEL);
        expect(result.error).not.toContain("input");
      }
    }
  });
});
