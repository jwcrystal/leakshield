import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

assert.ok(process.argv[2], "Usage: node pi-provider-boundary.mjs /path/to/pi");
const cli = resolve(process.argv[2]);
const workspace = await mkdtemp(join(tmpdir(), "pi-boundary-"));
const system = "PI98_SYNTHETIC_SYSTEM";
const prompt = "PI98_SYNTHETIC_PROMPT";
const replacement = "PI98_REDACTED";
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
  const agentDir = join(workspace, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      loopback: {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        api: "openai-completions", apiKey: "synthetic-local-only",
        models: [{ id: "stub-model" }],
      },
    },
  }));
  for (const [mode, handler] of [
    ["rewrite", 'return JSON.parse(JSON.stringify(event.payload).replaceAll("PI98_SYNTHETIC_SYSTEM", "PI98_REDACTED").replaceAll("PI98_SYNTHETIC_PROMPT", "PI98_REDACTED"));'],
    ["throw", 'throw new Error("pi98 forced synchronous error");'],
    ["reject", 'return Promise.reject(new Error("pi98 forced promise rejection"));'],
    ["disabled", null],
  ]) {
    captures.length = 0;
    const extension = join(workspace, "fixture.ts");
    if (handler) {
      await writeFile(extension, `export default function(pi) {
        pi.on("before_provider_request", (event) => {
          console.error("pi98 hook invoked");
          ${handler}
        });
      }`);
    }
    const child = spawn(cli, [
      "--offline", "--print", "--no-session", "--no-extensions", "--no-mcp",
      "--no-tools", "--no-skills", "--no-prompt-templates", "--no-context-files",
      "--no-approve", "--model", "loopback/stub-model", "--system-prompt", system,
      ...(handler ? ["--extension", extension] : []), "--", prompt,
    ], {
      cwd: workspace,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH, HOME: workspace, PI_CODING_AGENT_DIR: agentDir,
        NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1",
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
    const report = {
      mode, exit, requests: captures.length, path: captures[0]?.path,
      originalSystem: captures.some(({ body }) => body.includes(system)),
      originalPrompt: captures.some(({ body }) => body.includes(prompt)),
      replacements: captures[0]?.body.split(replacement).length - 1 || 0,
      hookInvoked: stderr.includes("pi98 hook invoked"),
      streamedReply: stdout.includes("stub-ok"),
    };
    console.log(JSON.stringify(report));
    assert.equal(report.hookInvoked, Boolean(handler), stderr);
    if (mode === "rewrite" || mode === "disabled") {
      assert.equal(report.requests, 1, stderr);
      assert.equal(report.path, "/v1/chat/completions");
      assert.equal(report.streamedReply, true, stderr);
      assert.equal(exit, 0, stderr);
    }
    if (mode === "rewrite") {
      assert.equal(report.originalSystem, false);
      assert.equal(report.originalPrompt, false);
      assert.equal(report.replacements, 2);
    }
    if (mode === "disabled") {
      assert.equal(report.originalSystem, true);
      assert.equal(report.originalPrompt, true);
    }
    if ((mode === "throw" || mode === "reject") && report.requests !== 0) {
      process.exitCode = 1;
    }
  }
} finally {
  server.close();
  await rm(workspace, { recursive: true, force: true });
}
