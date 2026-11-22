import { randomBytes, createHmac, randomUUID } from "node:crypto";
import { createLabGate } from "./gate.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

assert.ok(process.argv[2], "Usage: node pi-provider-boundary.mjs /path/to/pi");
const cli = resolve(process.argv[2]);
const workspace = await mkdtemp(join(tmpdir(), "pi-boundary-"));
const system = "PI98_PRIVATE_VALUE";
const prompt = "PI98_PRIVATE_VALUE";
const proofKey = randomBytes(32).toString("hex");
let gate;
const captures = [];
const server = createServer(async (request, response) => {
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) body += chunk;
  captures.push({ path: request.url, body });
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const choice of [
    { delta: { role: "assistant", content: "stub-ok" }, finish_reason: null },
    { delta: {}, finish_reason: "stop" },
  ]) {
    response.write("data: " + JSON.stringify({
      id: "stub", object: "chat.completion.chunk", created: 1, model: "stub-model",
      choices: [{ index: 0, ...choice }],
    }) + "\n\n");
  }
  response.end("data: [DONE]\n\n");
});

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const upstream = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  gate = createLabGate(upstream, proofKey);
  await new Promise((resolve) => gate.listen(0, "127.0.0.1", resolve));
  const gateUrl = `http://127.0.0.1:${gate.address().port}/v1`;
  const agentDir = join(workspace, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      loopback: {
        baseUrl: gateUrl,
        api: "openai-completions", apiKey: "synthetic-local-only",
        models: [{ id: "stub-model" }],
      },
    },
  }));
  for (const mode of ["rewrite", "throw", "reject", "disabled"]) {
    captures.length = 0;
    const extension = resolve(import.meta.dirname, "extension.mjs");
    const child = spawn(cli, [
      "--offline", "--print", "--no-session", "--no-extensions", "--no-mcp",
      "--no-tools", "--no-skills", "--no-prompt-templates", "--no-context-files",
      "--no-approve", "--model", "loopback/stub-model", "--system-prompt", system,
      ...(mode !== "disabled" ? ["--extension", extension] : []), "--", prompt,
    ], {
      cwd: workspace,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH, HOME: workspace, PI_CODING_AGENT_DIR: agentDir,
        NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", PI98_LAB: "synthetic-loopback-only",
        PI98_FAILURE: mode, PI98_PROOF_KEY: proofKey,
      },
      timeout: 15000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const expectedRequests = mode === "rewrite" ? 1 : 0;
    assert.equal(captures.length, expectedRequests, stderr);
    assert.ok(captures.every(({body}) => !body.includes(system)));
    assert.equal(exit, mode === "rewrite" ? 0 : 1, stderr);
    console.log(JSON.stringify({mode, upstreamRequests: captures.length, exit}));
  }

  const payload = { model: "stub-model", messages: [{ role: "user", content: "safe" }] };
  const proof = { nonce: randomUUID(), time: Date.now() };
  proof.mac = createHmac("sha256", proofKey)
    .update(JSON.stringify({payload, nonce: proof.nonce, time: proof.time})).digest("hex");
  const signed = { ...payload, _pi98proof: proof };
  const send = (path, body) => fetch(gateUrl + path, {
    method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body),
  });
  captures.length = 0;
  assert.equal((await send("/chat/completions", signed)).status, 200);
  assert.equal((await send("/chat/completions", signed)).status, 400);
  const freshProof = { nonce: randomUUID(), time: Date.now() };
  freshProof.mac = createHmac("sha256", proofKey)
    .update(JSON.stringify({payload, nonce: freshProof.nonce, time: freshProof.time})).digest("hex");
  assert.equal((await send("/chat/completions", {...payload, model: "changed", _pi98proof: freshProof})).status, 400);
  assert.equal((await send("/responses", signed)).status, 400);
  assert.equal((await send("/chat/completions", {})).status, 400);
  assert.equal(captures.length, 1);
  console.log(JSON.stringify({validProof: true, replayBlocked: true, tamperBlocked: true,
    unsupportedRouteBlocked: true, missingProofBlocked: true}));
  captures.length = 0;
  await fetch(upstream, {method: "POST", body: JSON.stringify({messages: [{role: "user", content: system}]})});
  assert.equal(captures.length, 1);
  assert.ok(captures[0].body.includes(system));
  console.log(JSON.stringify({directBypass: "UNCONTAINED", releaseGate: "BLOCKED"}));

} finally {
  gate?.close();
  server.close();
  await rm(workspace, { recursive: true, force: true });
}
