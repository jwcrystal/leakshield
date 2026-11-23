// Component under test: the pi extension surface (src/pi/extension.ts).
// The guard is mocked so the tests cover handler wiring and refusal flow.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  created: 0,
  installed: 0,
  session: null as string | null,
  model: null as { api: string; provider: string; id: string; baseUrl: string } | null,
  toolResult: null as unknown,
  toolError: null as Error | null,
}));

vi.mock("../src/pi/guard.js", () => ({
  PROTECT_FAILED: "LeakShield could not protect this provider request. [protect]",
  MISSING_SESSION: "LeakShield refused a provider request before a session was active. [session]",
  createPiGuard: () => {
    state.created += 1;
    return {
      get core() {
        return {};
      },
      get refusal() {
        return state.model !== null && state.model.api === "bedrock-converse-stream" ? "LeakShield cannot protect this model" : null;
      },
      setSession(value: string | null) {
        state.session = value;
      },
      setModel(value: typeof state.model) {
        state.model = value;
      },
      restoreTool(_tool: string, input: unknown) {
        if (state.toolError !== null) throw state.toolError;
        return input === state.toolResult ? "restored" : input;
      },
      install() {
        state.installed += 1;
        return (() => {}) as typeof fetch;
      },
      restore() {},
      handle: vi.fn(),
    };
  },
}));

const { default: leakshieldPiExtension } = await import("../src/pi/extension.js");

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  return {
    api: {
      on(event: string, handler: Handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    },
    async emit(event: string, payload: unknown, ctx: unknown) {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) {
        const next = await handler(payload, ctx);
        if (next !== undefined) result = next;
      }
      return result;
    },
  };
}

function context(notices: string[], model: { api: string } | undefined = { api: "openai-completions" }) {
  return {
    sessionManager: { getSessionId: () => "ses-1" },
    model: model === undefined ? undefined : { api: model.api, provider: "stub", id: "stub-model", baseUrl: "https://api.example.test/v1" },
    ui: { notify: (message: string) => notices.push(message) },
  };
}

beforeEach(() => {
  process.env.LEAKSHIELD_CONFIG = "/nonexistent/leakshield-guard-test.yaml";
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("leakshield.pi.guard")];
  state.created = 0;
  state.installed = 0;
  state.session = null;
  state.model = null;
  state.toolResult = null;
  state.toolError = null;
});

describe("pi extension", () => {
  it("installs the guard once and binds the session and model", async () => {
    const notices: string[] = [];
    const first = fakePi();
    leakshieldPiExtension(first.api);
    const second = fakePi();
    leakshieldPiExtension(second.api);

    expect(state.created).toBe(1);
    expect(state.installed).toBe(1);

    await second.emit("session_start", { type: "session_start" }, context(notices));
    expect(state.session).toBe("ses-1");
    expect(state.model?.api).toBe("openai-completions");
    expect(notices).toEqual([]);
  });

  it("continues user input for a supported model and blocks it otherwise", async () => {
    const notices: string[] = [];
    const pi = fakePi();
    leakshieldPiExtension(pi.api);
    const supported = context(notices);
    await pi.emit("session_start", {}, supported);
    expect(await pi.emit("input", { source: "interactive" }, supported)).toEqual({ action: "continue" });

    const unsupported = context(notices, { api: "bedrock-converse-stream" });
    await pi.emit("session_start", {}, unsupported);
    expect(await pi.emit("input", { source: "interactive" }, unsupported)).toEqual({ action: "handled" });
    expect(notices.length).toBeGreaterThan(0);
  });

  it("refuses extension-authored input when the run is refused", async () => {
    const notices: string[] = [];
    const pi = fakePi();
    leakshieldPiExtension(pi.api);
    const refused = context(notices, { api: "bedrock-converse-stream" });
    await pi.emit("session_start", {}, refused);
    expect(await pi.emit("input", { source: "extension" }, refused)).toEqual({ action: "handled" });
  });

  it("restores a tool call in place and blocks an unknown tool", async () => {
    const notices: string[] = [];
    const pi = fakePi();
    leakshieldPiExtension(pi.api);
    const ctx = context(notices);
    await pi.emit("session_start", {}, ctx);

    const input = { path: "x" };
    state.toolResult = input;
    const event = { toolName: "read", input };
    expect(await pi.emit("tool_call", event, ctx)).toBeUndefined();
    expect(event.input).toBe("restored");

    state.toolError = new Error("LeakShield blocked this tool call because the tool is not a known pi built-in");
    expect(await pi.emit("tool_call", { toolName: "mcp_remote", input: {} }, ctx)).toEqual({
      block: true,
      reason: state.toolError.message,
      terminate: true,
    });
  });

  it("refuses every tool call while the model is unsupported", async () => {
    const notices: string[] = [];
    const pi = fakePi();
    leakshieldPiExtension(pi.api);
    const ctx = context(notices, { api: "bedrock-converse-stream" });
    await pi.emit("session_start", {}, ctx);
    const result = await pi.emit("tool_call", { toolName: "read", input: {} }, ctx);
    expect(result).toEqual({ block: true, reason: "LeakShield cannot protect this model", terminate: true });
  });

  it("cancels manual compaction and tree summarization when the run is refused", async () => {
    const notices: string[] = [];
    const pi = fakePi();
    leakshieldPiExtension(pi.api);
    const refusedCtx = context(notices, { api: "bedrock-converse-stream" });
    await pi.emit("session_start", {}, refusedCtx);
    expect(await pi.emit("session_before_compact", { reason: "manual" }, refusedCtx)).toEqual({ cancel: true });
    expect(await pi.emit("session_before_tree", {}, refusedCtx)).toEqual({ cancel: true });

    const supported = context(notices);
    await pi.emit("session_start", {}, supported);
    expect(await pi.emit("session_before_compact", { reason: "manual" }, supported)).toBeUndefined();
    expect(await pi.emit("session_before_tree", {}, supported)).toBeUndefined();
  });

  it("re-reads the model on input before a run starts", async () => {
    const notices: string[] = [];
    const pi = fakePi();
    leakshieldPiExtension(pi.api);
    await pi.emit("session_start", {}, context(notices));
    expect(await pi.emit("input", { source: "interactive" }, context(notices))).toEqual({ action: "continue" });
    const switched = context(notices, { api: "bedrock-converse-stream" });
    expect(await pi.emit("input", { source: "interactive" }, switched)).toEqual({ action: "handled" });
  });

  it("re-reads the model at agent start", async () => {
    const notices: string[] = [];
    const pi = fakePi();
    leakshieldPiExtension(pi.api);
    await pi.emit("session_start", {}, context(notices));
    await pi.emit("before_agent_start", {}, context(notices, { api: "bedrock-converse-stream" }));
    expect(state.model?.api).toBe("bedrock-converse-stream");
    // The stored refusal from the re-read cancels an operation that cannot
    // re-read the model itself, even with a supported model in this context.
    expect(await pi.emit("session_before_compact", { reason: "manual" }, context(notices))).toEqual({ cancel: true });
  });

  it("reattaches the model on model_select and clears the refusal", async () => {
    const notices: string[] = [];
    const pi = fakePi();
    leakshieldPiExtension(pi.api);
    const refused = context(notices, { api: "bedrock-converse-stream" });
    await pi.emit("session_start", {}, refused);
    expect(await pi.emit("input", { source: "interactive" }, refused)).toEqual({ action: "handled" });
    await pi.emit("model_select", { model: { api: "openai-responses", provider: "stub", id: "m", baseUrl: "https://api.example.test/v1" } }, context(notices));
    expect(state.model?.api).toBe("openai-responses");
    expect(await pi.emit("input", { source: "interactive" }, context(notices))).toEqual({ action: "continue" });
  });
});
