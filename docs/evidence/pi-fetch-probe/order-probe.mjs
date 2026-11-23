import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = import.meta.dirname;
const cli = process.argv[2] ?? join(here, "node_modules/.bin/pi");
const guard = join(here, "gap-guard-ext.mjs");
const early = join(here, "early-ext.mjs");
const CANARY = "PI98_PRIVATE_VALUE";
const captures = [];

const stub = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  captures.push({ path: req.url, raw: body.includes(CANARY), masked: body.includes("[MASKED]"), probe: body.includes('"probe"') });
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write("data: " + JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 1, model: "stub-model", choices: [{ index: 0, delta: { role: "assistant", content: "stub-ok" }, finish_reason: "stop" }] }) + "\n\n");
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${stub.address().port}`;

async function run(name, { settingsExt = [], cliExt = [] }) {
  const dir = await mkdtemp(join(tmpdir(), "pi-order-"));
  const log = join(dir, "probe.log");
  await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { loopback: { baseUrl: base + "/v1", api: "openai-completions", apiKey: "synthetic", models: [{ id: "stub-model" }] } } }));
  await writeFile(join(dir, "settings.json"), JSON.stringify({ retry: { enabled: false }, ...(settingsExt.length ? { extensions: settingsExt } : {}) }));
  const child = spawn(cli, ["--offline", "--print", "--no-session", ...(settingsExt.length ? [] : ["--no-extensions"]), "--no-mcp", "--no-tools", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve", "--model", "loopback/stub-model", "--system-prompt", CANARY, ...cliExt.flatMap((e) => ["--extension", e]), "--", CANARY], {
    cwd: dir, stdio: ["ignore", "pipe", "pipe"], timeout: 60000,
    env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir, NO_PROXY: "127.0.0.1", PROBE_LOG: log, STUB_URL: `${base}/v1/chat/completions`, CANARY },
  });
  let stderr = ""; child.stderr.on("data", (c) => (stderr += c));
  const code = await new Promise((r) => child.once("close", (code) => r(code)));
  const probe = (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const loaded = probe.filter((p) => p.loaded).map((p) => `${p.order}:${p.loaded}`);
  const earlyResult = probe.find((p) => p.early);
  console.log(JSON.stringify({ name, exit: code, loaded, earlyResult, upstream: captures.splice(0).map((c) => ({ raw: c.raw, masked: c.masked, probe: c.probe })), stderr: stderr.slice(0, 120) }));
}

await run("cli: early,guard", { cliExt: [early, guard] });
await run("cli: guard,early", { cliExt: [guard, early] });
await run("settings: early,guard", { settingsExt: [early, guard] });
await run("settings: guard,early", { settingsExt: [guard, early] });
await run("settings: early + cli: guard", { settingsExt: [early], cliExt: [guard] });
await run("cli: guard + settings: early", { cliExt: [guard], settingsExt: [early] });
stub.close();
