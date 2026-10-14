#!/usr/bin/env node
/** Real OpenCode V2 + local synthetic Responses provider. No external model,
 * real credentials, shared-service restart or keychain access. Exercises
 * write/read/quoted-shell continuations over HTTP and a reused WS connection.
 * Requires npm ci + npm run build (ws is supplied by the pinned plugin SDK).
 * OPENCODE_BIN selects the host; E2E_WORK_ROOT selects an external temp parent.
 * E2E_PROVIDER_PACKAGE selects an AI SDK package/package-directory (HTTP only);
 * E2E_LEGACY=1 verifies Go: scoped hook-only with wire=false, refusal with true.
 * E2E_PLAN pins a synthetic commandcode plan. E2E_FORCE_UPGRADE=1 tests a
 * provider 403 upgrade_required followed by the same split legacy policy.
 * E2E_MODEL_ID selects its synthetic model. Evidence is retained, failures exit 1. */
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = process.env.OPENCODE_BIN || "opencode";
const DIST = path.join(REPO, "dist");
const SDK_PACKAGE = process.env.E2E_PROVIDER_PACKAGE;
const PROVIDER_PACKAGE = SDK_PACKAGE ? (SDK_PACKAGE.startsWith("aisdk:") ? SDK_PACKAGE : `aisdk:${SDK_PACKAGE}`) : "@opencode/ai/providers/openai";
const MODEL = process.env.E2E_MODEL_ID || "capture-1";
const LEGACY = process.env.E2E_LEGACY === "1" || process.env.E2E_REJECT_LEGACY === "1";
const FORCE_UPGRADE = process.env.E2E_FORCE_UPGRADE === "1";
const PLAN = process.env.E2E_PLAN || (LEGACY ? "go" : undefined);
const BASE_PATH = process.env.E2E_BASE_PATH ?? "/v1";
// Test-only lifecycle fault: the real host sends on a socket whose send hook
// registration was lost. Context/tool hooks still use the production plugin.
const LOST_WS_SEND = process.env.E2E_LOST_WS_SEND === "1";
if (LOST_WS_SEND && SDK_PACKAGE) throw new Error("E2E_LOST_WS_SEND is a native WS lifecycle test.");
if (LEGACY && !SDK_PACKAGE) throw new Error("E2E_LEGACY requires the isolated commandcode SDK package.");
if (!existsSync(path.join(DIST, "opencode-transparent-ws.js"))) throw new Error("Run npm run build first.");
// A missing host otherwise surfaces as four requests=0 FAILs (spawn ENOENT).
if (spawnSync(BIN, ["--version"], { stdio: "ignore" }).error) {
  console.error(`OpenCode host not found: "${BIN}". Put opencode on PATH or set OPENCODE_BIN=/path/to/opencode.`);
  process.exit(2);
}
const preferredTemp = path.join(os.tmpdir(), "opencode");
const ROOT = mkdtempSync(path.join(process.env.E2E_WORK_ROOT || (existsSync(preferredTemp) ? preferredTemp : os.tmpdir()), "sg-ws-tools-"));
const EMAIL = "alice.canary@example-test.invalid";
const SECRET = "SyntheticCanaryValueQ7bNvR2s";
const TOKEN = /\[SGP2:PII_EMAIL-[a-z]{4}-[a-z]{4}-[a-z]{4}\]/;
const rows = [];

function run(directory, env) {
  return new Promise((resolve) => {
    const child = spawn(BIN, ["run", "--standalone", "--format", "json", "--model", `openai/${MODEL}`, "--auto", "--print-logs", `Contact ${EMAIL}; rotate ${SECRET}; complete the local tools test.`], {
      cwd: directory, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch { /* Child may already have exited. */ }
    }, Number(process.env.E2E_TIMEOUT_MS || 60000));
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr + error.message, timedOut }); });
  });
}

console.log(`Evidence: ${ROOT}`);
for (const transport of SDK_PACKAGE ? ["http"] : ["http", "websocket"]) {
  for (const wireProtection of [false, true]) {
    const expectRejection = (LEGACY || FORCE_UPGRADE) && wireProtection;
    const hookOnlyReply = (LEGACY || FORCE_UPGRADE) && !wireProtection;
    const name = `${transport}-${wireProtection ? "wire" : "hook"}`;
    const directory = path.join(ROOT, name);
    for (const sub of ["home", "config/opencode", "data", "state", "cache"]) mkdirSync(path.join(directory, sub), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(directory, ".env"), `TEST_SECRET=${SECRET}\n`);
    writeFileSync(path.join(directory, "AGENTS.md"), `Synthetic test contact: ${EMAIL}. Synthetic environment value: ${SECRET}.\n`);
    const outputFile = path.join(directory, "written.txt");
    const shellFile = path.join(directory, "shell.txt");
    const captures = [];
    const unexpectedRequests = [];
    let writeAddsNewline = false;
    let mainStep = 0, connectionCount = 0, emailToken;
    function reply(body) {
      const main = Array.isArray(body.tools) && body.tools.length > 0;
      if (main) {
        mainStep += 1;
        emailToken ??= JSON.stringify(body).match(TOKEN)?.[0];
      }
      const id = `resp_${captures.length}`, itemID = `item_${captures.length}`;
      let item, deltas;
      const token = emailToken || "MISSING_TOKEN";
      if (main && mainStep <= 3) {
        const toolNames = new Set(body.tools.map((tool) => tool.function?.name ?? tool.name));
        const usePatch = mainStep === 1 && !toolNames.has("write") && toolNames.has("patch");
        if (usePatch) writeAddsNewline = true;
        const name = mainStep === 1 ? (usePatch ? "patch" : "write") : mainStep === 2 ? "read" : "shell";
        const args = usePatch ? { patchText: `*** Begin Patch\n*** Add File: ${outputFile}\n+${token}\n*** End Patch` }
          : mainStep === 1 ? { path: outputFile, content: token }
          : mainStep === 2 ? { path: outputFile }
          : { command: `printf '%s' '${token}' > '${shellFile}'` };
        const argumentsText = JSON.stringify(args);
        const cut = Math.floor(argumentsText.length / 2);
        item = { type: "function_call", id: itemID, call_id: `call_${mainStep}`, name, arguments: argumentsText, status: "completed" };
        deltas = [
          { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", arguments: "" } },
          { type: "response.function_call_arguments.delta", item_id: itemID, output_index: 0, delta: argumentsText.slice(0, cut) },
          { type: "response.function_call_arguments.delta", item_id: itemID, output_index: 0, delta: argumentsText.slice(cut) },
          { type: "response.function_call_arguments.done", item_id: itemID, output_index: 0, arguments: argumentsText },
          { type: "response.output_item.done", output_index: 0, item },
        ];
      } else {
        const text = main ? `Contact ${token} OK_DONE` : "Synthetic title";
        const part = { type: "output_text", text, annotations: [] };
        item = { type: "message", id: itemID, role: "assistant", status: "completed", content: [part] };
        // Deliberately cut INSIDE the placeholder, not at a natural word break.
        const cut = main ? text.indexOf(token) + 12 : Math.floor(text.length / 2);
        deltas = [
          { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
          { type: "response.content_part.added", item_id: itemID, output_index: 0, content_index: 0, part: { ...part, text: "" } },
          { type: "response.output_text.delta", item_id: itemID, output_index: 0, content_index: 0, delta: text.slice(0, cut) },
          { type: "response.output_text.delta", item_id: itemID, output_index: 0, content_index: 0, delta: text.slice(cut) },
          { type: "response.output_text.done", item_id: itemID, output_index: 0, content_index: 0, text },
          { type: "response.content_part.done", item_id: itemID, output_index: 0, content_index: 0, part },
          { type: "response.output_item.done", output_index: 0, item },
        ];
      }
      const response = { id, object: "response", created_at: 1791666000, model: MODEL, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 15, total_tokens: 115, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
      return [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        ...deltas,
        { type: "response.completed", response },
      ].map((event, sequence_number) => ({ ...event, sequence_number }));
    }
    const server = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const pathname = new URL(request.url, "http://localhost").pathname;
      const route = pathname.endsWith("/responses") ? "responses"
        : pathname.endsWith("/chat/completions") ? "chat"
        : pathname.endsWith("/messages") ? "messages"
        : pathname.endsWith("/alpha/generate") ? "legacy" : undefined;
      if (request.method !== "POST" || !route) {
        unexpectedRequests.push({ method: request.method, pathname });
        response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); return;
      }
      const body = JSON.parse(raw);
      const rejected = FORCE_UPGRADE && route !== "legacy";
      captures.push({ transport: "http", route, pathname, body, rejected });
      if (rejected) {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { type: "permission_error", code: "upgrade_required", message: "Synthetic test: this account requires an upgrade for the Provider API." } }));
        return;
      }
      const events = reply(route === "legacy" ? body.params : body);
      const item = events.at(-1).response.output[0];
      const isTool = item.type === "function_call";
      const text = isTool ? "" : item.content[0].text;
      if (route === "legacy") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const emit = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
        if (isTool) emit({ type: "tool-call", toolCallId: item.call_id, toolName: item.name, input: JSON.parse(item.arguments) });
        else {
          emit({ type: "text-start", id: "text" });
          for (const event of events) if (event.type === "response.output_text.delta") emit({ type: "text-delta", id: "text", text: event.delta });
          emit({ type: "text-end", id: "text" });
        }
        emit({ type: "finish", finishReason: isTool ? "tool-calls" : "stop", totalUsage: { inputTokens: 100, outputTokens: 15 } });
        response.end();
        return;
      }
      if (body.stream === false) {
        response.writeHead(200, { "content-type": "application/json" });
        const message = isTool ? { role: "assistant", content: null, tool_calls: [{ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } }] }
          : { role: "assistant", content: text };
        response.end(JSON.stringify(route === "chat" ? {
          id: "chat_synthetic", object: "chat.completion", model: MODEL,
          choices: [{ index: 0, message, finish_reason: isTool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 15, total_tokens: 115 },
        } : route === "messages" ? {
          id: "msg_synthetic", type: "message", role: "assistant", model: MODEL,
          content: isTool ? [{ type: "tool_use", id: item.call_id, name: item.name, input: JSON.parse(item.arguments) }] : [{ type: "text", text }],
          stop_reason: isTool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 15 },
        } : events.at(-1).response));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (route === "responses") {
        for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        response.end("data: [DONE]\n\n");
      } else if (route === "chat") {
        const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: "chat_synthetic", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        chunk({ role: "assistant", content: "" });
        if (isTool) chunk({ tool_calls: [{ index: 0, id: item.call_id, type: "function", function: { name: item.name, arguments: "" } }] });
        for (const event of events) {
          if (event.type === "response.function_call_arguments.delta") chunk({ tool_calls: [{ index: 0, function: { arguments: event.delta } }] });
          if (event.type === "response.output_text.delta") chunk({ content: event.delta });
        }
        chunk({}, isTool ? "tool_calls" : "stop");
        response.write(`data: ${JSON.stringify({ id: "chat_synthetic", object: "chat.completion.chunk", model: MODEL, choices: [], usage: { prompt_tokens: 100, completion_tokens: 15, total_tokens: 115 } })}\n\n`);
        response.end("data: [DONE]\n\n");
      } else {
        const emit = (event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        emit({ type: "message_start", message: { id: "msg_synthetic", type: "message", role: "assistant", model: MODEL, content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
        emit({ type: "content_block_start", index: 0, content_block: isTool ? { type: "tool_use", id: item.call_id, name: item.name, input: {} } : { type: "text", text: "" } });
        for (const event of events) {
          if (event.type === "response.function_call_arguments.delta") emit({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: event.delta } });
          if (event.type === "response.output_text.delta") emit({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: event.delta } });
        }
        emit({ type: "content_block_stop", index: 0 });
        emit({ type: "message_delta", delta: { stop_reason: isTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 15 } });
        emit({ type: "message_stop" });
        response.end();
      }
    });
    const wsServer = new WebSocketServer({ server });
    wsServer.on("connection", (socket) => {
      const connection = ++connectionCount;
      socket.on("message", (raw) => {
        const body = JSON.parse(String(raw));
        captures.push({ transport: "websocket", connection, body });
        for (const event of reply(body)) socket.send(JSON.stringify(event));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const configPath = path.join(directory, "guard.config.yaml");
    writeFileSync(configPath, "nda_keywords: []\nprivate_domains: []\ncustom_rules: []\nsettings:\n  env_files:\n    - .env\n");
    let pluginPackage = DIST;
    if (LOST_WS_SEND && transport === "websocket") {
      pluginPackage = path.join(directory, "lost-send-registration");
      mkdirSync(pluginPackage, { mode: 0o700 });
      writeFileSync(path.join(pluginPackage, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
      writeFileSync(path.join(pluginPackage, "index.js"), `
import plugin from ${JSON.stringify(path.join(DIST, "index.js"))};
export default { id: "sg-lost-send-test", async setup(ctx) {
  const session = new Proxy(ctx.session, { get(target, key) {
    if (key !== "hook") return Reflect.get(target, key, target);
    return (name, callback) => target.hook(name, name === "experimental.ws.send" ? () => {} : callback);
  } });
  return plugin.setup(new Proxy(ctx, { get(target, key) {
    return key === "session" ? session : Reflect.get(target, key, target);
  } }));
} };
`);
    }
    writeFileSync(path.join(directory, "config/opencode/opencode.json"), JSON.stringify({
      update: "disable", snapshots: false,
      plugins: [{ package: pluginPackage, options: { mode: "transparent", configPath, wireProtection } }],
      providers: { openai: { env: ["CAPTURE_API_KEY"], package: PROVIDER_PACKAGE, settings: { baseURL: `http://127.0.0.1:${port}${BASE_PATH}`, apiKey: "synthetic-local-key", transport, ...(PLAN ? { plan: PLAN } : {}), ...(LEGACY || FORCE_UPGRADE ? { maxRetries: 0 } : {}) }, models: { [MODEL]: { name: "Capture 1" } } } },
    }, null, 2));
    // Do not inherit provider credentials or the user's OpenCode settings.
    const env = {
      HOME: path.join(directory, "home"), USER: "isolated-test", LOGNAME: "isolated-test", SHELL: "/bin/sh", LANG: "en_US.UTF-8",
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH || "/usr/bin:/bin"}`,
      TMPDIR: directory, PWD: directory, CAPTURE_API_KEY: "synthetic-local-key",
      XDG_CONFIG_HOME: path.join(directory, "config"), XDG_DATA_HOME: path.join(directory, "data"),
      XDG_STATE_HOME: path.join(directory, "state"), XDG_CACHE_HOME: path.join(directory, "cache"),
    };
    let result;
    try { result = await run(directory, env); }
    finally {
      for (const socket of wsServer.clients) socket.terminate();
      wsServer.close(); server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    writeFileSync(path.join(directory, "stdout.jsonl"), result.stdout);
    writeFileSync(path.join(directory, "stderr.log"), result.stderr);
    writeFileSync(path.join(directory, "captures.json"), JSON.stringify(captures, null, 2));
    writeFileSync(path.join(directory, "unexpected-requests.json"), JSON.stringify(unexpectedRequests, null, 2));
    const events = result.stdout.split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    const text = events.filter((event) => event.type === "text").map((event) => event.part?.text || event.text || "").join("\n");
    const originalsAbsent = captures.every((capture) => ![EMAIL, SECRET].some((value) => JSON.stringify(capture.body).includes(value)));
    const operationsOK = existsSync(outputFile) && readFileSync(outputFile, "utf8") === EMAIL + (writeAddsNewline ? "\n" : "")
      && existsSync(shellFile) && readFileSync(shellFile, "utf8") === EMAIL;
    const payload = (capture) => capture.route === "legacy" ? capture.body.params : capture.body;
    const primary = captures.filter((capture) => Array.isArray(payload(capture)?.tools) && payload(capture).tools.length > 0);
    const successfulPrimary = primary.filter((capture) => !capture.rejected);
    const connections = new Set(primary.map((capture) => capture.connection).filter(Boolean));
    const continuedWithOutput = successfulPrimary.slice(1).every((capture) => {
      const body = payload(capture);
      const replay = JSON.stringify(body.input ?? body.messages);
      return /function_call_output|tool_result|tool-result|"role":"tool"/.test(replay);
    });
    const rejectionProven = !result.timedOut && (FORCE_UPGRADE ? captures.length > 0 && originalsAbsent : captures.length === 0) && unexpectedRequests.length === 0
      && !existsSync(outputFile) && !existsSync(shellFile)
      && /Sensitive Guard transparent mode blocked an unsupported model transport route/.test(result.stderr + result.stdout);
    // Hook-only ingress starts from response.created; a missing send hook is
    // normal there, not a restoration failure. Wire mode still needs it.
    const expectedDegradedReply = hookOnlyReply || (LOST_WS_SEND && transport === "websocket" && wireProtection);
    const displayOK = expectedDegradedReply ? text.includes("OK_DONE") && TOKEN.test(text) && !text.includes(EMAIL) : text.includes(`Contact ${EMAIL} OK_DONE`);
    const passed = expectRejection ? rejectionProven : result.code === 0 && !result.timedOut && displayOK && originalsAbsent && operationsOK && successfulPrimary.length === 4 && continuedWithOutput && primary.every((capture) => capture.transport === transport) && unexpectedRequests.length === 0 && (transport !== "websocket" || connections.size === 1);
    rows.push({ name, wireProtection, providerPackage: PROVIDER_PACKAGE, model: MODEL, planPin: PLAN, expectedLegacyRejection: expectRejection, forceUpgrade: FORCE_UPGRADE, rejectionProven: expectRejection ? rejectionProven : undefined, expectedDegradedReply, reportedMissingAttribution: /blocked a WebSocket frame without matching request attribution/.test(result.stderr + result.stdout), passed, code: result.code, timedOut: result.timedOut, originalsAbsent, operationsOK, continuedWithOutput, primaryRequests: primary.length, successfulPrimaryRequests: successfulPrimary.length, routes: [...new Set(captures.map((capture) => capture.route))], primaryRoutes: [...new Set(primary.map((capture) => capture.route))], connections: connections.size, directory });
    writeFileSync(path.join(ROOT, "summary.json"), JSON.stringify(rows, null, 2));
    console.log(`${name}: ${passed ? "PASS" : "FAIL"}; operations=${operationsOK}; originalsAbsent=${originalsAbsent}; requests=${primary.length}; WS connections=${connections.size}`);
  }
}
console.log(`Summary: ${path.join(ROOT, "summary.json")}`);
if (rows.some((row) => !row.passed)) process.exitCode = 1;
