import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createLabGate } from "./gate.mjs";

assert.ok(process.argv[2], "Usage: node run-routing.mjs /path/to/pi");
const cli = resolve(process.argv[2]);
const extension = resolve(import.meta.dirname, "extension.mjs");
const workspace = await mkdtemp(join(tmpdir(), "pi98-routing-"));
const canary = "PI98_PRIVATE_VALUE";
const key = randomBytes(32).toString("hex");
const captures = [];
const gateResponses = [];
const upstream = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  captures.push(JSON.parse(body));
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end("data: " + JSON.stringify({
    id: "stub", object: "chat.completion.chunk", created: 1, model: "stub-model",
    choices: [{ index: 0, delta: { role: "assistant", content: "stub-ok" }, finish_reason: "stop" }],
  }) + "\n\ndata: [DONE]\n\n");
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
    providers: { loopback: { baseUrl, api: "openai-completions", apiKey: "synthetic-local-only",
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
    "--no-session", "--no-extensions", "--no-mcp", "--no-tools", "--no-skills",
    "--no-prompt-templates", "--no-context-files", "--no-approve",
    "--model", "loopback/stub-model", "--system-prompt", canary,
    ...(failure === "disabled" ? [] : ["--extension", extension]),
    ...(rpc ? [] : ["--", canary]),
  ], {
    cwd: workspace, stdio: [rpc ? "pipe" : "ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: workspace, PI_CODING_AGENT_DIR: agentDir,
      NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", PI98_LAB: "synthetic-loopback-only",
      PI98_FAILURE: failure, PI98_PROOF_KEY: key },
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
  const raw = captures.some((payload) => JSON.stringify(payload).includes(canary));
  assert.equal(raw, rawExpected);
  console.log(JSON.stringify({ name, upstreamRequests: captures.length, raw, exit: result.code,
    gateStatuses: [...gateResponses] }));
}

async function compactionCase(baseUrl, expectedRequests, expectedSuccess, rawExpected) {
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
    if (baseUrl !== proxyUrl) {
      assert.ok(captures.every((payload) => "_pi98proof" in payload));
    }
    const id = randomUUID();
    const finished = waitFor((event) => event.type === "response" && event.id === id);
    send({ type: "compact", id, customInstructions: canary });
    const result = await finished;
    assert.equal(result.success, expectedSuccess, JSON.stringify(result));
    assert.equal(captures.length, expectedRequests, JSON.stringify(result));
    if (!expectedSuccess) {
      assert.deepEqual(gateResponses, [200, 200, 400]);
      assert.match(result.error, /Lab gate refused request/);
    }
    if (expectedSuccess) {
      assert.ok(captures.slice(2).every((payload) => !("_pi98proof" in payload)));
      assert.ok(captures.slice(2).every((payload) => JSON.stringify(payload).includes(canary)));
    }
    const lastRaw = JSON.stringify(captures.at(-1)).includes(canary);
    assert.equal(lastRaw, rawExpected);
    console.log(JSON.stringify({ name: baseUrl === proxyUrl ? "proxy-compaction" : "direct-compaction",
      upstreamRequests: captures.length, compactSuccess: result.success,
      lastRequestRaw: lastRaw, gateStatuses: [...gateResponses], error: result.error }));
  } finally {
    child.stdin.end();
    child.kill();
    await closed;
    lines.close();
  }
}

let proxyUrl;
try {
  const directUrl = await listen(upstream);
  gate = createLabGate(directUrl + "/chat/completions", key);
  gate.on("request", (_request, response) => {
    response.on("finish", () => gateResponses.push(response.statusCode));
  });
  proxyUrl = await listen(gate);
  await promptCase("proxy-normal", proxyUrl, "rewrite", 1, false, 0);
  for (const failure of ["throw", "reject", "disabled"]) {
    await promptCase("proxy-" + failure, proxyUrl, failure, 0, false, 1);
    await promptCase("direct-config-" + failure, directUrl, failure, 1, true, 0);
  }
  await compactionCase(proxyUrl, 2, false, false);
  await compactionCase(directUrl, 4, true, true);
  await new Promise((resolve) => gate.close(resolve));
  await promptCase("proxy-unavailable", proxyUrl, "rewrite", 0, false, 1);
} finally {
  gate?.close();
  upstream.close();
  await rm(workspace, { recursive: true, force: true });
}
