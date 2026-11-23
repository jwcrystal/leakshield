/**
 * Chat Completions wire-dialect tests for schema annotation prose.
 *
 * Offline mocks only: drives the guard's http.request hook with an
 * OpenAI-compatible body whose tool schema carries a scanner keyword in an
 * annotation (description) versus an identifier (property key) position.
 * Secrets are synthetic; no network or OpenCode runtime is involved.
 */

import { describe, expect, it } from "vitest";
import { createTransparentSessionGuard } from "../src/adapters/opencode/opencode-transparent.js";
import type { GuardConfig } from "../src/types.js";

const baseConfig: GuardConfig = {
  nda_keywords: ["secrets"],
  private_domains: [],
  custom_rules: [],
  settings: {
    max_chars: 200000,
    show_line_numbers: true,
    preview_length: 60,
    encoding_detection: true,
  },
};

const TOKEN_RE = /\[SGP1:[0-9a-f]{32}-\d{8,12}\]|\[SGP2:[A-Z][A-Z_]{0,31}-[a-z]{4}-[a-z]{4}-[a-z]{4}\]/;
const UNSUPPORTED_REQUEST_BODY =
  "LeakShield blocked the request because its body is unsupported or could not be identified.";

interface RecordedHook {
  domain: string;
  name: string;
  callback: (event: unknown) => unknown;
}

async function arm(config: GuardConfig = baseConfig, attachmentsPolicy: "block" | "allow" = "block") {
  const registered: RecordedHook[] = [];
  const hookFor = (domain: string) => {
    return async (name: string, callback: unknown) => {
      registered.push({ domain, name, callback: callback as (event: unknown) => unknown });
      return { dispose: () => undefined };
    };
  };
  const ctx = {
    session: { hook: hookFor("session") },
    aisdk: { hook: hookFor("aisdk") },
    tool: { hook: hookFor("tool") },
  };
  const guard = createTransparentSessionGuard(config, attachmentsPolicy);
  await guard.setup(ctx as never);
  const hook = (name: string) => {
    const record = registered.find((r) => `${r.domain}:${r.name}` === name);
    if (!record) throw new Error(`hook ${name} not registered`);
    return async (event: unknown) => record.callback(event);
  };
  return { guard, registered, hook };
}

function chatCompletionsRequest(body: unknown): Request {
  return new Request("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function wire(
  hook: (name: string) => (event: unknown) => Promise<unknown> | unknown,
  body: unknown,
  sessionID = "session-1",
): Promise<Record<string, unknown>> {
  const event = { sessionID, kind: "primary", request: chatCompletionsRequest(body) };
  await hook("session:http.request")(event);
  return JSON.parse(await (event.request as Request).clone().text()) as Record<string, unknown>;
}

describe("chat-completions tool schema annotations on the wire", () => {
  it("masks a description VALUE in fn.parameters (request passes)", async () => {
    const { hook } = await arm();
    const body = await wire(hook, {
      model: "gpt-test",
      messages: [{ role: "user", content: "scan the directory" }],
      tools: [
        {
          type: "function",
          function: {
            name: "vault_scanner",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Detects hardcoded secrets" },
              },
              required: ["path"],
            },
          },
        },
      ],
    });

    const tool = (body.tools as Array<{ function: { name: string; parameters: Record<string, unknown> } }>)[0];
    expect(tool.function.name).toBe("vault_scanner");
    const properties = tool.function.parameters.properties as Record<
      string,
      { type: string; description: string }
    >;
    expect(properties.path.type).toBe("string");
    expect(properties.path.description).toMatch(TOKEN_RE);
    expect(properties.path.description).not.toContain("secrets");
  });

  it("still refuses when a property KEY in fn.parameters is the sensitive word itself", async () => {
    const { hook } = await arm();
    const body = {
      model: "gpt-test",
      messages: [{ role: "user", content: "scan the directory" }],
      tools: [
        {
          type: "function",
          function: {
            name: "vault_scanner",
            parameters: {
              type: "object",
              // P2 word-boundary narrowing: the key must BE the keyword —
              // compound keys like「secrets_path」no longer refuse.
              properties: { secrets: { type: "string" } },
            },
          },
        },
      ],
    };
    const event = { sessionID: "session-1", kind: "primary", request: chatCompletionsRequest(body) };
    await expect(hook("session:http.request")(event)).rejects.toThrow(UNSUPPORTED_REQUEST_BODY);
  });
});

describe("chat-completions attachments allow: wire image format", () => {
  const imageBody = {
    model: "gpt-test",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this picture" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
        ],
      },
    ],
  };

  it("allow passes image_url parts through unscanned", async () => {
    const { hook } = await arm(baseConfig, "allow");
    const body = await wire(hook, imageBody);
    const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe("text");
    expect(content[1].type).toBe("image_url");
    expect(JSON.stringify(content[1])).toContain("aGVsbG8=");
  });

  it("block still refuses image_url parts", async () => {
    const { hook } = await arm(baseConfig, "block");
    const event = { sessionID: "session-1", kind: "primary", request: chatCompletionsRequest(imageBody) };
    await expect(hook("session:http.request")(event)).rejects.toThrow(UNSUPPORTED_REQUEST_BODY);
  });
});
