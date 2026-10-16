import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The v1 SDK tool helper is a runtime dependency of the opt-in env query
// tools (`envQueries`). Simulate the published-package failure mode where the
// module cannot be resolved at all at runtime.
vi.mock("@opencode-ai/plugin/tool", () => {
  throw new Error("simulated missing v1 SDK module");
});

import leakshieldPlugin from "../src/opencode.js";

const secret = "sk-12345678901234567890";

describe("v1 server — env query tool import failure", () => {
  it("keeps the full protection hooks; only the optional feature fails", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "leakshield-imp-"));
    const configPath = path.join(directory, "guard.config.yaml");
    fs.writeFileSync(path.join(directory, ".env"), `API_TOKEN=${secret}\n`, "utf8");
    fs.writeFileSync(configPath, "settings:\n  env_files:\n    - .env\n", "utf8");
    try {
      const hooks = await leakshieldPlugin.server(
        { worktree: directory } as never,
        { configPath, envQueries: true },
      );

      // The env tools are simply absent...
      expect(hooks.tool).toBeUndefined();

      // ...but the protection hooks are the fully armed set, not fail-closed
      // stubs: a sensitive message is still blocked (fail-closed hooks would
      // instead reject with an initialization error).
      const parts = [
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "message-1",
          type: "text",
          text: `token=${secret}`,
        },
      ];
      await hooks["chat.message"]!({ sessionID: "session-1" } as never, {
        message: {} as never,
        parts,
      });
      const serialized = JSON.stringify(parts);
      expect(serialized).not.toContain(secret);
      expect(serialized).toContain("LeakShield blocked message text");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
