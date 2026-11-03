import { describe, expect, it } from "vitest";
import { validatePluginOptions } from "../src/plugin-options.js";

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
    const { PluginOptionsSchema } = await import("../src/plugin-options.js");
    expect(PluginOptionsSchema.safeParse({}).success).toBe(false);
  });
});
