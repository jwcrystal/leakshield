import { describe, expect, it } from "vitest";
import { opencodeToolPolicy } from "../src/adapters/opencode/opencode-tool-policy.js";

const p = opencodeToolPolicy;
describe("OpenCode tool policy injection", () => {
  it("recognizes only a plain execute input with a string code data property", () => {
    expect(p.isCodeModeCall({ tool: "execute", input: { code: "console.log(1)" } })).toBe(true);
    expect(p.isCodeModeCall({ tool: "execute", input: { code: 1 } })).toBe(false);
    expect(p.isCodeModeCall({ tool: "bash", input: { code: "text" } })).toBe(false);
    expect(p.isCodeModeCall({ tool: "execute", input: Object.defineProperty({}, "code", { get() { throw Error("getter executed"); } }) })).toBe(false);
  });
  it("preserves field and read-only classification", () => {
    expect(p.isShellTool("bash")).toBe(true);
    expect(p.classifyField("command", "verbatim")).toBe("shell");
    expect(p.classifyField("code", "verbatim")).toBe("inert");
    expect(p.allowsDegradedRestore("read", { filePath: "a" })).toBe(true);
    expect(p.allowsDegradedRestore("read", { command: "cat" })).toBe(false);
    expect(p.allowsDegradedRestore("bash", { command: "cat" })).toBe(false);
    expect(p.allowsDegradedRestore("unknown", {})).toBe(false);
  });
});
