import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Part } from "@opencode-ai/sdk";
import sensitiveGuardPlugin, * as pluginModule from "../src/opencode.js";

const secret = "sk-12345678901234567890";
const temporaryDirectories: string[] = [];
const exactSecret = "unclassified-opaque-value-987654321";

function textPart(text: string): Part {
  return {
    id: "part-1",
    sessionID: "session-1",
    messageID: "message-1",
    type: "text",
    text,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenCode plugin entry", () => {
  it("exports only one plugin factory for the OpenCode legacy loader", () => {
    expect(Object.keys(pluginModule)).toEqual(["default"]);
  });

  it("removes sensitive content before constructing a provider payload", async () => {
    const hooks = await sensitiveGuardPlugin({} as never, { mode: "block" });
    const parts = [textPart(`token=${secret}`)];

    await hooks["chat.message"]!({ sessionID: "session-1" }, { message: {} as never, parts });
    const providerPayload = JSON.stringify(parts);

    expect(providerPayload).not.toContain(secret);
    expect(providerPayload).toContain("Sensitive Guard blocked message text");
  });

  it("blocks model requests when configuration loading fails", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sensitive-guard-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "invalid.yaml");
    fs.writeFileSync(configPath, "settings:\n  max_chars: invalid\n", "utf8");

    const hooks = await sensitiveGuardPlugin({} as never, { configPath });
    const invokeHook = hooks["chat.message"]!({ sessionID: "session-1" }, {
      message: {} as never,
      parts: [textPart("safe text")],
    });

    await expect(invokeHook).rejects.toThrow("Sensitive Guard initialization failed");
  });

  it("loads configured env_files relative to the OpenCode workspace", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sensitive-guard-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "guard.config.yaml");
    fs.writeFileSync(path.join(directory, ".env"), `TOKEN=${exactSecret}\n`, "utf8");
    fs.writeFileSync(configPath, "settings:\n  env_files:\n    - .env\n", "utf8");

    const hooks = await sensitiveGuardPlugin({ worktree: directory } as never, { configPath });
    const parts = [textPart(`token=${exactSecret}`)];
    await hooks["chat.message"]!({ sessionID: "session-1" }, { message: {} as never, parts });

    expect(JSON.stringify(parts)).not.toContain(exactSecret);
    expect(JSON.stringify(parts)).toContain("Sensitive Guard blocked message text");
  });

  it("blocks model requests when plugin options are invalid", async () => {
    const hooks = await sensitiveGuardPlugin({} as never, { mode: "unsupported" });

    await expect(hooks["experimental.chat.messages.transform"]!({}, { messages: [] }))
      .rejects.toThrow("Sensitive Guard initialization failed");
  });
});
