// Probes for the three open items in docs/evidence/2026-11-23-pi-in-process-fetch-interception.md
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, appendFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const here = import.meta.dirname;
const cli = process.argv[2] ?? join(here, "node_modules/.bin/pi");
const guard = join(here, "gap-guard-ext.mjs");
const early = join(here, "early-ext.mjs");
const watch = join(here, "watch.cjs");
const CANARY = "PI98_PRIVATE_VALUE";

const captures = [];
let delayMs = 0;
const stub = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  captures.push({ path: req.url, raw: body.includes(CANARY), masked: body.includes("[MASKED]"), probe: body.includes('"probe"') });
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (req.url.includes("/messages")) {
    const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
    ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "stub-model", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "stub-ok" } });
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
    ev("message_stop", {});
    return res.end();
  }
  res.write("data: " + JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 1, model: "stub-model", choices: [{ index: 0, delta: { role: "assistant", content: "stub-ok" }, finish_reason: "stop" }] }) + "\n\n");
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${stub.address().port}`;

async function setup(api, { contextWindow = 128000, compaction = { enabled: false } } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-gap-"));
  const baseUrl = api === "anthropic-messages" ? base : base + "/v1";
  await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { loopback: { baseUrl, api, apiKey: "synthetic", models: [{ id: "stub-model", contextWindow, maxTokens: 256 }] } } }));
  await writeFile(join(dir, "settings.json"), JSON.stringify({ compaction, retry: { enabled: false } }));
  return dir;
}

function spawnPi(dir, { ext = [guard], extra = [], env = {}, rpc = false } = {}) {
  const log = join(dir, "probe.log");
  const netlog = join(dir, "net.log");
  const child = spawn(cli, ["--offline", ...(rpc ? ["--mode", "rpc"] : ["--print"]), "--no-session", "--no-extensions", "--no-mcp", "--no-tools",
    "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve", "--model", "loopback/stub-model",
    "--system-prompt", CANARY, ...ext.flatMap((e) => ["--extension", e]), ...extra], {
    cwd: dir, stdio: [rpc ? "pipe" : "ignore", "pipe", "pipe"], timeout: 60000,
    env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir, NO_PROXY: "127.0.0.1",
      PROBE_LOG: log, NET_LOG: netlog, NODE_OPTIONS: `--require ${watch}`, STUB_URL: `${base}/v1/chat/completions`, CANARY, ...env } });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  const closed = new Promise((r) => child.once("close", (code) => r({ code, stderr })));
  return { child, closed, log, netlog };
}

const readJsonl = async (p) => (await readFile(p, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { unparsed: l }; } });

async function report(name, closed, { log, netlog }) {
  const r = await closed;
  const probe = await readJsonl(log);
  const net = await readJsonl(netlog);
  const stubPort = stub.address().port;
  const stubConns = net.filter((n) => Number(n.port) === Number(stubPort));
  console.log(JSON.stringify({
    name, exit: r.code,
    upstream: captures.splice(0),
    guard: { loaded: probe.filter((p) => p.loaded).length, calls: probe.filter((p) => p.seen).length, refused: probe.filter((p) => p.refused).length, early: probe.filter((p) => p.early).length, finalIsGuard: probe.find((p) => "finalFetchIsGuard" in p)?.finalFetchIsGuard },
    net: { stubConnections: stubConns.length, other: net.filter((n) => Number(n.port) !== Number(stubPort)).map((n) => `${n.host}:${n.port}`) },
    stderr: r.stderr.slice(0, 200),
  }));
}

// 1. all three wire formats, count parity between stub and guard
for (const api of ["openai-completions", "anthropic-messages", "openai-responses"]) {
  const dir = await setup(api);
  const p = spawnPi(dir, { extra: ["--", CANARY] });
  await report(`route:${api}`, p.closed, p);
}

// 2. automatic compaction: tiny context window, two RPC prompts
{
  const dir = await setup("openai-completions", { contextWindow: 700, compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 50 } });
  const p = spawnPi(dir, { rpc: true });
  const lines = createInterface({ input: p.child.stdout });
  const waitFor = (pred) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout")), 30000);
    lines.on("line", function f(l) { let e; try { e = JSON.parse(l); } catch { return; } if (pred(e)) { clearTimeout(t); lines.off("line", f); res(e); } });
  });
  for (let i = 0; i < 2; i++) {
    const done = waitFor((e) => e.type === "agent_end");
    p.child.stdin.write(JSON.stringify({ type: "prompt", id: randomUUID(), message: CANARY + " context".repeat(500) }) + "\n");
    await done;
  }
  p.child.stdin.end(); p.child.kill();
  await report("auto-compaction", p.closed, p);
}

// 3. extension order: an extension loaded before the guard keeps the original fetch
{
  delayMs = 3000;
  const dir = await setup("openai-completions");
  const p = spawnPi(dir, { ext: [early, guard], extra: ["--", CANARY] });
  await report("order:early-before-guard", p.closed, p);
  delayMs = 0;
}

stub.close();
