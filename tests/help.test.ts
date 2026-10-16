import { describe, it, expect } from "vitest";
import { HELP_TEXT, isHelpRequest } from "../src/help.js";

describe("CLI help", () => {
  it("recognises --help and -h", () => {
    expect(isHelpRequest(["node", "cli.js", "--help"])).toBe(true);
    expect(isHelpRequest(["node", "cli.js", "--cli", "-h"])).toBe(true);
    expect(isHelpRequest(["node", "cli.js", "--cli", "--text", "hello"])).toBe(false);
  });

  it("documents every flag the entry points parse", () => {
    const flags = [
      "--cli", "--web", "--port", "--doctor", "--forget", "--all", "--session", "--path",
      "--text", "--file", "--dir", "--ext", "--stdin", "--allow-outside",
      "--format", "--min-severity", "--enable-encoding-detection",
      "--redact", "--out", "--dry-run",
    ];
    for (const flag of flags) expect(HELP_TEXT).toContain(flag);
  });
});
