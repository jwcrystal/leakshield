// Component under test: the Claude Code proxy command (src/adapters/claude-code/cli.ts),
// before it listens. A --config path that does not exist must stop the proxy.
import { afterEach, describe, expect, it, vi } from "vitest";
import { runClaudeCodeProxy } from "../src/adapters/claude-code/cli.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Claude Code proxy --config", () => {
  it("exits 1 without listening when --config names a missing file", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runClaudeCodeProxy([
      "node", "cli.js", "--claude-code-proxy", "--port", "0", "--config", "/nonexistent/leakshield-proxy.yaml",
    ]);

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("guard config file not found: /nonexistent/leakshield-proxy.yaml");
    expect(log).not.toHaveBeenCalled();
  });
});
