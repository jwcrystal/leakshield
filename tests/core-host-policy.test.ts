import { describe, expect, it } from "vitest";
import { createGuardCore } from "../src/core/session-guard.js";
import { loadConfig } from "../src/config/loader.js";
import { opencodeToolPolicy } from "../src/opencode-tool-policy.js";

const config = loadConfig(undefined, process.cwd());

describe("host tool restoration boundary", () => {
  it("refuses token-bearing tools when no host policy has been supplied", () => {
    const core = createGuardCore(config);
    expect(core).not.toBeNull();
    try {
      expect(() => core!.onToolBefore({ sessionID: "session", tool: "execute", input: { code: "echo [SGP2:API_KEY:00000001]" } })).toThrow(/LeakShield blocked this tool call/);
    } finally {
      core?.dispose();
    }
  });
  it("OpenCode policy does not grant an unknown tool degraded restoration", () => {
    expect(opencodeToolPolicy.allowsDegradedRestore("external_network_tool", { value: "x" })).toBe(false);
  });
});
