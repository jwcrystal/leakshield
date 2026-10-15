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
