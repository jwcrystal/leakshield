#!/usr/bin/env node
/** Native OpenAI Responses comparison over HTTP, an explicit WebSocket and the
 * host's default transport: baseline / SG / official Rehydra / EightDoor.
 * Loopback provider stand-in, synthetic canaries, no credentials. See README.md.
 *   node scripts/e2e/compare/responses.mjs [--suite=a,b] [--transport=http,websocket,default] [--assert]
 * Third-party suites run only when E2E_REHYDRA_PACKAGE / E2E_EIGHTDOOR_PACKAGE are set.
 *
 * Reported per case:
 *   leaks   = number of provider requests carrying any canary (title and primary
 *             count separately, so an unprotected case reports 2);
 *   primary = transports that carried the main (tool-bearing) request;
 *   restored = the user-visible reply shows the original value. */
import http from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import {
  CANARIES, EMAIL, SECRET, SG_DIST, TOKEN, defaultSuites, isolatedEnv, makeOutputRoot,
  pluginsFor, prepareCaseDirectory, preflight, selected,
} from "./common.mjs";

const suites = selected("suite", defaultSuites());
const transports = selected("transport", ["http", "websocket", "default"]);
const { bin: BIN, version: HOST_VERSION } = preflight(suites);
const OUT = makeOutputRoot("sg-compare-responses");
const MODEL = "capture-1";

/** One Responses reply as the event sequence both HTTP SSE and WS carry. */
function replyEvents(body, count) {
  const main = Array.isArray(body.tools) && body.tools.length > 0;
  const user = (body.input ?? []).filter((item) => item.role === "user").at(-1);
  const token = [...JSON.stringify(user ?? {}).matchAll(TOKEN)][0]?.[0];
  // Unprotected cases echo the original; protected ones echo the placeholder
  // the plugin gave the model, split across two deltas, so restoration is real.
  const text = main ? `Contact ${token ?? EMAIL} OK_DONE` : "Synthetic test title";
  const id = `resp_test_${count}`, itemID = `msg_test_${count}`;
  const part = { type: "output_text", text, annotations: [] };
  const item = { type: "message", id: itemID, role: "assistant", status: "completed", content: [part] };
  const response = { id, object: "response", created_at: 1791666000, model: MODEL, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 15, total_tokens: 115 } };
  const cut = Math.floor(text.length / 2);
  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: itemID, output_index: 0, content_index: 0, part: { ...part, text: "" } },
    { type: "response.output_text.delta", item_id: itemID, output_index: 0, content_index: 0, delta: text.slice(0, cut) },
    { type: "response.output_text.delta", item_id: itemID, output_index: 0, content_index: 0, delta: text.slice(cut) },
    { type: "response.output_text.done", item_id: itemID, output_index: 0, content_index: 0, text },
    { type: "response.content_part.done", item_id: itemID, output_index: 0, content_index: 0, part },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ].map((event, sequence_number) => ({ ...event, sequence_number }));
}

const parseEvents = (stdout) => stdout.split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });

function runCLI(args, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(BIN, ["run", "--standalone", "--format", "json", "--model", `openai/${MODEL}`, "--auto", "--print-logs", ...args], {
      cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, 45000);
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, timedOut, stdout, stderr: stderr + error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, timedOut, stdout, stderr }); });
  });
}

async function runCase(suite, transport) {
  const dir = path.join(OUT, `${suite}--${transport}`);
  const guardConfig = prepareCaseDirectory(dir);
  const captures = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (request.method !== "POST" || !new URL(request.url, "http://localhost").pathname.endsWith("/responses")) {
      response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); return;
    }
    const body = JSON.parse(raw);
    captures.push({ transport: "http", main: Array.isArray(body.tools) && body.tools.length > 0, body });
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of replyEvents(body, captures.length)) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  const wsServer = new WebSocketServer({ server });
  wsServer.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const body = JSON.parse(String(raw));
      captures.push({ transport: "websocket", main: Array.isArray(body.tools) && body.tools.length > 0, body });
      for (const event of replyEvents(body, captures.length)) socket.send(JSON.stringify(event));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const settings = { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "synthetic-local-key", ...(transport === "default" ? {} : { transport }) };
  writeFileSync(path.join(dir, "config/opencode/opencode.json"), JSON.stringify({
    update: "disable", snapshots: false,
    plugins: pluginsFor(suite, { dir, guardConfig }),
    providers: { openai: { name: "Local synthetic OpenAI", env: ["CAPTURE_API_KEY"], package: "@opencode/ai/providers/openai", settings, models: { [MODEL]: { name: "Capture 1" } } } },
  }, null, 2));
  const prompt = `"Contact ${EMAIL} and rotate ${SECRET}."`;
  let result;
  try {
    result = await runCLI([prompt], dir, isolatedEnv(dir, BIN));
  } finally {
    for (const client of wsServer.clients) client.terminate();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  writeFileSync(path.join(dir, "stdout.jsonl"), result.stdout);
  writeFileSync(path.join(dir, "stderr.log"), result.stderr);
  writeFileSync(path.join(dir, "captures.json"), JSON.stringify(captures, null, 2));
  const text = parseEvents(result.stdout).filter((event) => event.type === "text").map((event) => event.part?.text ?? event.text ?? "").join("\n");
  const leakCount = captures.filter((capture) => CANARIES.some((value) => JSON.stringify(capture.body).includes(value))).length;
  const row = {
    suite, transport,
    completed: result.code === 0 && !result.timedOut && text.includes("OK_DONE"),
    restored: text.includes(EMAIL),
    leakCount,
    primary: [...new Set(captures.filter((capture) => capture.main).map((capture) => capture.transport))],
    title: [...new Set(captures.filter((capture) => !capture.main).map((capture) => capture.transport))],
    code: result.code, timedOut: result.timedOut, dir,
  };
  writeFileSync(path.join(dir, "result.json"), JSON.stringify(row, null, 2));
  console.log(`${suite.padEnd(10)} ${transport.padEnd(10)} conversation=${row.completed ? "OK" : "FAIL"} restored=${row.restored} leaks=${leakCount} primary=${row.primary.join(",") || "none"} exit=${row.code}`);
  return row;
}

console.log(`Native OpenAI Responses comparison on OpenCode ${HOST_VERSION}; suites=${suites.join(",")}; SG=${SG_DIST}\nEvidence: ${OUT}`);
const rows = [];
for (const suite of suites) {
  for (const transport of transports) {
    rows.push(await runCase(suite, transport));
    writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(rows, null, 2));
  }
}
console.log(`Done: ${rows.length} cases. ${path.join(OUT, "summary.json")}`);
if (process.argv.includes("--assert") && rows.some((row) => !row.completed || (row.suite !== "baseline" && (row.leakCount > 0 || !row.restored)))) process.exitCode = 1;
