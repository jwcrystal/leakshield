// Drive the same Anthropic wire payload through each production adapter boundary.
import { describe, expect, it } from "vitest";
import { createClaudeCodeProxy } from "../src/adapters/claude-code/proxy.js";
import { createTransparentSessionGuard } from "../src/adapters/opencode/transparent.js";
import { createPiGuard } from "../src/adapters/pi/guard.js";
import { loadConfig } from "../src/config/loader.js";

const canaries = ["LEAKSHIELD_MATRIX_PROJECT", "LEAKSHIELD_MATRIX_CUSTOMER"];
const combined = canaries.join(" and ");
const config = {
  ...loadConfig(undefined, process.cwd()),
  nda_keywords: canaries,
  private_domains: [],
  custom_rules: [],
};
const tokenPattern = /\[SGP2:[A-Z_]+-[a-z]{4}-[a-z]{4}-[a-z]{4}\]/g;
const endpoint = "https://api.anthropic.com/v1/messages";

function payload(text: string) {
  return {
    model: "claude-test",
    max_tokens: 64,
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  };
}

function request(sessionID: string, text: string, url = endpoint, malformed = false) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-claude-code-session-id": sessionID,
      "x-api-key": "synthetic-fixture",
    },
    body: malformed ? `{"messages":[${text}` : JSON.stringify(payload(text)),
  });
}

function recordingProvider() {
  const sent: string[] = [];
  let nextStatus = 200;
  let reply: string | undefined;
  return {
    sent,
    failNext: () => { nextStatus = 500; },
    replyWith: (text: string) => { reply = text; },
    fetch: async (input: Request) => {
      const body = await input.text();
      sent.push(body);
      const status = nextStatus;
      nextStatus = 200;
      if (status !== 200) return Response.json({ error: "synthetic failure" }, { status });
      const content = reply ?? (body.match(tokenPattern) ?? []).join(" and ");
      reply = undefined;
      return Response.json({
        id: "msg_matrix", type: "message", role: "assistant", model: "claude-test",
        content: [{ type: "text", text: content }],
      });
    },
  };
}

type Provider = ReturnType<typeof recordingProvider>;
type Send = (sessionID: string, text: string, kind?: "primary" | "compaction" | "malformed") => Promise<Response>;

const adapters: Record<string, (provider: Provider) => Promise<{ send: Send; dispose?: () => void | Promise<void> }>> = {
  "Claude Code proxy": async (provider) => {
    const proxy = createClaudeCodeProxy({ config, fetch: provider.fetch as typeof fetch, log: () => {} });
    return {
      send: (sessionID, text, kind) => proxy.handle(request(sessionID, text, "http://127.0.0.1/v1/messages", kind === "malformed")),
      dispose: () => proxy.dispose(),
    };
  },
  "OpenCode HTTP hooks": async (provider) => {
    const hooks = new Map<string, (event: unknown) => unknown>();
    const hookFor = (domain: string) => async (name: string, callback: (event: unknown) => unknown) => {
      hooks.set(`${domain}:${name}`, callback);
      return { dispose: () => {} };
    };
    const guard = createTransparentSessionGuard(config);
    await guard.setup({
      session: { hook: hookFor("session") },
      aisdk: { hook: hookFor("aisdk") },
      tool: { hook: hookFor("tool") },
    } as never);
    const onRequest = hooks.get("session:http.request")!;
    const onResponse = hooks.get("session:http.response")!;
    return {
      send: async (sessionID, text, kind = "primary") => {
        const event = {
          sessionID,
          kind: kind === "compaction" ? kind : "primary",
          request: request(sessionID, text, endpoint, kind === "malformed"),
        };
        try {
          await onRequest(event);
        } catch (error) {
          if (kind !== "malformed") throw error;
          return new Response(null, { status: 400 });
        }
        const reply = { ...event, response: await provider.fetch(event.request) };
        await onResponse(reply);
        return reply.response;
      },
      dispose: () => guard.dispose(),
    };
  },
  "Pi fetch boundary": async (provider) => {
    const guard = createPiGuard({ config, fetchImpl: provider.fetch as typeof fetch });
    guard.setModel({ api: "anthropic-messages", provider: "anthropic", id: "claude-test", baseUrl: "https://api.anthropic.com" });
    return {
      send: (sessionID, text, kind) => {
        guard.setSession(sessionID);
        return guard.handle(request(sessionID, text, endpoint, kind === "malformed"));
      },
    };
  },
};

async function replyText(response: Response) {
  expect(response.status).toBe(200);
  return (await response.json()).content[0].text;
}

describe.each(Object.entries(adapters))("%s protection matrix", (_name, createAdapter) => {
  it("keeps canaries masked across turns, summary requests, retry attempts and a session switch", async () => {
    const provider = recordingProvider();
    const { send, dispose } = await createAdapter(provider);

    try {
      expect(await replyText(await send("session-a", combined))).toBe(combined);
      expect(await replyText(await send("session-a", combined))).toBe(combined);

      // Synthetic summary-shaped request; host scheduling is covered by E2E.
      const summary = "Summarize the previous turns about " + combined;
      const summaryReply = await replyText(await send("session-a", summary, "compaction"));
      expect(summaryReply).toBe(combined);

      const followUp = "Continue from the summary about " + summaryReply;
      provider.failNext();
      const failure = await send("session-a", followUp);
      expect(failure.status).toBe(500);
      await failure.text();
      expect(await replyText(await send("session-a", followUp))).toBe(combined);

      const originalTokens = provider.sent[0].match(tokenPattern);
      expect(originalTokens).toHaveLength(canaries.length);
      expect(new Set(originalTokens).size).toBe(canaries.length);

      provider.replyWith(originalTokens!.join(" and "));
      const foreignReply = await replyText(await send("session-b", combined));
      for (const canary of canaries) expect(foreignReply).not.toContain(canary);
      expect(await replyText(await send("session-b", combined))).toBe(combined);

      const refused = await send("session-b", combined, "malformed");
      expect(refused.ok).toBe(false);
      await refused.text();
      expect(provider.sent).toHaveLength(7);
      for (const body of provider.sent) {
        for (const canary of canaries) expect(body).not.toContain(canary);
        expect(body.match(tokenPattern)).toHaveLength(canaries.length);
      }
      for (const body of provider.sent.slice(0, 5)) expect(body.match(tokenPattern)).toEqual(originalTokens);
      expect(provider.sent[5].match(tokenPattern)).not.toEqual(originalTokens);
      expect(provider.sent[6].match(tokenPattern)).toEqual(provider.sent[5].match(tokenPattern));
    } finally {
      await dispose?.();
    }
  });
});
