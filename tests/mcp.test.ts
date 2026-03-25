import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isPathInsideBase } from "../src/utils/path-security.js";
import { createMcpServer, serializeDecisionPayload } from "../src/transports/mcp.js";
import type { GuardDecisionResult } from "../src/decision/model.js";

describe("serializeDecisionPayload", () => {
  it("includes decision fields and backward-compatible safe=false", () => {
    const result: GuardDecisionResult = {
      decision: "CONFIRM",
      riskLevel: "HIGH",
      summary: "unsafe",
      findings: [{ type: "API_KEY", severity: "HIGH", preview: "sk-****ab" }],
      recommendedAction: "CANCEL",
    };
    const payload = serializeDecisionPayload({ label: "config.ts", content: "sk-abcdefghij1234567890abcde", result });
    expect(payload.safe).toBe(false);
    expect(payload.decision).toBe("CONFIRM");
    expect(payload.riskLevel).toBe("HIGH");
    expect(payload.recommendedAction).toBe("CANCEL");
    expect(payload.label).toBe("config.ts");
  });

  it("ALLOW result has safe=true", () => {
    const result: GuardDecisionResult = {
      decision: "ALLOW",
      riskLevel: "LOW",
      summary: "✅ safe",
      findings: [],
      recommendedAction: "CONTINUE",
    };
    const payload = serializeDecisionPayload({ label: "clean.ts", content: "safe text", result });
    expect(payload.safe).toBe(true);
    expect(payload.decision).toBe("ALLOW");
  });

  it("WARN result has safe=false", () => {
    const result: GuardDecisionResult = {
      decision: "WARN",
      riskLevel: "LOW",
      summary: "low risk",
      findings: [{ type: "PII_PHONE_INTL", severity: "LOW", preview: "****" }],
      recommendedAction: "CONTINUE",
    };
    const payload = serializeDecisionPayload({ label: "data.txt", content: "+1234567890", result });
    expect(payload.safe).toBe(false);
    expect(payload.decision).toBe("WARN");
  });

  it("does not expose raw match_text in the payload", () => {
    const result: GuardDecisionResult = {
      decision: "CONFIRM",
      riskLevel: "HIGH",
      summary: "unsafe",
      findings: [{ type: "API_KEY", severity: "HIGH", preview: "****" }],
      recommendedAction: "CANCEL",
    };
    const payload = serializeDecisionPayload({ label: "test", content: "sk-secret", result });
    const str = JSON.stringify(payload);
    expect(str).not.toContain("sk-secret");
  });

  it("includes redactedContent when present in result", () => {
    const result: GuardDecisionResult = {
      decision: "CONFIRM",
      riskLevel: "HIGH",
      summary: "unsafe",
      findings: [{ type: "API_KEY", severity: "HIGH", preview: "****" }],
      recommendedAction: "CANCEL",
      redactedContent: "const key = '[REDACTED_API_KEY]';",
    };
    const payload = serializeDecisionPayload({ label: "test", content: "original", result });
    expect(payload.redactedContent).toBe("const key = '[REDACTED_API_KEY]';");
  });
});

describe("scan_text — isError behavior", () => {
  it("CONFIRM returns isError: true", async () => {
    const server = createMcpServer();
    // @ts-expect-error — internal tool handler
    const handler = server._registeredTools?.["scan_text"]?.callback;
    if (!handler) return;
    const result = await handler({ content: "sk-abcdefghij1234567890abcde", label: "test" });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[1].text);
    expect(parsed.decision).toBe("CONFIRM");
    expect(parsed.safe).toBe(false);
  });

  it("ALLOW returns isError: false (no isError field)", async () => {
    const server = createMcpServer();
    // @ts-expect-error — internal tool handler
    const handler = server._registeredTools?.["scan_text"]?.callback;
    if (!handler) return;
    const result = await handler({ content: "hello world", label: "test" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.decision).toBe("ALLOW");
  });

  it("CONFIRM card text contains action options", async () => {
    const server = createMcpServer();
    // @ts-expect-error — internal tool handler
    const handler = server._registeredTools?.["scan_text"]?.callback;
    if (!handler) return;
    const result = await handler({ content: "sk-abcdefghij1234567890abcde", label: "secret.ts" });
    expect(result.isError).toBe(true);
    const card = result.content[0].text as string;
    expect(card).toContain("cancel");
    expect(card).toContain("send redacted");
    expect(card).toContain("send original anyway");
    expect(card).not.toContain("sk-abcdefghij");
  });
});

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
