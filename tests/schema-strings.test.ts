/**
 * Unit tests for the shared schema-subtree structural walker.
 *
 * Contract: keys and identifier values (enum/const/pattern, types, required
 * entries) are collected; JSON Schema annotation VALUES (description, title)
 * are skipped so they mask as ordinary content instead of refusing a request.
 */

import { describe, expect, it } from "vitest";
import { SCHEMA_ANNOTATION_KEYS, walkSchemaStrings } from "../src/decision/schema-strings.js";

function collect(value: unknown): string[] {
  const out: string[] = [];
  walkSchemaStrings(out, value);
  return out;
}

describe("walkSchemaStrings", () => {
  it("collects keys, types, and required entries", () => {
    const out = collect({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
    expect(out).toContain("type");
    expect(out).toContain("object");
    expect(out).toContain("properties");
    expect(out).toContain("path");
    expect(out).toContain("string");
    expect(out).toContain("required");
  });

  it("skips description and title VALUES but keeps the annotation keys", () => {
    const out = collect({
      type: "object",
      description: "Detects hardcoded secrets and API keys",
      title: "Secret scanner options",
      properties: {},
    });
    expect(out).toContain("description");
    expect(out).toContain("title");
    expect(out).not.toContain("Detects hardcoded secrets and API keys");
    expect(out).not.toContain("Secret scanner options");
  });

  it("skips annotation values at any nesting depth", () => {
    const out = collect({
      anyOf: [
        { type: "string", description: "hidden prose one" },
        { items: { type: "number", title: "hidden prose two" } },
      ],
    });
    expect(out).not.toContain("hidden prose one");
    expect(out).not.toContain("hidden prose two");
    expect(out).toContain("anyOf");
    expect(out).toContain("items");
    expect(out).toContain("number");
  });

  it("still collects enum, const, and pattern values (identifiers)", () => {
    const out = collect({
      properties: {
        severity: { type: "string", enum: ["high", "critical"] },
        mode: { const: "strict" },
        name: { type: "string", pattern: "^[a-z]+$" },
      },
    });
    expect(out).toContain("high");
    expect(out).toContain("critical");
    expect(out).toContain("strict");
    expect(out).toContain("^[a-z]+$");
  });

  it("handles non-string leaves, arrays, and null without collecting them", () => {
    const out = collect({
      minimum: 0,
      maximum: 100,
      flag: true,
      nothing: null,
      list: ["a", 1, null, true],
    });
    expect(out).toContain("minimum");
    expect(out).toContain("maximum");
    expect(out).toContain("flag");
    expect(out).toContain("nothing");
    expect(out).toContain("list");
    expect(out).toContain("a");
    // Non-string leaves contribute no value strings.
    expect(out.filter((s) => s === "true" || s === "null")).toHaveLength(0);
  });

  it("bare string root is collected; bare non-object root is not", () => {
    expect(collect("just-a-string")).toEqual(["just-a-string"]);
    expect(collect(7)).toEqual([]);
    expect(collect(null)).toEqual([]);
  });

  it("annotation key set is exactly description and title", () => {
    expect([...SCHEMA_ANNOTATION_KEYS].sort()).toEqual(["description", "title"]);
  });
});
