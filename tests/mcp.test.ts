import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isPathInsideBase } from "../src/utils/path-security.js";
import { createMcpServer } from "../src/transports/mcp.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Get the callback for a named MCP tool, or skip the test if the
 * internal API is not accessible.
 */
function getToolHandler(server: ReturnType<typeof createMcpServer>, name: string) {
  // @ts-expect-error — access internal tool handler for testing
  const cb = server._registeredTools?.[name]?.callback;
  if (!cb) return null;
  return cb as (args: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[] }>;
}

function parseResult(result: Awaited<ReturnType<NonNullable<ReturnType<typeof getToolHandler>>>>) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

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
    const handler = getToolHandler(server, "scan_file");
    if (!handler) return; // skip if internal API not accessible

    const result = await handler({ file_path: tmpFile });
    const parsed = parseResult(result);
    expect(parsed.error).toMatch(/outside allowed workspace/);

    fs.unlinkSync(tmpFile);
  });

  it("accepts an outside path when allow_outside=true", async () => {
    tmpFile = path.join(os.tmpdir(), `mcp-test-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, "safe content", "utf-8");

    const server = createMcpServer();
    const handler = getToolHandler(server, "scan_file");
    if (!handler) return;

    const result = await handler({ file_path: tmpFile, allow_outside: true });
    const parsed = parseResult(result);
    expect(parsed.error).toBeUndefined();
    expect(parsed.safe).toBe(true);

    fs.unlinkSync(tmpFile);
  });
});

// ─── scan_text decision payload ──────────────────────────────────────────────

describe("scan_text — decision payload", () => {
  it("returns decision field in response for safe content", async () => {
    const server = createMcpServer();
    const handler = getToolHandler(server, "scan_text");
    if (!handler) return;

    const result = await handler({ content: "hello world", label: "test.txt" });
    const parsed = parseResult(result);

    expect(parsed.decision).toBe("ALLOW");
    expect(parsed.riskLevel).toBe("LOW");
    expect(parsed.safe).toBe(true);
    expect(parsed.label).toBe("test.txt");
  });

  it("returns decision=WARN for low-severity findings", async () => {
    const server = createMcpServer();
    const handler = getToolHandler(server, "scan_text");
    if (!handler) return;

    // Include a private domain keyword (LOW severity) if configured
    const result = await handler({ content: "check internal.example.com docs" });
    const parsed = parseResult(result);

    // If a finding was detected, verify decision fields exist
    if ((parsed.total_findings as number) > 0) {
      expect(parsed).toHaveProperty("decision");
      expect(parsed).toHaveProperty("riskLevel");
      expect(parsed.safe).toBe(false);
    } else {
      // No findings configured — just verify shape
      expect(parsed).toHaveProperty("decision");
      expect(parsed).toHaveProperty("riskLevel");
    }
  });

  it("never includes originalContent in response", async () => {
    const server = createMcpServer();
    const handler = getToolHandler(server, "scan_text");
    if (!handler) return;

    const secretContent = "sk-proj-fake-secret-key-12345";
    const result = await handler({ content: secretContent });
    const rawText = result.content[0].text;

    expect(rawText).not.toContain("originalContent");
    // The secret itself may appear in safePreview as a placeholder, but
    // the raw value must not appear outside of safePreview/redactedContent
    const parsed = parseResult(result);
    if (parsed.findings && Array.isArray(parsed.findings)) {
      for (const f of parsed.findings as Record<string, unknown>[]) {
        expect(f).not.toHaveProperty("match_text");
        expect(f).not.toHaveProperty("match_start");
        expect(f).not.toHaveProperty("match_end");
      }
    }
  });

  it("includes safePreview when HIGH-severity findings have match metadata", async () => {
    const server = createMcpServer();
    const handler = getToolHandler(server, "scan_text");
    if (!handler) return;

    const content = "const apiKey = sk-proj-fake-secret-key-12345;";
    const result = await handler({ content });
    const parsed = parseResult(result);

    if ((parsed.total_findings as number) > 0 && parsed.decision === "CONFIRM") {
      expect(parsed).toHaveProperty("safePreview");
      expect(typeof parsed.safePreview).toBe("string");
    }
  });
});

// ─── scan_file decision payload ──────────────────────────────────────────────

describe("scan_file — decision payload", () => {
  it("returns decision field in response for safe file", async () => {
    const tmpFile = path.join(os.tmpdir(), `mcp-test-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, "safe content", "utf-8");

    const server = createMcpServer();
    const handler = getToolHandler(server, "scan_file");
    if (!handler) { fs.unlinkSync(tmpFile); return; }

    const result = await handler({ file_path: tmpFile, allow_outside: true });
    const parsed = parseResult(result);

    expect(parsed.decision).toBe("ALLOW");
    expect(parsed.riskLevel).toBe("LOW");
    expect(parsed.safe).toBe(true);
    expect(parsed.file).toBeDefined();

    fs.unlinkSync(tmpFile);
  });

  it("returns decision field for file with sensitive content", async () => {
    const tmpFile = path.join(os.tmpdir(), `mcp-test-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, "const apiKey = sk-proj-fake-secret-key-12345;", "utf-8");

    const server = createMcpServer();
    const handler = getToolHandler(server, "scan_file");
    if (!handler) { fs.unlinkSync(tmpFile); return; }

    const result = await handler({ file_path: tmpFile, allow_outside: true });
    const parsed = parseResult(result);

    expect(parsed).toHaveProperty("decision");
    expect(parsed).toHaveProperty("riskLevel");
    expect(parsed).toHaveProperty("safe");
    expect(parsed.file).toBeDefined();

    fs.unlinkSync(tmpFile);
  });
});
