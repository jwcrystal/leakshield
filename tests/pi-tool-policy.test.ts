// Component under test: pi's tool restoration policy wired through the shared
// guard core. A real Core mints the placeholders, so the rules here are the
// same ones the proxy enforces at the local tool boundary.
import { describe, expect, it } from "vitest";
import { createGuardCore, type GuardCore } from "../src/core/session-guard.js";
import { PSEUDONYM_TOKEN_PREFIX_V2 } from "../src/decision/pseudonymization.js";
import { assertPiToolBoundary, piToolPolicy } from "../src/pi/tool-policy.js";
import { loadConfig } from "../src/config/loader.js";

const SESSION = "pi-session-1";
const TOKEN = new RegExp(`${PSEUDONYM_TOKEN_PREFIX_V2.replace(/[[\]]/g, "\\$&")}[^\\]]+\\]`);

function coreWith(ndaKeywords: string[]): GuardCore {
  const config = loadConfig(undefined, process.cwd());
  const core = createGuardCore(
    { ...config, nda_keywords: ndaKeywords, private_domains: [], custom_rules: [] },
    "block",
    true,
    undefined,
    {},
    piToolPolicy,
  );
  if (core === null) throw new Error("core init failed");
  return core;
}

async function mint(core: GuardCore, text: string): Promise<string> {
  const event: Record<string, unknown> = {
    sessionID: SESSION,
    request: new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: text }] }),
    }),
  };
  await core.onHttpRequest(event);
  const body = (await (event.request as Request).json()) as {
    messages: Array<{ content: string }>;
  };
  const token = TOKEN.exec(body.messages[0]?.content ?? "")?.[0];
  if (token === undefined) throw new Error("no placeholder minted");
  return token;
}

/** A well-formed token this core never issued (a different Core minted it). */
async function staleToken(): Promise<string> {
  const other = coreWith(["PI_OTHER_SECRET"]);
  return mint(other, "value PI_OTHER_SECRET here");
}

function restore(core: GuardCore, tool: string, input: unknown): unknown {
  const event: Record<string, unknown> = { sessionID: SESSION, tool, input };
  core.onToolBefore(event);
  return event.input;
}

describe("pi tool policy", () => {
  it("restores a read path and a write payload", async () => {
    const core = coreWith(["PI_TEST_SECRET"]);
    const token = await mint(core, "use PI_TEST_SECRET here");

    expect(restore(core, "read", { path: `${token}.txt` })).toEqual({ path: "PI_TEST_SECRET.txt" });
    expect(restore(core, "write", { path: "out.txt", content: `value=${token}` })).toEqual({
      path: "out.txt",
      content: "value=PI_TEST_SECRET",
    });
  });

  it("restores edit replacements, including nested arrays", async () => {
    const core = coreWith(["PI_TEST_SECRET"]);
    const token = await mint(core, "use PI_TEST_SECRET here");
    expect(
      restore(core, "edit", {
        path: "file.txt",
        edits: [
          { oldText: "a", newText: token },
          { oldText: "b", newText: `x ${token}` },
        ],
      }),
    ).toEqual({
      path: "file.txt",
      edits: [
        { oldText: "a", newText: "PI_TEST_SECRET" },
        { oldText: "b", newText: "x PI_TEST_SECRET" },
      ],
    });
  });

  it("restores a shell argument only when the original is safe in that position", async () => {
    const core = coreWith(["PI_TEST_SECRET"]);
    const token = await mint(core, "use PI_TEST_SECRET here");
    expect(restore(core, "bash", { command: `cat ${token}` })).toEqual({ command: "cat PI_TEST_SECRET" });

    // The placeholder is embedded inside a longer word, so the shell meaning
    // would change after restoration.
    expect(() => restore(core, "bash", { command: `cat ${token}.txt` })).toThrow();
    // Command position and option injection are refused too.
    expect(() => restore(core, "bash", { command: `${token} --help` })).toThrow();
    expect(() => restore(core, "bash", { command: `cat --file=${token}` })).toThrow();
  });

  it("refuses shell restoration when the original has shell metacharacters", async () => {
    const core = coreWith(["PI TWO"]);
    const token = await mint(core, "value PI TWO here");
    expect(() => restore(core, "bash", { command: `cat ${token}` })).toThrow();
  });

  it("refuses token-bearing calls for unknown and write tools when the mapping is missing", async () => {
    const core = coreWith(["PI_TEST_SECRET"]);
    const stale = await staleToken();
    expect(() => restore(core, "mcp__remote__send", { message: stale })).toThrow();
    expect(() => restore(core, "write", { path: "a.txt", content: stale })).toThrow();
    expect(() => restore(core, "bash", { command: `cat ${stale}` })).toThrow();
  });

  it("allows a read-only tool to keep an unresolved placeholder literal", async () => {
    const core = coreWith(["PI_TEST_SECRET"]);
    const stale = await staleToken();
    expect(restore(core, "read", { path: `${stale}.txt` })).toEqual({ path: `${stale}.txt` });
  });

  it("treats powershell as a shell tool", async () => {
    const core = coreWith(["PI_TEST_SECRET"]);
    const token = await mint(core, "use PI_TEST_SECRET here");
    expect(restore(core, "powershell", { command: `type ${token}` })).toEqual({ command: "type PI_TEST_SECRET" });
    expect(() => restore(core, "powershell", { command: `${token}; rm -rf /` })).toThrow();
  });

  it("refuses placeholders for unknown tools before the core sees them", async () => {
    const core = coreWith(["PI_TEST_SECRET"]);
    const token = await mint(core, "use PI_TEST_SECRET here");
    expect(() => assertPiToolBoundary("mcp__remote__send", { text: token })).toThrow("not a known pi built-in");
    expect(() => assertPiToolBoundary("read", { path: token })).not.toThrow();
    expect(() => assertPiToolBoundary("mcp__remote__send", { text: "no placeholder" })).not.toThrow();
  });
});
