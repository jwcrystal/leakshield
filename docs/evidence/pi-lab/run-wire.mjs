import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createWireLab } from "./wire-proxy.mjs";

assert.ok(process.argv[2], "Usage: node run-wire.mjs /path/to/pi");
const cli = resolve(process.argv[2]);
const extension = resolve(import.meta.dirname, "wire-extension.mjs");
const workspace = await mkdtemp(join(tmpdir(), "pi98-routing-"));
const canary = "PI98_PRIVATE_VALUE";
let credential;
let wireFailure;
let flow = false;
let flowToken;
let streamLatch;
const captures = [];
const gateResponses = [];
const upstream = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  captures.push(JSON.parse(body));
  response.writeHead(200, { "content-type": "text/event-stream" });
  flowToken ??= JSON.stringify(captures.at(-1)).match(/\[SGP2:[^\]]+\]/)?.[0];
  const choice = flow && captures.length === 1
    ? { delta: { role: "assistant", tool_calls: [{ index: 0, id: "read1", type: "function",
        function: { name: "read", arguments: JSON.stringify({path: flowToken + ".txt"}) } }] }, finish_reason: "tool_calls" }
    : { delta: { role: "assistant", content: flowToken ?? "stub-ok" }, finish_reason: "stop" };
  response.write("data: " + JSON.stringify({
    id: "stub", object: "chat.completion.chunk", created: 1, model: "stub-model",
    choices: [{ index: 0, ...choice }],
  }) + "\n\n");
  if (streamLatch) await streamLatch;
  response.end("data: [DONE]\n\n");
});
let gate;

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}/v1`;
}

async function configure(baseUrl) {
  const agentDir = await mkdtemp(join(workspace, "agent-"));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: { loopback: { baseUrl, api: "openai-completions", apiKey: credential,
      models: [{ id: "stub-model" }] } },
  }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 },
    retry: { enabled: false },
  }));
  return agentDir;
}

function start(agentDir, failure, rpc = false) {
  const child = spawn(cli, [
    "--offline", ...(rpc ? ["--mode", "rpc"] : ["--print"]),
    "--no-session", "--no-extensions", "--no-mcp", ...(flow ? ["--tools", "read"] : ["--no-tools"]), "--no-skills",
    "--no-prompt-templates", "--no-context-files", "--no-approve",
    "--model", "loopback/stub-model", "--system-prompt", canary,
    ...(failure === "disabled" ? [] : ["--extension", extension]),
    ...(rpc ? [] : ["--", flow ? "Read " + canary + ".txt" : canary, ...(flow ? ["Repeat the value."] : [])]),
  ], {
    cwd: workspace, stdio: [rpc ? "pipe" : "ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: workspace, PI_CODING_AGENT_DIR: agentDir,
      NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", PI98_LAB: "synthetic-loopback-only",
      PI98_FAILURE: failure, PI98_BROKER_URL: proxyUrl, PI98_BROKER_KEY: credential },
    timeout: 20000,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr }));
  });
  return { child, closed };
}

async function promptCase(name, baseUrl, failure, expectedRequests, rawExpected, exit) {
  captures.length = 0;
  gateResponses.length = 0;
  const { child, closed } = start(await configure(baseUrl), failure);
  child.stdout.resume();
  const result = await closed;
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, exit, result.stderr);
  assert.equal(captures.length, expectedRequests, result.stderr);
  if (flow) {
    assert.ok(result.stderr.includes('PI98_DISPLAY "PI98_PRIVATE_VALUE"'), result.stderr);
    const toolReply = captures[1].messages.find((message) => message.role === "tool");
    assert.ok(JSON.stringify(toolReply).includes("tool output"), "Local read must succeed");
    const assistantHistory = captures[2].messages.filter((message) => message.role === "assistant");
    assert.ok(assistantHistory.some((message) => message.content?.includes(flowToken)));
  }
  const raw = captures.some((payload) => JSON.stringify(payload).includes(canary));
  assert.equal(raw, rawExpected);
  console.log(JSON.stringify({ name, upstreamRequests: captures.length, raw, exit: result.code,
    gateStatuses: [...gateResponses] }));
}

async function compactionCase(failure) {
  const baseUrl = proxyUrl;
  const expectedRequests = failure ? 2 : 4;
  const expectedSuccess = !failure;
  captures.length = 0;
  gateResponses.length = 0;
  const { child, closed } = start(await configure(baseUrl), "rewrite", true);
  const events = new EventEmitter();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => events.emit("message", JSON.parse(line)));
  function waitFor(predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error("RPC event timed out")); }, 10000);
      function cleanup() { clearTimeout(timer); events.off("message", accept); }
      function accept(event) { if (predicate(event)) { cleanup(); resolve(event); } }
      events.on("message", accept);
    });
  }
  function send(command) { child.stdin.write(JSON.stringify(command) + "\n"); }
  try {
    for (let i = 0; i < 2; i++) {
      const ended = waitFor((event) => event.type === "agent_end");
      send({ type: "prompt", id: randomUUID(), message: canary + " context ".repeat(100) });
      await ended;
    }
    assert.equal(captures.length, 2, "Normal prompts must reach the upstream");
    assert.ok(captures.every((payload) => !JSON.stringify(payload).includes(canary)));
    wireFailure = failure;
    const id = randomUUID();
    const finished = waitFor((event) => event.type === "response" && event.id === id);
    send({ type: "compact", id, customInstructions: canary });
    const result = await finished;
    assert.equal(result.success, expectedSuccess, JSON.stringify(result));
    assert.equal(captures.length, expectedRequests, JSON.stringify(result));
    if (!expectedSuccess) {
      assert.deepEqual(gateResponses, [200, 200, 400]);
      assert.match(result.error, /Wire lab refused request/);
    }
    if (expectedSuccess) {
      assert.ok(captures.slice(2).every((payload) => !JSON.stringify(payload).includes(canary)));
    }
    const lastRaw = JSON.stringify(captures.at(-1)).includes(canary);
    assert.equal(lastRaw, false);
    console.log(JSON.stringify({ name: "wire-compaction-" + (failure ?? "normal"),
      upstreamRequests: captures.length, compactSuccess: result.success,
      lastRequestRaw: lastRaw, gateStatuses: [...gateResponses], error: result.error }));
  } finally {
    wireFailure = undefined;
    child.stdin.end();
    child.kill();
    await closed;
    lines.close();
  }
}

let proxyUrl;
try {
  const directUrl = await listen(upstream);
  const lab = createWireLab(directUrl + "/chat/completions", {
    beforeWire() {
      if (wireFailure === "throw") throw new Error("Forced wire masking error");
      if (wireFailure === "reject") return Promise.reject(new Error("Forced wire masking rejection"));
    },
  });
  gate = lab.server;
  credential = lab.credential;
  gate.on("request", (_request, response) => {
    if (_request.url.startsWith("/v1/")) response.on("finish", () => gateResponses.push(response.statusCode));
  });
  proxyUrl = await listen(gate);
  await promptCase("wire-normal", proxyUrl, "rewrite", 1, false, 0);
  for (const failure of ["throw", "reject", "disabled"]) {
    await promptCase("wire-hook-" + failure, proxyUrl, failure, 1, false, 0);
  }
  for (const failure of ["throw", "reject"]) {
    wireFailure = failure;
    await promptCase("wire-mask-" + failure, proxyUrl, "rewrite", 0, false, 1);
  }
  wireFailure = undefined;
  await compactionCase();
  await compactionCase("throw");
  await compactionCase("reject");
  flow = true;
  flowToken = undefined;
  await writeFile(join(workspace, canary + ".txt"), canary + " tool output");
  await promptCase("shared-mapping-tool-display-history", proxyUrl, "rewrite", 3, false, 0);
  flow = false;

  captures.length = 0;
  const send = (path, body, token = credential) => fetch(new URL(path, proxyUrl), {
    method: "POST", headers: {authorization: "Bearer " + token, "content-type": "application/json"},
    body: JSON.stringify(body),
  });
  const rawPayload = {model:"stub-model", messages:[{role:"user",content:canary}]};
  assert.equal((await send("/v1/chat/completions", rawPayload, "wrong")).status, 400);
  assert.equal((await send("/v1/responses", rawPayload)).status, 400);
  assert.equal((await send("/v1/chat/completions", {...rawPayload,model:"other-model"})).status, 400);
  assert.equal((await send("/v1/chat/completions", {model:"stub-model",messages:"unknown"})).status, 400);
  assert.equal((await send("/v1/chat/completions", {
    model:"stub-model",messages:[{role:"user",content:"x".repeat(200001)}],
  })).status, 400);
  assert.equal((await fetch(new URL("/v1/chat/completions", proxyUrl), {
    method: "POST", headers: {authorization: "Bearer " + credential}, body: "{",
  })).status, 400);
  const prepared = await (await send("/lab/mask", rawPayload)).json();
  const token = prepared.messages[0].content;
  assert.ok(token.startsWith("[SGP2:"));
  const call = {tool:"read",input:{path:token + ".txt"}};
  assert.equal((await send("/lab/tool", {...call,input:{path:token.slice(1)}})).status, 400);
  assert.equal((await send("/lab/tool", {...call,tool:"custom"})).status, 400);
  assert.equal((await send("/lab/tool", {...call,input:{...call.input,offset:{code:token}}})).status, 400);
  const other = createWireLab(directUrl + "/chat/completions");
  const otherUrl = await listen(other.server);
  try {
    assert.equal((await fetch(new URL("/lab/tool", otherUrl), {
      method:"POST", headers:{authorization:"Bearer " + other.credential,"content-type":"application/json"},
      body:JSON.stringify(call),
    })).status, 400);
  } finally {
    await new Promise((resolve) => other.server.close(resolve));
  }
  assert.equal(captures.length, 0);
  console.log(JSON.stringify({name:"denial-cases", unauthorizedBlocked:true, unknownRouteBlocked:true,
    unknownShapeBlocked:true, unsupportedModelBlocked:true, scannerLimitBlocked:true, modifiedTokenBlocked:true,
    unknownToolBlocked:true, invalidReadShapeBlocked:true, malformedJsonBlocked:true, foreignSessionTokenBlocked:true, upstreamRequests:0}));
  let releaseStream;
  streamLatch = new Promise((resolve) => { releaseStream = resolve; });
  try {
    const response = await fetch(new URL("/v1/chat/completions", proxyUrl), {
      method: "POST", headers: {authorization: "Bearer " + credential, "content-type": "application/json"},
      body: JSON.stringify(rawPayload), signal: AbortSignal.timeout(3000),
    });
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.ok(new TextDecoder().decode(first.value).includes("data: "));
    // The upstream has not ended its response yet. Receiving this chunk proves incremental forwarding.
    releaseStream();
    while (!(await reader.read()).done) {}
    console.log(JSON.stringify({name:"incremental-sse", chunkReceivedBeforeUpstreamEnd:true}));
  } finally {
    releaseStream();
    streamLatch = undefined;
  }
  await promptCase("direct-route-still-uncontained", directUrl, "disabled", 1, true, 0);
  await new Promise((resolve) => gate.close(resolve));
  await promptCase("wire-proxy-unavailable", proxyUrl, "rewrite", 0, false, 1);

} finally {
  gate?.close();
  upstream.close();
  await rm(workspace, { recursive: true, force: true });
}
