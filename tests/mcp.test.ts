import { describe, expect, it } from "vitest";
import { isPathInsideBase } from "../src/utils/path-security.js";

describe("isPathInsideBase()", () => {
  it("accepts files inside base directory", () => {
    expect(isPathInsideBase("/repo", "/repo/src/index.ts")).toBe(true);
  });

  it("accepts the base directory itself", () => {
    expect(isPathInsideBase("/repo", "/repo")).toBe(true);
  });

  it("rejects paths outside base directory", () => {
    expect(isPathInsideBase("/repo", "/etc/passwd")).toBe(false);
  });

  it("rejects path traversal via ..", () => {
    expect(isPathInsideBase("/repo", "/repo/../etc/passwd")).toBe(false);
  });

  it("rejects sibling directories", () => {
    expect(isPathInsideBase("/repo", "/other-repo/file.ts")).toBe(false);
  });

  it("accepts deeply nested paths", () => {
    expect(isPathInsideBase("/repo", "/repo/a/b/c/d/file.ts")).toBe(true);
  });
});
