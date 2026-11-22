/**
 * Host tool policy boundary for the shared guard core (PR #95).
 *
 * Component under test: `createGuardCore(...).onToolBefore`, called directly.
 * One core is built without a `HostToolPolicy` and one with the OpenCode
 * policy; nothing goes through the plugin hooks and nothing touches the
 * filesystem. Host ordering (that a refused call never runs) belongs to the
 * E2E runners under `scripts/e2e/`.
 *
 * Fixture rule: this file never contains a complete placeholder literal. Each
 * marker is minted inside the test by protecting a request that holds a
 * configured keyword, then read back with a pattern built from
 * `PSEUDONYM_TOKEN_PREFIX_V2`.
 *
 * The control case matters: the policy-wired core must still restore the same
 * mapped value, so the refusal test cannot pass by refusing everything.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createGuardCore, type GuardCore, type HostToolPolicy, type RecordLike } from "../src/core/session-guard.js";
import { PSEUDONYM_TOKEN_PREFIX_V2 } from "../src/decision/pseudonymization.js";
import { opencodeToolPolicy } from "../src/opencode-tool-policy.js";
import type { GuardConfig } from "../src/types.js";

// A configured keyword, not PII.
const MARKER = "acme-internal-codename";

const config: GuardConfig = {
  nda_keywords: [MARKER],
  private_domains: [],
  custom_rules: [],
  settings: {
    max_chars: 200000,
    show_line_numbers: true,
    preview_length: 60,
    encoding_detection: false,
  },
};

const TOKEN_SHAPE = new RegExp(
  `${PSEUDONYM_TOKEN_PREFIX_V2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[A-Z][A-Z_]{0,31}-[a-z]{4}-[a-z]{4}-[a-z]{4}\\]`,
);

const cores: GuardCore[] = [];
afterEach(() => {
  for (const core of cores.splice(0)) core.dispose();
});

function build(policy?: HostToolPolicy): GuardCore {
  const core = createGuardCore(config, "block", true, undefined, {}, policy);
  expect(core).not.toBeNull();
  cores.push(core!);
  return core!;
}

/** Protects a primary request in `sessionID` and returns the marker it minted. */
function mint(core: GuardCore, sessionID: string): string {
  const event: RecordLike = {
    sessionID,
    system: [{ type: "text", text: `system ${MARKER}` }],
    messages: [{ id: "m1", role: "user", content: [{ type: "text", text: `note ${MARKER}` }] }],
    options: {},
  };
  core.protectRequestKind(event, "primary");
  const text = (event.system as Array<{ text: string }>)[0].text;
  expect(text).not.toContain(MARKER);
  const token = TOKEN_SHAPE.exec(text)?.[0];
  expect(token).toBeDefined();
  return token!;
}

describe("host tool restoration boundary", () => {
  it("refuses a mapped marker when no host policy was supplied and leaves the input untouched", () => {
    const core = build();
    const token = mint(core, "ses_nopolicy");
    const input = { code: `console.log(${JSON.stringify(token)})` };

    expect(() => core.onToolBefore({ sessionID: "ses_nopolicy", tool: "execute", input })).toThrow(
      /LeakShield blocked this tool call/,
    );
    expect(input).toEqual({ code: `console.log(${JSON.stringify(token)})` });
  });

  it("refuses without a policy for any tool name, not just Code Mode", () => {
    const core = build();
    const token = mint(core, "ses_nopolicy_read");
    const input = { filePath: `notes/${token}.txt` };

    expect(() => core.onToolBefore({ sessionID: "ses_nopolicy_read", tool: "read", input })).toThrow(
      /LeakShield blocked this tool call/,
    );
    expect(input).toEqual({ filePath: `notes/${token}.txt` });
  });

  it("still lets a token-free tool call through without a policy", () => {
    const core = build();
    const input = { filePath: "notes/plain.txt" };
    expect(() => core.onToolBefore({ sessionID: "ses_plain", tool: "read", input })).not.toThrow();
    expect(input).toEqual({ filePath: "notes/plain.txt" });
  });

  it("control: the OpenCode policy restores the same mapped marker", () => {
    const core = build(opencodeToolPolicy);
    const token = mint(core, "ses_opencode");
    const input = { filePath: `notes/${token}.txt` };

    core.onToolBefore({ sessionID: "ses_opencode", tool: "read", input });
    expect(input.filePath).toBe(`notes/${MARKER}.txt`);
  });

  it("OpenCode policy does not grant an unknown tool degraded restoration", () => {
    expect(opencodeToolPolicy.allowsDegradedRestore("external_network_tool", { value: "x" })).toBe(false);
  });
});
