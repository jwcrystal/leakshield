/** Host boundary regression: no tool restoration without an explicit host policy.
 * Markers are minted via model-request protection rather than written as literals.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createGuardCore, type GuardCore, type HostToolPolicy } from "../src/core/session-guard.js";
import { opencodeToolPolicy } from "../src/opencode-tool-policy.js";
import { PSEUDONYM_TOKEN_PREFIX_V2 } from "../src/decision/pseudonymization.js";
import type { GuardConfig } from "../src/types.js";

const SENSITIVE = "fictional-private-project-word";
const settings: GuardConfig = {
  nda_keywords: [SENSITIVE],
  private_domains: [],
  custom_rules: [],
  settings: { max_chars: 200000, show_line_numbers: true, preview_length: 60, encoding_detection: false },
};
const active: GuardCore[] = [];
afterEach(() => { while (active.length) active.pop()!.dispose(); });

function guard(withPolicy: boolean): GuardCore {
  const built = createGuardCore(settings, "block", true, undefined, {}, withPolicy ? opencodeToolPolicy : undefined);
  expect(built).not.toBeNull();
  active.push(built!);
  return built!;
}

function issuedToken(core: GuardCore, sessionID: string): string {
  const event = {
    sessionID,
    system: [{ type: "text", text: SENSITIVE }],
    messages: [{ id: "m1", role: "user", content: [{ type: "text", text: SENSITIVE }] }],
    options: {},
  };
  core.protectRequestKind(event, "primary");
  const protectedText = event.system[0].text;
  expect(protectedText).not.toContain(SENSITIVE);
  // Match the generated marker shape without embedding a complete marker literal.
  const token = protectedText.match(/\[[A-Za-z0-9:_-]+\]/)?.[0];
  expect(token).toBeDefined();
  expect(token!.startsWith(PSEUDONYM_TOKEN_PREFIX_V2)).toBe(true);
  return token!;
}

describe("explicit host tool policy boundary", () => {
  it("refuses a mapped marker and preserves its input when no policy is provided", () => {
    const core = guard(false);
    const token = issuedToken(core, "session_without_policy");
    const input = { filePath: `notes/${token}.txt` };
    const before = input.filePath;
    expect(() => core.onToolBefore({ sessionID: "session_without_policy", tool: "read", input })).toThrow(/LeakShield blocked this tool call/);
    expect(input.filePath).toBe(before);
  });

  it("refuses a modified marker for the same session without a policy", () => {
    const core = guard(false);
    const token = issuedToken(core, "session_near_miss");
    const modified = token.slice(1);
    const input = { filePath: modified };
    expect(() => core.onToolBefore({ sessionID: "session_near_miss", tool: "read", input })).toThrow(/LeakShield blocked this tool call/);
    expect(input.filePath).toBe(modified);
  });

  it("allows an unchanged token-free tool event", () => {
    const core = guard(false);
    const input = { filePath: "notes/ordinary.txt" };
    expect(() => core.onToolBefore({ sessionID: "plain", tool: "read", input })).not.toThrow();
    expect(input.filePath).toBe("notes/ordinary.txt");
  });

  it("still restores a minted marker when explicitly using the OpenCode policy", () => {
    const core = guard(true);
    const token = issuedToken(core, "session_with_policy");
    const input = { filePath: token };
    core.onToolBefore({ sessionID: "session_with_policy", tool: "read", input });
    expect(input.filePath).toBe(SENSITIVE);
  });

  it("hands the host policy the tool name exactly as the host sent it", () => {
    const seen: string[] = [];
    const spy: HostToolPolicy = {
      ...opencodeToolPolicy,
      allowsDegradedRestore(rawTool, input) {
        seen.push(rawTool);
        return opencodeToolPolicy.allowsDegradedRestore(rawTool, input);
      },
    };
    const core = createGuardCore(settings, "block", true, undefined, {}, spy);
    expect(core).not.toBeNull();
    active.push(core!);
    const token = issuedToken(core!, "session_raw_name");
    // Lowercasing first would turn "runShell" into "runshell" and hide the
    // "shell" segment from camelCase-aware classification. The call itself may
    // be refused (a shell tool gets the stricter shell check); only the name
    // the policy saw is asserted.
    try {
      core!.onToolBefore({ sessionID: "session_raw_name", tool: "runShell", input: { path: `notes/${token}.txt` } });
    } catch {
      // expected for shell-classified tools
    }
    expect(seen).toEqual(["runShell"]);
  });

  it("matches OpenCode read-only tools case-insensitively", () => {
    expect(opencodeToolPolicy.allowsDegradedRestore("Read", { filePath: "a" })).toBe(true);
  });

  it("never treats an unknown tool as a proven read-only tool", () => {
    expect(opencodeToolPolicy.allowsDegradedRestore("unknown_network_tool", { path: "file" })).toBe(false);
  });
});
