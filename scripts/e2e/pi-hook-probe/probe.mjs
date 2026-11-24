import { createServer } from "node:http";
/**
 * Research harness for #118, not a production hook-only adapter.
 * Runs real pi 1.6.0 against synthetic loopback providers. Some control cases
 * intentionally expose the synthetic canary to the stub; see analyze.mjs.
 * Requires npm run build and a separate pinned pi runtime (README.md).
 */
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";

const option = (name) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`Missing value for ${name}`);
  return value;
};
const runtime = option("--runtime");
if (!runtime)
  throw new Error(
    "usage: node scripts/e2e/pi-hook-probe/probe.mjs --runtime <npm-prefix> [--out <directory>]",
  );
const runtimeDir = resolve(runtime);
const packageDir = join(
  runtimeDir,
  "node_modules/@earendil-works/pi-coding-agent",
);
const packageInfo = JSON.parse(
  readFileSync(join(packageDir, "package.json"), "utf8"),
);
if (packageInfo.version !== "1.6.0")
  throw new Error(
    `This probe is pinned to pi 1.6.0, received ${packageInfo.version}`,
  );
const REPO = resolve(import.meta.dirname, "../../..");
const ROOT = option("--out")
  ? resolve(option("--out"))
  : mkdtempSync(join(tmpdir(), "pi-hook-probe-"));
mkdirSync(ROOT, { recursive: true });
const revision = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: REPO,
  encoding: "utf8",
});
const sourceCommit =
  revision.status === 0 ? revision.stdout.trim() : "not-recorded";
process.env.PI_OFFLINE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PI_CODING_AGENT_DIR = join(ROOT, "empty-global");
const pi = await import(pathToFileURL(join(packageDir, "dist/index.js")).href);
const { createPiGuard } = await import(
  pathToFileURL(join(REPO, "dist/adapters/pi/guard.js")).href
);
const { PSEUDONYM_TOKEN_PREFIX_V2 } = await import(
  pathToFileURL(join(REPO, "dist/decision/pseudonymization.js")).href
);
const CANARY = "PI118_SYNTHETIC_PRIVATE_VALUE";
const MASK = "[MASKED_PI118]";
const originalFetch = globalThis.fetch;
const results = [];

function masked(value) {
  if (typeof value === "string") return value.replaceAll(CANARY, MASK);
  if (Array.isArray(value)) return value.map(masked);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, masked(v)]),
    );
  return value;
}
const hasRaw = (value) => JSON.stringify(value).includes(CANARY);

function stream(response, api, toolPath, doTool, usage) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  const send = (name, data) =>
    response.write(
      `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(data)}\n\n`,
    );
  if (api === "anthropic-messages") {
    send("message_start", {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [],
        model: "stub-model",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage, output_tokens: 1 },
      },
    });
    send("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    send("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "synthetic summary ok" },
    });
    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    send("message_stop", { type: "message_stop" });
  } else if (api === "openai-responses") {
    const item = {
      id: "msg_1",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        { type: "output_text", text: "synthetic summary ok", annotations: [] },
      ],
    };
    send("response.created", {
      type: "response.created",
      response: {
        id: "resp_1",
        object: "response",
        created_at: 1,
        status: "in_progress",
        model: "stub-model",
        output: [],
      },
    });
    send("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    });
    send("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: "synthetic summary ok",
    });
    send("response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item,
    });
    send("response.completed", {
      type: "response.completed",
      response: {
        id: "resp_1",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "stub-model",
        output: [item],
        usage: {
          input_tokens: usage,
          output_tokens: 1,
          total_tokens: usage + 1,
        },
      },
    });
  } else {
    const delta = doTool
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_read",
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({ path: toolPath }),
              },
            },
          ],
        }
      : { role: "assistant", content: "synthetic summary ok" };
    send("", {
      id: "chatcmpl_1",
      object: "chat.completion.chunk",
      created: 1,
      model: "stub-model",
      choices: [{ index: 0, delta, finish_reason: null }],
    });
    send("", {
      id: "chatcmpl_1",
      object: "chat.completion.chunk",
      created: 1,
      model: "stub-model",
      choices: [
        { index: 0, delta: {}, finish_reason: doTool ? "tool_calls" : "stop" },
      ],
      usage: {
        prompt_tokens: usage,
        completion_tokens: 5,
        total_tokens: usage + 5,
      },
    });
    response.write("data: [DONE]\n\n");
  }
  response.end();
}

async function runCase(mode, api = "openai-completions", workflow = "full") {
  const id = `${mode}-${api}-${workflow}`;
  const dir = join(ROOT, "runs", id);
  mkdirSync(dir, { recursive: true });
  const toolPath = join(dir, "canary.txt");
  writeFileSync(toolPath, `${CANARY}\n`);
  let stage = "startup";
  let automaticCompaction = false;
  const effectiveStage = () =>
    automaticCompaction && workflow === "auto" ? "automatic-compact" : stage;
  let toolSent = false;
  const requests = [],
    hooks = [],
    events = [],
    errors = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = {};
    }
    const toolResult = (parsed.messages ?? []).some((m) => m.role === "tool");
    requests.push({
      stage: effectiveStage(),
      path: req.url,
      raw: body.includes(CANARY),
      masked: body.includes(MASK) || body.includes(PSEUDONYM_TOKEN_PREFIX_V2),
      toolResult,
      toolResultRaw:
        toolResult &&
        hasRaw((parsed.messages ?? []).filter((m) => m.role === "tool")),
    });
    const doTool = workflow === "full" && stage === "tool" && !toolSent;
    if (doTool) toolSent = true;
    stream(
      res,
      api,
      toolPath,
      doTool,
      workflow === "auto" &&
        stage === "prompt" &&
        !/summari[sz]/i.test(body.slice(-900))
        ? 650
        : 40,
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        stub: {
          baseUrl: base + (api === "anthropic-messages" ? "" : "/v1"),
          api,
          apiKey: "synthetic-loopback-key",
          models: [
            {
              id: "stub-model",
              name: "Stub",
              contextWindow: workflow === "auto" ? 700 : 20000,
              maxTokens: 256,
            },
          ],
        },
      },
    }),
  );
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      defaultProvider: "stub",
      defaultModel: "stub-model",
      retry: { enabled: false, maxRetries: 0 },
      compaction: {
        enabled: workflow === "auto",
        reserveTokens: 100,
        keepRecentTokens: 50,
      },
    }),
  );
  const observe = (name, event) =>
    hooks.push({ stage: effectiveStage(), name, raw: hasRaw(event) });
  const factory = (ext) => {
    for (const name of [
      "session_start",
      "before_agent_start",
      "input",
      "context",
      "context_with_system",
      "before_provider_request",
      "tool_call",
      "tool_result",
      "session_before_compact",
      "session_before_tree",
    ]) {
      ext.on(name, (event, ctx) => {
        observe(name, event);
        if (name === "before_agent_start" && mode === "context-mask")
          return { systemPrompt: masked(event.systemPrompt) };
        if (name === "context_with_system") {
          if (mode === "context-mask")
            return { messages: masked(event.messages) };
          if (mode === "context-throw")
            throw new Error("PI118_FORCED_CONTEXT_MASK_ERROR");
          if (mode === "context-abort") {
            ctx.abort();
            throw new Error("PI118_FORCED_CONTEXT_MASK_ERROR_AFTER_ABORT");
          }
        }
        if (name === "before_provider_request") {
          if (
            mode === "provider-mask" ||
            mode === "provider-mask-late" ||
            mode === "background-cancel"
          )
            return masked(event.payload);
          if (mode === "provider-throw")
            return Promise.reject(new Error("PI118_FORCED_PAYLOAD_MASK_ERROR"));
          if (mode === "provider-abort") {
            ctx.abort();
            throw new Error("PI118_FORCED_PAYLOAD_MASK_ERROR_AFTER_ABORT");
          }
        }
        if (
          (name === "session_before_compact" ||
            name === "session_before_tree") &&
          mode === "background-cancel"
        )
          return { cancel: true };
      });
    }
    if (mode === "provider-mask-late" || mode === "wire-late") {
      ext.on("before_provider_request", (event) => {
        const payload = structuredClone(event.payload);
        payload.messages.push({
          role: "user",
          content: `Later extension data ${CANARY}`,
        });
        hooks.push({
          stage: effectiveStage(),
          name: "later-extension-injection",
          raw: true,
        });
        return payload;
      });
    }
    if (mode.startsWith("wire")) {
      const createCore =
        mode === "wire-error"
          ? () => ({
              onHttpRequest: async () => {
                throw new Error("PI118_FORCED_CORE_MASK_ERROR");
              },
              onHttpResponse: async () => {},
              onToolBefore: () => {},
            })
          : undefined;
      const guard = createPiGuard({
        config: {
          nda_keywords: [CANARY],
          private_domains: [],
          custom_rules: [],
          settings: {
            max_chars: mode === "wire-over-limit" ? 16 : 200000,
            show_line_numbers: false,
            encoding_detection: true,
          },
        },
        ...(createCore ? { createCore } : {}),
      });
      guard.install();
      ext.on("session_start", (_event, ctx) => {
        guard.setSession(ctx.sessionManager.getSessionId());
        guard.setModel(ctx.model ?? null);
      });
    }
  };
  const loader = new pi.DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: `Synthetic system instruction ${CANARY}`,
    extensionFactories: [factory],
  });
  let session;
  let failure;
  const outcomes = [];
  try {
    await loader.reload();
    const created = await pi.createAgentSession({
      cwd: dir,
      agentDir: dir,
      resourceLoader: loader,
      thinkingLevel: "off",
      tools: workflow === "full" ? ["read"] : [],
      sessionManager: pi.SessionManager.inMemory(dir),
    });
    if (created.extensionsResult.errors.length)
      throw new Error(
        "Extension loading error: " +
          JSON.stringify(created.extensionsResult.errors),
      );
    session = created.session;
    session.subscribe((event) => {
      if (event.type === "compaction_start" && event.reason === "threshold")
        automaticCompaction = true;
      if (
        [
          "compaction_start",
          "compaction_end",
          "tool_execution_end",
          "agent_end",
        ].includes(event.type)
      )
        events.push({
          stage: effectiveStage(),
          type: event.type,
          reason: event.reason,
          aborted: event.aborted,
        });
      if (event.type === "compaction_end") automaticCompaction = false;
    });
    await session.bindExtensions({
      mode: "rpc",
      onError: (error) =>
        errors.push({ event: error.event, error: error.error }),
    });
    const prompt = async (message) => {
      await session.prompt(message);
      const last = session.messages.at(-1);
      outcomes.push({
        stage,
        lastRole: last?.role,
        stopReason: last?.stopReason,
        errorMessage: last?.errorMessage,
      });
    };
    stage = workflow === "auto" ? "prompt" : "normal";
    await prompt(
      `First prompt: ${CANARY}. ` + "synthetic context ".repeat(180),
    );
    if (workflow === "full") {
      stage = "tool";
      await prompt(`Read the synthetic fixture ${toolPath}.`);
      stage = "history";
      await prompt(
        `Third prompt ${CANARY}. ` + "more synthetic context ".repeat(180),
      );
      const firstUser = session.sessionManager
        .getEntries()
        .find((e) => e.type === "message" && e.message.role === "user");
      stage = "manual-compact";
      try {
        await session.compact(`Summary instruction ${CANARY}`);
        outcomes.push({ stage, completed: true });
      } catch (e) {
        outcomes.push({ stage, error: String(e.message) });
      }
      stage = "tree-summary";
      try {
        const result = await session.navigateTree(firstUser.id, {
          summarize: true,
          customInstructions: `Tree summary instruction ${CANARY}`,
        });
        outcomes.push({
          stage,
          cancelled: result.cancelled,
          summaryCreated: !!result.summaryEntry,
        });
      } catch (e) {
        outcomes.push({ stage, error: String(e.message) });
      }
    } else if (workflow === "auto") {
      stage = "prompt";
      await prompt(
        `Second automatic prompt ${CANARY}. ` +
          "automatic context ".repeat(180),
      );
    }
  } catch (e) {
    failure = String(e.stack ?? e);
  } finally {
    try {
      session?.dispose();
    } catch {}
    globalThis.fetch = originalFetch;
    server.closeIdleConnections();
    await new Promise((r) => server.close(r));
  }
  const result = {
    id,
    mode,
    api,
    workflow,
    requests,
    hooks,
    events,
    errors,
    outcomes,
    failure,
  };
  writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
  results.push(result);
  console.log(
    JSON.stringify({
      id,
      requestCount: requests.length,
      rawStages: requests.filter((r) => r.raw).map((r) => r.stage),
      backgroundHooks: hooks
        .filter((h) => h.name.startsWith("session_before"))
        .map((h) => h.name),
      errors: errors.length,
      failure: failure?.split("\n")[0],
    }),
  );
}

const matrix = process.argv.includes("--smoke")
  ? [["baseline", "openai-completions", "normal"]]
  : [
      ...[
        "openai-completions",
        "anthropic-messages",
        "openai-responses",
      ].flatMap((api) => [
        ["baseline", api, "normal"],
        ["provider-mask", api, "normal"],
        ["wire", api, "normal"],
      ]),
      ["provider-mask", "openai-completions", "full"],
      ["context-mask", "openai-completions", "full"],
      ["wire", "openai-completions", "full"],
      ...[
        "openai-completions",
        "anthropic-messages",
        "openai-responses",
      ].flatMap((api) =>
        [
          "provider-throw",
          "context-throw",
          "provider-abort",
          "context-abort",
          "wire-error",
          "wire-over-limit",
        ].map((mode) => [mode, api, "normal"]),
      ),
      ["provider-mask-late", "openai-completions", "normal"],
      ["wire-late", "openai-completions", "normal"],
      ["background-cancel", "openai-completions", "full"],
      ...["provider-mask", "context-mask", "wire", "background-cancel"].map(
        (mode) => [mode, "openai-completions", "auto"],
      ),
    ];
for (const args of matrix) {
  const timeout = setTimeout(() => {
    console.error(`Timed out: ${args.join("/")}`);
    process.exit(1);
  }, 30000);
  try {
    await runCase(...args);
  } finally {
    clearTimeout(timeout);
  }
}
writeFileSync(
  join(ROOT, "results.json"),
  JSON.stringify(
    {
      piVersion: packageInfo.version,
      nodeVersion: process.version,
      sourceCommit,
      canary: CANARY,
      results,
    },
    null,
    2,
  ),
);
if (!process.argv.includes("--smoke")) {
  for (const api of [
    "openai-completions",
    "anthropic-messages",
    "openai-responses",
  ]) {
    const code = await new Promise((done, reject) => {
      const binary = join(packageDir, "dist/bundle/cli.js");
      // The existing CLI checks spawn the executable directly. The package's
      // cli.js carries its Node shebang; no shell or real provider is involved.
      const child = spawn(
        process.execPath,
        [join(REPO, "scripts/e2e/run-pi-wire.mjs"), binary, api],
        { cwd: REPO, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      const timer = setTimeout(() => child.kill("SIGTERM"), 30000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (status) => {
        clearTimeout(timer);
        writeFileSync(join(ROOT, `cli-${api}.log`), output);
        done(status);
      });
    });
    if (code !== 0)
      throw new Error(
        `CLI verification failed for ${api}; see ${join(ROOT, `cli-${api}.log`)}`,
      );
  }
}
console.log(`Evidence written to ${ROOT}`);
if (results.some((r) => r.failure)) process.exitCode = 1;
