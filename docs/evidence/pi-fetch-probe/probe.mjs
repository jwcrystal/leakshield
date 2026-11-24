import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const here = import.meta.dirname;
const cli = process.argv[2] ?? join(here, "pi-rt/node_modules/.bin/pi");
const ext = join(here, "fetch-ext.mjs");
const CANARY = "PI98_PRIVATE_VALUE";
const captures = [];

const stub = createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  captures.push({ path: req.url, raw: body.includes(CANARY), masked: body.includes("[MASKED]") });
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (req.url.endsWith("/messages")) {
    const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
    ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "stub-model", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "stub-ok" } });
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
    ev("message_stop", {});
    return res.end();
  }
  res.write("data: " + JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 1, model: "stub-model",
    choices: [{ index: 0, delta: { role: "assistant", content: "stub-ok" }, finish_reason: "stop" }] }) + "\n\n");
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${stub.address().port}`;

async function setup(api) {
  const dir = await mkdtemp(join(tmpdir(), "pi-probe-"));
  const baseUrl = api === "anthropic-messages" ? base : base + "/v1";
  await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { loopback: { baseUrl, api, apiKey: "synthetic", models: [{ id: "stub-model" }] } } }));
  await writeFile(join(dir, "settings.json"), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 }, retry: { enabled: false } }));
  return dir;
}

function spawnPi(dir, extra, env = {}, rpc = false) {
  const log = join(dir, "probe.log");
  const child = spawn(cli, ["--offline", ...(rpc ? ["--mode", "rpc"] : ["--print"]), "--no-session", "--no-extensions", "--no-mcp", "--no-tools",
    "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve", "--model", "loopback/stub-model",
    "--system-prompt", CANARY, "--extension", ext, ...extra], {
    cwd: dir, stdio: [rpc ? "pipe" : "ignore", "pipe", "pipe"], timeout: 30000,
    env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir, NO_PROXY: "127.0.0.1", PROBE_LOG: log, ...env } });
  let stderr = ""; child.stderr.on("data", (c) => (stderr += c));
  const closed = new Promise((r) => child.once("close", (code) => r({ code, stderr })));
  return { child, closed, log };
}

async function report(name, closed, log) {
  const r = await closed;
  const probe = (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  console.log(JSON.stringify({ name, exit: r.code, upstream: captures.splice(0), probe, stderr: r.stderr.slice(0, 300) }));
}

for (const api of ["openai-completions", "anthropic-messages", "openai-responses"]) {
  const dir = await setup(api);
  const { closed, log } = spawnPi(dir, ["--", CANARY]);
  await report(api, closed, log);
}
{
  const dir = await setup("openai-completions");
  const { closed, log } = spawnPi(dir, ["--", CANARY], { PROBE_FORCE_ERROR: "1" });
  await report("forced-error", closed, log);
}
{
  const dir = await setup("openai-completions");
  const { child, closed, log } = spawnPi(dir, [], {}, true);
  const lines = createInterface({ input: child.stdout });
  const waitFor = (pred) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout")), 15000);
    lines.on("line", function f(l) { const e = JSON.parse(l); if (pred(e)) { clearTimeout(t); lines.off("line", f); res(e); } });
  });
  for (let i = 0; i < 2; i++) {
    const done = waitFor((e) => e.type === "agent_end");
    child.stdin.write(JSON.stringify({ type: "prompt", id: randomUUID(), message: CANARY + " ctx ".repeat(100) }) + "\n");
    await done;
  }
  const id = randomUUID();
  const done = waitFor((e) => e.type === "response" && e.id === id);
  child.stdin.write(JSON.stringify({ type: "compact", id, customInstructions: CANARY }) + "\n");
  const resp = await done;
  console.log("compact response success=", resp.success, resp.error ?? "");
  child.stdin.end(); child.kill();
  await report("compaction", closed, log);
}
stub.close();
