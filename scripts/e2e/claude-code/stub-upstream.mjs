#!/usr/bin/env node
// Loopback stand-in for api.anthropic.com. It records every request it
// receives (method, path, headers with credentials elided, body) to a JSONL
// file so a run can prove what would have reached Anthropic.
//
// /v1/messages plays a scripted tool-using model so Claude Code sends real
// multi-turn history (thinking blocks with signatures, tool_use/tool_result):
//   turn 1: thinking + text + tool_use Bash `cat notes.txt`
//   turn 2: tool_use Bash `wc -c notes.txt`
//   turn 3: text that quotes the first placeholder it received, split across
//           deltas so restoration has to hold a partial placeholder.
// --fail-status <n> answers every /v1/messages with that status instead
// (used to check how Claude Code retries a refusal).
//
// Usage: node stub-upstream.mjs --port 8788 --log /path/received.jsonl
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : fallback;
};
const port = Number(arg("--port", "8788"));
const log = arg("--log", "received.jsonl");
const failStatus = arg("--fail-status", undefined);
const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key", "cookie"]);
const PLACEHOLDER = /\[SGP2:[A-Z_]+-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\]/;

// Claude Code merges consecutive assistant turns into one message, so the
// script position is the number of tool results already sent back.
function assistantTurns(body) {
  return (body?.messages ?? [])
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((block) => block?.type === "tool_result").length;
}

// Claude Code's own context can hold other masked values (the account email,
// for one); quote the API-key placeholder so a run's output shows only the
// synthetic canary.
function finalText(body) {
  const serialized = JSON.stringify(body?.messages ?? []);
  const token = serialized.match(/\[SGP2:API_KEY-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\]/)?.[0] ?? serialized.match(PLACEHOLDER)?.[0];
  return token
    ? `notes.txt holds the key ${token}; I only saw it as a placeholder.`
    : "No placeholder reached the upstream.";
}

function blocksFor(body) {
  const turn = assistantTurns(body);
  if (turn === 0) {
    return [
      { type: "thinking", thinking: "I should read the file first.", signature: "c3R1Yi1zaWduYXR1cmUtMQ==" },
      { type: "text", text: "Reading the file." },
      { type: "tool_use", id: "toolu_stub_1", name: "Bash", input: { command: "cat notes.txt", description: "Show notes" } },
    ];
  }
  if (turn === 1) {
    return [{ type: "tool_use", id: "toolu_stub_2", name: "Bash", input: { command: "wc -c notes.txt", description: "Count bytes" } }];
  }
  return [{ type: "text", text: finalText(body) }];
}

function sse(res, model, blocks) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", {
    type: "message_start",
    message: {
      id: "msg_stub", type: "message", role: "assistant", model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  send("ping", { type: "ping" });
  blocks.forEach((block, index) => {
    if (block.type === "thinking") {
      send("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      send("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
      send("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
    } else if (block.type === "text") {
      send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      const cut = block.text.includes("[SGP2:") ? block.text.indexOf("[SGP2:") + 9 : block.text.length;
      for (const piece of [block.text.slice(0, cut), block.text.slice(cut)].filter(Boolean)) {
        send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } });
      }
    } else {
      send("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    send("content_block_stop", { type: "content_block_stop", index });
  });
  const stop = blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
  send("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, CREDENTIAL_HEADERS.has(k) ? "<present>" : v]),
    );
    appendFileSync(log, JSON.stringify({ method: req.method, url: req.url, headers, body }) + "\n");
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "POST" && path.endsWith("/v1/messages/count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 42 }));
      return;
    }
    if (req.method === "POST" && path.endsWith("/v1/messages")) {
      if (failStatus !== undefined) {
        res.writeHead(Number(failStatus), { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "stub failure" } }));
        return;
      }
      const model = typeof body?.model === "string" ? body.model : "stub";
      const blocks = blocksFor(body);
      if (body?.stream) return sse(res, model, blocks);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_stub", type: "message", role: "assistant", model, content: blocks,
        stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20 },
      }));
      return;
    }
    if (req.method === "HEAD" || req.method === "GET") {
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "stub" } }));
  });
}).listen(port, "127.0.0.1", () => console.log(`stub upstream on http://127.0.0.1:${port}`));
