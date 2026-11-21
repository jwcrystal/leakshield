// Component under test: the Anthropic Messages request masker in
// src/core/wire.ts, driven through createGuardCore's HTTP request handler.
import { describe, expect, it } from "vitest";
import { createGuardCore } from "../src/core/session-guard.js";
import { loadConfig } from "../src/config/loader.js";

const CANARY = "sk-proj-Q7vR2mX9pL4kT8wN3zB6yH1cF5dJ0sGa";
// A signature whose base64 happens to contain a detector hit: it must still
// cross verbatim, or the provider rejects the whole history.
const SIGNATURE = `RXN0${CANARY}Zm9v`;
const REDACTED = `ZW5j${CANARY}cnlwdA==`;

function request(content: unknown[]): Request {
  return new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-test",
      max_tokens: 8,
      messages: [
        { role: "user", content: [{ type: "text", text: `key ${CANARY}` }] },
        { role: "assistant", content },
        { role: "user", content: [{ type: "text", text: "go on" }] },
      ],
    }),
  });
}

function core(anthropicThinking?: "refuse" | "mask") {
  const created = createGuardCore(loadConfig(undefined, process.cwd()), "block", true, undefined,
    anthropicThinking === undefined ? undefined : { anthropicThinking });
  if (created === null) throw new Error("core unavailable");
  return created;
}

const thinkingHistory = [
  { type: "thinking", thinking: `the user key is ${CANARY}`, signature: SIGNATURE },
  { type: "redacted_thinking", data: REDACTED },
  { type: "text", text: "ok" },
];

describe("Anthropic thinking blocks at the wire", () => {
  it("refuses thinking history by default", async () => {
    const event: Record<string, unknown> = { sessionID: "s", request: request(thinkingHistory) };
    await expect(core().onHttpRequest(event)).rejects.toThrow(/anthropic-content-block-type/);
  });

  it("masks thinking text and keeps signature and redacted data verbatim when opted in", async () => {
    const guard = core("mask");
    const event: Record<string, unknown> = { sessionID: "s", request: request(thinkingHistory) };
    await guard.onHttpRequest(event);
    const body = JSON.parse(await (event.request as Request).text());
    const assistant = body.messages[1].content;
    expect(assistant[0].thinking).not.toContain(CANARY);
    expect(assistant[0].thinking).toMatch(/\[SGP2:/);
    expect(assistant[0].signature).toBe(SIGNATURE);
    expect(assistant[1].data).toBe(REDACTED);
    expect(body.messages[0].content[0].text).not.toContain(CANARY);
  });

  it("still refuses a malformed thinking block when opted in", async () => {
    const event: Record<string, unknown> = {
      sessionID: "s",
      request: request([{ type: "thinking", thinking: 42 }]),
    };
    await expect(core("mask").onHttpRequest(event)).rejects.toThrow(/anthropic-thinking-block/);
  });

  it("keeps refusing other unknown block types when opted in", async () => {
    const event: Record<string, unknown> = {
      sessionID: "s",
      request: request([{ type: "server_tool_use", id: "x", name: "web_search", input: {} }]),
    };
    await expect(core("mask").onHttpRequest(event)).rejects.toThrow(/anthropic-content-block-type/);
  });
});
