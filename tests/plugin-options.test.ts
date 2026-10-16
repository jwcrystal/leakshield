import { describe, expect, it } from "vitest";
import { validatePluginOptions } from "../src/plugin-options.js";

describe("transparent wire protection options", () => {
  it.each([undefined, true, false])("accepts wireProtection=%s without changing omission semantics", (wireProtection) => {
    const result = validatePluginOptions({ mode: "transparent", ...(wireProtection === undefined ? {} : { wireProtection }) }, "v2");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.options.wireProtection).toBe(wireProtection);
  });

  it.each(["false", 0, null])("rejects invalid wireProtection %#", (wireProtection) => {
    expect(validatePluginOptions({ mode: "transparent", wireProtection }, "v2").ok).toBe(false);
  });

  it.each(["block", "redact"])("rejects an explicitly selected wire policy outside transparent mode: %s", (mode) => {
    expect(validatePluginOptions({ mode, wireProtection: false }, "v2").ok).toBe(false);
  });
});

describe("default mode by host generation", () => {
  it.each([
    ["v2", "transparent"],
    ["v1", "block"],
  ] as const)("fills in the %s default (%s) when mode is omitted", (generation, mode) => {
    for (const input of [undefined, null, {}, { configPath: "guard.yaml" }]) {
      const result = validatePluginOptions(input, generation);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.options.mode).toBe(mode);
    }
  });

  it.each(["block", "redact", "transparent"] as const)("keeps an explicit mode %s on v2", (mode) => {
    const result = validatePluginOptions({ mode }, "v2");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.options.mode).toBe(mode);
  });

  it("rejects envQueries without an explicit mode on v2, since the default is transparent", () => {
    const result = validatePluginOptions({ envQueries: true }, "v2");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("envQueries is not supported in mode 'transparent'");
    expect(validatePluginOptions({ envQueries: true }, "v1").ok).toBe(true);
  });

  it.each(["block", 1, ["mode"]])("rejects non-object options %#", (input) => {
    expect(validatePluginOptions(input, "v2").ok).toBe(false);
  });

  it("rejects options parsed without a filled-in mode", async () => {
    const { PluginOptionsSchema } = await import("../src/plugin-options.js");
    expect(PluginOptionsSchema.safeParse({}).success).toBe(false);
  });
});
