// Component under test: the in-process fetch boundary (src/adapters/pi/guard.ts).
// A recording stub stands in for the provider SDK's fetch.
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loader.js";
import { PSEUDONYM_TOKEN_PREFIX_V2 } from "../src/decision/pseudonymization.js";
import {
  createPiGuard,
  MISSING_SESSION,
  PROTECT_FAILED,
  SUPPORTED_PI_APIS,
  UNSUPPORTED_MODEL,
  UNSUPPORTED_ROUTE,
  type PiGuard,
  type PiGuardModel,
} from "../src/adapters/pi/guard.js";
import { PI_UNKNOWN_TOOL_ERROR } from "../src/adapters/pi/tool-policy.js";

const SECRET = ["PI", "GUARD", "SECRET"].join("_");
const SESSION = "pi-guard-session";
const TOKEN = new RegExp(`${PSEUDONYM_TOKEN_PREFIX_V2.replace(/[[\]]/g, "\\$&")}[^\\]]+\\]`);

const config = (() => {
  const base = loadConfig(undefined, process.cwd());
  return { ...base, nda_keywords: [SECRET], private_domains: [], custom_rules: [] };
})();

function model(overrides: Partial<PiGuardModel> = {}): PiGuardModel {
  return { api: "openai-completions", provider: "stub", id: "stub-model", baseUrl: "https://api.example.test/v1", ...overrides };
}

function providerRequest(body: unknown, path = "/v1/chat/completions"): Request {
  return new Request(`https://api.example.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function echoFetch(seen: string[], reply: (token: string | undefined) => Response = (token) =>
  Response.json({ choices: [{ message: { role: "assistant", content: token ?? "no token" } }] })) {
  return (async (input: RequestInfo | URL) => {
    const request = input as Request;
    const body = await request.clone().text();
    seen.push(body);
    return reply(TOKEN.exec(body)?.[0]);
  }) as unknown as typeof fetch;
}

function ready(seen: string[], options: { api?: string } = {}): PiGuard {
  const guard = createPiGuard({ config, fetchImpl: echoFetch(seen) });
  guard.setSession(SESSION);
  guard.setModel(model(options.api === undefined ? {} : { api: options.api }));
  return guard;
}

describe("pi fetch guard", () => {
  it("masks a provider request and restores the assistant reply", async () => {
    const seen: string[] = [];
    const guard = ready(seen);
    const response = await guard.handle(providerRequest({
      model: "stub-model",
      messages: [{ role: "user", content: `please keep ${SECRET}` }],
    }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain(SECRET);
    expect(seen[0]).toMatch(TOKEN);
    expect(await response.text()).toContain(SECRET);
  });

  it("masks the Anthropic Messages and Responses routes too", async () => {
    for (const [path, body] of [
      ["/v1/messages", { model: "stub-model", messages: [{ role: "user", content: `x ${SECRET}` }] }],
      ["/v1/responses", { model: "stub-model", input: `x ${SECRET}` }],
    ] as const) {
      const seen: string[] = [];
      const guard = createPiGuard({
        config,
        fetchImpl: (async (input: RequestInfo | URL) => {
          seen.push(await (input as Request).clone().text());
          return Response.json({});
        }) as unknown as typeof fetch,
      });
      guard.setSession(SESSION);
      guard.setModel(model({ api: path === "/v1/messages" ? "anthropic-messages" : "openai-responses" }));
      await guard.handle(providerRequest(body, path));
      expect(seen).toHaveLength(1);
      expect(seen[0]).not.toContain(SECRET);
      expect(seen[0]).toMatch(TOKEN);
    }
  });

  it("passes traffic outside the provider origin through untouched", async () => {
    const seen: string[] = [];
    const guard = ready(seen);
    const response = await guard.handle(new Request("https://cdn.example.org/image.png"));
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe("");
  });

  it("passes model-catalog GETs through on the provider origin", async () => {
    const seen: string[] = [];
    const guard = ready(seen);
    const withSession = await guard.handle(new Request("https://api.example.test/v1/models/user"));
    expect(withSession.status).toBe(200);
    const bare = createPiGuard({ config, fetchImpl: echoFetch(seen) });
    bare.setModel(model());
    const withoutSession = await bare.handle(new Request("https://api.example.test/v1/models"));
    expect(withoutSession.status).toBe(200);
    expect(seen).toHaveLength(2);
  });

  it("refuses a model whose baseUrl is not an http(s) origin", async () => {
    const seen: string[] = [];
    const guard = createPiGuard({ config, fetchImpl: echoFetch(seen) });
    guard.setSession(SESSION);
    guard.setModel(model({ baseUrl: "localhost:11434" }));
    const response = await guard.handle(providerRequest({ model: "stub-model" }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(UNSUPPORTED_MODEL);
    expect(seen).toHaveLength(0);
  });

  it("refuses an unknown POST route on the provider origin", async () => {
    const seen: string[] = [];
    const guard = ready(seen);
    const response = await guard.handle(providerRequest({ input: "x" }, "/v1/embeddings"));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("LeakShield ");
    expect(seen).toHaveLength(0);
  });

  it("refuses a transport it cannot see", async () => {
    const seen: string[] = [];
    const guard = ready(seen, { api: "openai-codex-responses" });
    const response = await guard.handle(providerRequest({ model: "stub-model" }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(UNSUPPORTED_MODEL);
    expect(seen).toHaveLength(0);
    expect(SUPPORTED_PI_APIS.has("openai-codex-responses")).toBe(false);
  });

  it("refuses a provider request before a session is active", async () => {
    const seen: string[] = [];
    const guard = createPiGuard({ config, fetchImpl: echoFetch(seen) });
    guard.setModel(model());
    const response = await guard.handle(providerRequest({ model: "stub-model" }));
    expect(await response.text()).toContain(MISSING_SESSION);
    expect(seen).toHaveLength(0);
  });

  it("refuses every provider request when the core cannot be built", async () => {
    const seen: string[] = [];
    const guard = createPiGuard({ config, fetchImpl: echoFetch(seen), createCore: () => null });
    guard.setSession(SESSION);
    guard.setModel(model());
    const response = await guard.handle(providerRequest({ model: "stub-model" }));
    expect(await response.text()).toContain(PROTECT_FAILED);
    expect(seen).toHaveLength(0);
  });

  it("refuses a provider request when masking fails", async () => {
    const seen: string[] = [];
    const guard = createPiGuard({
      config,
      fetchImpl: echoFetch(seen),
      createCore: (() => ({
        onHttpRequest: async () => {
          throw new Error("LeakShield mask failed");
        },
        onHttpResponse: async () => {},
        onToolBefore: () => {},
      })) as unknown as typeof createGuardCore,
    });
    guard.setSession(SESSION);
    guard.setModel(model());
    const response = await guard.handle(providerRequest({ model: "stub-model", messages: [{ role: "user", content: SECRET }] }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("LeakShield mask failed");
    expect(seen).toHaveLength(0);
  });

  it("restores tool arguments and refuses unknown tools", async () => {
    const seen: string[] = [];
    const guard = ready(seen);
    await guard.handle(providerRequest({ model: "stub-model", messages: [{ role: "user", content: SECRET }] }));
    const token = TOKEN.exec(seen[0])?.[0];
    expect(token).toBeDefined();
    if (token === undefined) return;

    expect(guard.restoreTool("read", { path: token })).toEqual({ path: SECRET });
    expect(guard.restoreTool("bash", { command: `echo ${token}` })).toEqual({ command: `echo ${SECRET}` });
    expect(() => guard.restoreTool("mcp_remote", { query: token })).toThrow(PI_UNKNOWN_TOOL_ERROR);
  });

  it("guards a model-shaped POST on an unexpected origin", async () => {
    const seen: string[] = [];
    const guard = ready(seen);
    const response = await guard.handle(new Request("https://other.example.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: SECRET }] }),
    }));
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain(SECRET);
    expect(seen[0]).toMatch(TOKEN);

    const bare = createPiGuard({ config, fetchImpl: echoFetch(seen) });
    bare.setModel(model());
    const refused = await bare.handle(new Request("https://other.example.test/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: SECRET }] }),
    }));
    expect(await refused.text()).toContain(MISSING_SESSION);
  });

  it("propagates network failures instead of turning them into a refusal", async () => {
    const guard = createPiGuard({
      config,
      fetchImpl: (async () => {
        throw new TypeError("network down");
      }) as unknown as typeof fetch,
    });
    guard.setSession(SESSION);
    guard.setModel(model());
    await expect(guard.handle(providerRequest({ model: "stub-model", messages: [{ role: "user", content: "hi" }] }))).rejects.toThrow("network down");
  });

  it("only guards the three fetch transports", () => {
    expect([...SUPPORTED_PI_APIS].sort()).toEqual([
      "anthropic-messages",
      "openai-completions",
      "openai-responses",
    ]);
    expect(UNSUPPORTED_ROUTE).toContain("LeakShield ");
  });
});
