import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const here = import.meta.dirname;
const cli = process.argv[2] ?? join(here, "node_modules/.bin/pi");
const guard = join(here, "gap-guard-ext.mjs");
const CANARY = "PI98_PRIVATE_VALUE";
const captures = [];

const stub = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  captures.push({ path: req.url, raw: body.includes(CANARY), masked: body.includes("[MASKED]"), body });
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write("data: " + JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 1, model: "stub-model", choices: [{ index: 0, delta: { role: "assistant", content: "stub-ok" }, finish_reason: "stop" }] }) + "\n\n");
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${stub.address().port}`;
const dir = await mkdtemp(join(tmpdir(), "pi-autocompact-"));
const log = join(dir, "probe.log");
await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { loopback: { baseUrl: base + "/v1", api: "openai-completions", apiKey: "synthetic", models: [{ id: "stub-model", contextWindow: 700, maxTokens: 256 }] } } }));
await writeFile(join(dir, "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 50 }, retry: { enabled: false } }));

const child = spawn(cli, ["--offline", "--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp", "--no-tools", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve", "--model", "loopback/stub-model", "--system-prompt", CANARY, "--extension", guard], {
  cwd: dir, stdio: ["pipe", "pipe", "pipe"], timeout: 60000,
  env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir, NO_PROXY: "127.0.0.1", PROBE_LOG: log },
});
let stderr = ""; child.stderr.on("data", (c) => (stderr += c));
const lines = createInterface({ input: child.stdout });
const events = [];
lines.on("line", (l) => { try { events.push(JSON.parse(l)); } catch {} });
const waitFor = (pred) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("timeout")), 30000);
  lines.on("line", function f(l) { let e; try { e = JSON.parse(l); } catch { return; } if (pred(e)) { clearTimeout(t); lines.off("line", f); res(e); } });
});
const request = async (msg) => {
  const id = randomUUID();
  const done = waitFor((e) => e.type === "response" && e.id === id);
  child.stdin.write(JSON.stringify({ ...msg, id }) + "\n");
  return done;
};
for (let i = 0; i < 2; i++) {
  const done = waitFor((e) => e.type === "agent_end");
  child.stdin.write(JSON.stringify({ type: "prompt", id: randomUUID(), message: CANARY + " context".repeat(500) }) + "\n");
  await done;
  console.log("turn", i + 1, "captures", captures.length);
}
const entries = await request({ type: "get_entries" });
const stats = await request({ type: "get_session_stats" });
child.stdin.end(); child.kill();
const closed = await new Promise((r) => child.once("close", (code) => r(code)));
const probe = (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
console.log(JSON.stringify({
  exit: closed,
  stubCount: captures.length,
  stubAllMasked: captures.every((c) => c.masked && !c.raw),
  guardCount: probe.filter((p) => p.seen).length,
  guardUrls: [...new Set(probe.filter((p) => p.seen).map((p) => p.seen))],
  finalIsGuard: probe.find((p) => "finalFetchIsGuard" in p)?.finalFetchIsGuard,
  entryTypes: (entries.data?.entries ?? []).map((e) => e.type),
  compactionEntries: (entries.data?.entries ?? []).filter((e) => /compact/i.test(e.type ?? "")).length,
  contextUsage: stats.data?.contextUsage,
  compactionEvents: events.filter((e) => /compaction/.test(e.type)),
  stderr: stderr.slice(0, 200),
}));
stub.close();
