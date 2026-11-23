// Component under test: pi user settings resolution (src/pi/settings.ts).
import { describe, expect, it } from "vitest";
import {
  loadPiUserAgent,
  resolveApiKeySpec,
  resolvePiProvider,
  resolveSessionDir,
} from "../src/pi/settings.js";

const AGENT = "/home/test/.pi/agent";

function agentWith(files: Record<string, string>) {
  return loadPiUserAgent(AGENT, (filePath) => files[filePath.replace(`${AGENT}/`, "")] ?? null);
}

describe("pi settings", () => {
  it("reads defaults, sessionDir and provider entries", () => {
    const agent = agentWith({
      "settings.json": JSON.stringify({ defaultModel: "claude-test", sessionDir: "sessions" }),
      "models.json": JSON.stringify({
        providers: {
          local: { baseUrl: "https://local.test/v1", api: "openai-completions", apiKey: "$LOCAL_KEY", models: [{ id: "m1" }, { id: "m2" }] },
        },
      }),
    });
    expect(agent.settings.defaultModel).toBe("claude-test");
    expect(agent.providers.local?.baseUrl).toBe("https://local.test/v1");
    expect(agent.providers.local?.models).toEqual([{ id: "m1" }, { id: "m2" }]);
  });

  it("refuses malformed JSON and wrong field types", () => {
    expect(() => agentWith({ "settings.json": "{oops" })).toThrow("not valid JSON");
    expect(() => agentWith({ "settings.json": JSON.stringify({ extensions: "x" }) })).toThrow("extensions must be an array");
    expect(() => agentWith({ "models.json": JSON.stringify({ providers: [] }) })).toThrow("providers must be an object");
    expect(() =>
      agentWith({ "models.json": JSON.stringify({ providers: { p: { models: {}, baseUrl: "" } } }) }),
    ).toThrow("must be an array");
  });

  it("resolves a models.json provider, its model metadata and its credential", () => {
    const agent = agentWith({
      "models.json": JSON.stringify({
        providers: {
          local: {
            baseUrl: "https://local.test/v1",
            api: "openai-completions",
            apiKey: "$LOCAL_KEY",
            headers: { "x-org": "$LOCAL_ORG" },
            models: [{ id: "m1", contextWindow: 200000, baseUrl: "https://evil.test" }],
          },
        },
      }),
    });
    const resolution = resolvePiProvider({ agent, env: { LOCAL_KEY: "sk-local", LOCAL_ORG: "org-1" }, provider: "local", model: "local/m1" });
    expect(resolution.provider).toBe("local");
    expect(resolution.upstream).toEqual({
      baseUrl: "https://local.test/v1",
      api: "openai-completions",
      apiKey: "sk-local",
      headers: { "x-org": "org-1" },
    });
    expect(resolution.models).toEqual(["m1"]);
    expect(resolution.modelEntries[0]?.contextWindow).toBe(200000);
    expect(resolution.envNames.sort()).toEqual(["LOCAL_KEY", "LOCAL_ORG"]);
  });

  it("requires --provider and never infers it from settings or the model", () => {
    const agent = agentWith({
      "settings.json": JSON.stringify({ defaultModel: "anthropic/claude-test" }),
      "models.json": JSON.stringify({
        providers: { anthropic: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages", apiKey: "sk-ant-test" } },
      }),
    });
    expect(() => resolvePiProvider({ agent, env: { ANTHROPIC_API_KEY: "sk-ant-test" } })).toThrow(
      "no pi provider selected; pass --provider <id>",
    );
    expect(() => resolvePiProvider({ agent, env: {}, model: "anthropic/claude-test" })).toThrow("no pi provider selected");
    expect(resolvePiProvider({ agent, env: {}, provider: "anthropic" }).upstream.apiKey).toBe("sk-ant-test");
  });

  it("refuses a provider outside models.json even with --upstream and --api", () => {
    const agent = agentWith({});
    expect(() => resolvePiProvider({ agent, env: {}, provider: "google" })).toThrow(
      `pi provider "google" is not declared in pi's models.json`,
    );
    expect(() =>
      resolvePiProvider({
        agent,
        env: {},
        provider: "google",
        upstreamOverride: "https://x.test/v1",
        apiOverride: "openai-completions",
      }),
    ).toThrow("declare it with baseUrl, api and apiKey");
  });

  it("lets --upstream and --api override a declared provider entry", () => {
    const agent = agentWith({
      "models.json": JSON.stringify({
        providers: { local: { baseUrl: "https://local.test/v1", api: "openai-completions", apiKey: "sk-local" } },
      }),
    });
    const resolution = resolvePiProvider({
      agent,
      env: {},
      provider: "local",
      upstreamOverride: "http://127.0.0.1:4321/v1",
      apiOverride: "anthropic-messages",
    });
    expect(resolution.upstream.baseUrl).toBe("http://127.0.0.1:4321/v1");
    expect(resolution.upstream.api).toBe("anthropic-messages");
    expect(resolution.upstream.apiKey).toBe("sk-local");
  });

  it("refuses unsupported APIs and leaves a missing models.json apiKey undefined", () => {
    const agent = agentWith({
      "models.json": JSON.stringify({
        providers: { overridden: { baseUrl: "https://local.test/v1", api: "openai-completions" } },
      }),
    });
    expect(() =>
      resolvePiProvider({ agent, env: {}, provider: "overridden", upstreamOverride: "https://generativelanguage.googleapis.com/v1beta", apiOverride: "google-generative-ai" }),
    ).toThrow("does not speak");
    expect(resolvePiProvider({ agent, env: {}, provider: "overridden" }).upstream.apiKey).toBeUndefined();
  });

  it("refuses apiKey commands instead of executing them", () => {
    expect(resolveApiKeySpec("$MY_KEY", { MY_KEY: "v" })).toBe("v");
    expect(resolveApiKeySpec("$MISSING", {})).toBeUndefined();
    expect(() => resolveApiKeySpec("!security find-generic-password", {})).toThrow("not run");
  });

  it("keeps the user's session directory so resume keeps working", () => {
    const agent = agentWith({});
    expect(resolveSessionDir(agent, {}, "/work")).toBe("/home/test/.pi/agent/sessions");
    expect(resolveSessionDir(agent, { PI_CODING_AGENT_SESSION_DIR: "/sessions" }, "/work")).toBe("/sessions");
    expect(resolveSessionDir(agentWith({ "settings.json": JSON.stringify({ sessionDir: "../store" }) }), {}, "/work")).toBe(
      "/store",
    );
  });
});
