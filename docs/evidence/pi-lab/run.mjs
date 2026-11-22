import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

assert.ok(process.argv[2], "Usage: node run.mjs /path/to/pi");
const cli = resolve(process.argv[2]);
const workspace = await mkdtemp(join(tmpdir(), "pi-boundary-"));
const system = "PI98_PRIVATE_VALUE";
const prompt = "Read PI98_PRIVATE_VALUE.txt then repeat the protected value.";
const captures = [];
let toolIssued = false;
let token;
const invalidTool = process.argv[3] === "invalid-tool";
const server = createServer(async (request, response) => {
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) body += chunk;
  captures.push({ path: request.url, body });
  response.writeHead(200, { "content-type": "text/event-stream" });
  token ??= body.match(/\[SGP2:[^\]]+\]/)?.[0];
  assert.ok(token, "Core must mint a placeholder");
  const choice = !toolIssued
    ? { delta: { role: "assistant", tool_calls: [{ index: 0, id: "read1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: (invalidTool ? token.slice(1) : token) + ".txt" }) } }] }, finish_reason: "tool_calls" }
    : { delta: { role: "assistant", content: token }, finish_reason: "stop" };
  toolIssued = true;
  for (const item of [choice]) {
    response.write("data: " + JSON.stringify({
      id: "stub", object: "chat.completion.chunk", created: 1, model: "stub-model",
      choices: [{ index: 0, ...item }],
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
  await writeFile(join(workspace, "PI98_PRIVATE_VALUE.txt"), "PI98_PRIVATE_VALUE tool output");
  const extension = resolve(import.meta.dirname, "extension.mjs");
  const child = spawn(cli, [
    "--offline", "--print", "--no-session", "--no-extensions", "--no-mcp",
    "--tools", "read", "--no-skills", "--no-prompt-templates", "--no-context-files",
    "--no-approve", "--model", "loopback/stub-model", "--system-prompt", system,
    "--extension", extension, "--", prompt, "Repeat the value again.",
  ], {
    cwd: workspace,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH, HOME: workspace, PI_CODING_AGENT_DIR: agentDir,
      NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", PI98_LAB: "synthetic-loopback-only",
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
  assert.equal(exit, 0, stderr);
  assert.equal(captures.length, 3, stderr);
  assert.ok(captures.every(({body}) => !body.includes("PI98_PRIVATE_VALUE")));
  const toolReply = JSON.parse(captures[1].body).messages.find((message) => message.role === "tool");
  assert.ok(toolReply, "A tool result must return to the model");
  if (invalidTool) {
    assert.ok(JSON.stringify(toolReply).includes("Lab restoration refused"));
    assert.ok(!JSON.stringify(toolReply).includes("tool output"));
  } else {
    assert.ok(JSON.stringify(toolReply).includes("tool output"), "Real read must succeed");
  }
  assert.ok(stderr.includes('PI98_DISPLAY "PI98_PRIVATE_VALUE"'), stderr);
  const history = JSON.parse(captures[2].body).messages.filter((message) => message.role === "assistant");
  assert.ok(history.some((message) => message.content?.includes(token)));
  console.log(JSON.stringify({
    requests: captures.length, rawValueAtProvider: false,
    localReadRestored: !invalidTool, modifiedTokenBlocked: invalidTool, toolOutputMasked: true,
    localDisplayRestored: true, assistantHistoryMasked: true,
  }));

} finally {
  server.close();
  await rm(workspace, { recursive: true, force: true });
}
