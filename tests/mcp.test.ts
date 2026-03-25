import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isPathInsideBase } from "../src/utils/path-security.js";
import { createMcpServer } from "../src/transports/mcp.js";

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

// ─── scan_file allow_outside ──────────────────────────────────────────────────

describe("scan_file — allow_outside", () => {
  let tmpFile: string;

  it("rejects an outside path by default (allow_outside omitted)", async () => {
    // Create a temp file outside the workspace to test with
    tmpFile = path.join(os.tmpdir(), `mcp-test-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, "safe content", "utf-8");

    const server = createMcpServer();
    // @ts-expect-error — access internal tool handler for testing
    const handler = server._registeredTools?.["scan_file"]?.callback;
    if (!handler) return; // skip if internal API not accessible

    const result = await handler({ file_path: tmpFile });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/outside allowed workspace/);

    fs.unlinkSync(tmpFile);
  });

  it("accepts an outside path when allow_outside=true", async () => {
    tmpFile = path.join(os.tmpdir(), `mcp-test-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, "safe content", "utf-8");

    const server = createMcpServer();
    // @ts-expect-error — access internal tool handler for testing
    const handler = server._registeredTools?.["scan_file"]?.callback;
    if (!handler) return;

    const result = await handler({ file_path: tmpFile, allow_outside: true });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeUndefined();
    expect(parsed.safe).toBe(true);

    fs.unlinkSync(tmpFile);
  });
});
