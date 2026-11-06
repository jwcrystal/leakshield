#!/usr/bin/env node
/**
 * Capture server for the leakshield e2e boundary harness (issue #19).
 *
 * Node stdlib only. Implements the minimal OpenAI-compatible surface that
 * `opencode run` needs from a custom provider backed by
 * `@ai-sdk/openai-compatible`:
 *
 *   GET  /v1/models            -> { data: [{ id: "capture-1" }] }
 *   POST /v1/chat/completions  -> parses the body to build a reply, and
 *                                  records it unless CAPTURE_RECORD=0
 *                                  (streaming SSE or plain JSON)
 *   GET  /health               -> readiness probe used by the orchestrator
 *   POST /control              -> orchestrator-only: set response label and
 *                                  arm a one-shot tool_call reply (cases C3/C13)
 *
 * Every /v1/chat/completions request is written to CAPTURE_DIR as a JSON
 * envelope: { receivedAt, seq, method, url, body }. Files are named
 * `raw-<receivedAtMillis>-<seq>.json`; the orchestrator attributes them to
 * test cases by time window and renames them to `<case>-<seq>.json`.
 * (opencode cannot be made to send a custom X-Case header, so attribution
 * happens out-of-band.)
 *
 * Usage: node capture-server.mjs [port]     (port 0 = ephemeral)
 * Env:   CAPTURE_DIR    output directory (default ./out/captured)
 *        CAPTURE_RECORD when "0", record nothing: the body is still parsed to
 *                      build a reply but is never written, so prompts and tool
 *                      context stay off disk. Used by the issue-#26 runners,
 *                      which take their evidence from the in-process egress
 *                      observer instead.
 *
 * Canary values never appear in this server; it only echoes what the host
 * under test sends.
 */
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TRANSPARENT_TOKEN } from "./transparent-token.mjs";

const portArg = process.argv[2] !== undefined ? Number(process.argv[2]) : Number(process.env.PORT || 0);
if (!Number.isFinite(portArg) || portArg < 0 || portArg > 65535) {
  console.error(`capture-server: invalid port ${process.argv[2] ?? process.env.PORT}`);
  process.exit(2);
}
const RECORD = process.env.CAPTURE_RECORD !== "0";
const captureDir = RECORD ? process.env.CAPTURE_DIR || path.join(process.cwd(), "out", "captured") : null;
if (RECORD) mkdirSync(captureDir, { recursive: true });

let seq = 0;
const state = {
  label: "capture",
  toolCallNext: false,
  toolName: "read",
  // Verified against OpenCode v2.0.19: the built-in `read` tool takes `path`.
  toolArgs: { path: "notes.txt" },
  // One-shot: on the next tools-bearing request, echo the first [SGP…] token
  // found in the body back as a tool_call so the plugin's restoration can be
  // observed (case C13).
  echoTokenNext: false,
  restorePathPrefix: "",
  // One-shot (case C15): on the next tools-bearing request, stream a partial
  // reply and destroy the connection — no finish chunk, no [DONE].
  cutStreamNext: false,
  // One-shot (case C17): the reply TEXT embeds a [SGP…] token seen in the
  // request, so the orchestrator can verify display restoration end-to-end.
  echoTokenInTextNext: false,
};

function record(req, bodyRaw) {
  const receivedAt = Date.now();
  seq += 1;
  // Content-free mode: never parse the body, never keep a reference to it.
  if (!RECORD) return { receivedAt, seq, file: null };
  let body = null;
  const raw = bodyRaw == null ? "" : String(bodyRaw);
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = { parseError: true, raw: raw.slice(0, 50000) };
  }
  const envelope = {
    receivedAt,
    seq,
    method: req.method,
    url: req.url,
    headers: {
      "content-type": req.headers["content-type"] ?? null,
      "user-agent": req.headers["user-agent"] ?? null,
    },
    body,
  };
  const file = path.join(captureDir, `raw-${receivedAt}-${seq}.json`);
  writeFileSync(file, JSON.stringify(envelope, null, 2));
  return { receivedAt, seq, file };
}

function completionId() {
  return `chatcmpl-capture-${seq}`;
}

/**
 * Build the assistant message for the current state.
 *
 * The armed tool_call (case C3) must fire on the MAIN agent request, not the
 * title-generation request OpenCode sends first (~100 ms earlier). Title
 * requests carry no `tools` array; main agent requests do — so the one-shot
 * tool_call only triggers on a request that includes tools.
 */
function nextAssistantMessage(parsed) {
  const mainAgentRequest = Array.isArray(parsed?.tools) && parsed.tools.length > 0;
  if (state.echoTokenInTextNext && mainAgentRequest) {
    state.echoTokenInTextNext = false; // one-shot
    // Same token-selection rule as echoTokenNext: prefer the user's own
    // message, fall back to any token in the body.
    const userMessages = (parsed.messages || []).filter((m) => m.role === "user");
    const userText = JSON.stringify(userMessages[userMessages.length - 1] ?? {});
    const token =
      userText.match(TRANSPARENT_TOKEN)?.[0] ??
      JSON.stringify(parsed).match(TRANSPARENT_TOKEN)?.[0];
    if (token) {
      return {
        message: { role: "assistant", content: `Noted. I will contact ${token} about the rotation.` },
        finish: "stop",
      };
    }
    // No token to echo: fall through to the plain reply.
  }
  if (state.echoTokenNext && mainAgentRequest) {
    state.echoTokenNext = false; // one-shot
    // Prefer the token from the user's own message (the canary we control),
    // not the first token in the body (which may be a system-prompt finding).
    const userMessages = (parsed.messages || []).filter((m) => m.role === "user");
    const userText = JSON.stringify(userMessages[userMessages.length - 1] ?? {});
    const token =
      userText.match(TRANSPARENT_TOKEN)?.[0] ??
      JSON.stringify(parsed).match(TRANSPARENT_TOKEN)?.[0];
    const toolNames = new Set(
      (parsed.tools || []).map((tool) => tool?.function?.name).filter(Boolean),
    );
    const call = (name, args) => ({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call-${completionId()}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      finish: "tool_calls",
    });
    if (token && toolNames.has("read")) {
      return call("read", { path: `${state.restorePathPrefix}${token}` });
    }
    // No token or no usable tool: fall through to a plain reply.
  }
  if (state.toolCallNext && mainAgentRequest) {
    state.toolCallNext = false; // one-shot on the first tools-bearing request
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call-${completionId()}`,
            type: "function",
            function: {
              name: state.toolName,
              arguments: JSON.stringify(state.toolArgs),
            },
          },
        ],
      },
      finish: "tool_calls",
    };
  }
  return { message: { role: "assistant", content: `ok ${state.label}` }, finish: "stop" };
}

function writeJson(res, status, payload) {
  const buf = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": buf.length,
  });
  res.end(buf);
}

function writeSseCompletion(res, parsed) {
  const { message, finish } = nextAssistantMessage(parsed);
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish_reason = null) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: "capture-1",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;

  // Case C15 (retry): one-shot hard cut on the MAIN agent request (tools
  // present, so title requests pass through untouched). Partial content, no
  // finish chunk, no [DONE], socket destroyed — the client must treat it as
  // a transport failure and retry (or surface an error). Every attempt still
  // crosses the same wire boundary the plugin masks.
  if (state.cutStreamNext && Array.isArray(parsed?.tools) && parsed.tools.length > 0) {
    state.cutStreamNext = false;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(chunk({ role: "assistant", content: null }));
    res.write(chunk({ content: "partial reply before the connection" }));
    setTimeout(() => res.destroy(), 25);
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(chunk({ role: "assistant", content: null }));
  if (finish === "tool_calls" && Array.isArray(message.tool_calls)) {
    // Emit the tool calls produced by nextAssistantMessage (id/index filled in).
    res.write(
      chunk({
        tool_calls: message.tool_calls.map((call, index) => ({
          index,
          id: call.id ?? `call-${id}-${index}`,
          type: call.type ?? "function",
          function: call.function,
        })),
      }),
    );
  } else {
    res.write(chunk({ content: message.content }));
  }
  res.write(chunk({}, finish));
  if (parsed && parsed.stream_options && parsed.stream_options.include_usage) {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: "capture-1",
        choices: [],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })}\n\n`,
    );
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeCompletion(res, parsed) {
  const { message, finish } = nextAssistantMessage(parsed);
  writeJson(res, 200, {
    id: completionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "capture-1",
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

/** Anthropic Messages helpers (Phase 3, C18). Title requests carry no
 * `tools` array; main agent requests do — same rule as chat completions. */
function anthropicMainAgent(parsed) {
  return Array.isArray(parsed?.tools) && parsed.tools.length > 0;
}

function anthropicReplyText(parsed) {
  const mainAgentRequest = anthropicMainAgent(parsed);
  if (state.echoTokenInTextNext && mainAgentRequest) {
    state.echoTokenInTextNext = false; // one-shot
    const userMessages = (parsed.messages || []).filter((m) => m.role === "user");
    const userText = JSON.stringify(
      userMessages[userMessages.length - 1]?.content ?? userMessages[userMessages.length - 1] ?? {},
    );
    const token =
      userText.match(TRANSPARENT_TOKEN)?.[0] ??
      JSON.stringify(parsed).match(TRANSPARENT_TOKEN)?.[0];
    if (token) return `Noted. I will contact ${token} about the rotation.`;
  }
  return `ok ${state.label}`;
}

function anthropicContentBlocks(parsed) {
  const text = anthropicReplyText(parsed);
  const blocks = [{ type: "text", text }];
  if (state.toolCallNext && anthropicMainAgent(parsed)) {
    state.toolCallNext = false;
    blocks.push({ type: "tool_use", id: `toolu-capture-${seq}`, name: state.toolName, input: state.toolArgs });
  }
  return blocks;
}

function writeAnthropicJson(res, parsed) {
  const blocks = anthropicContentBlocks(parsed);
  writeJson(res, 200, {
    id: `msg-capture-${seq}`,
    type: "message",
    role: "assistant",
    model: "capture-anthropic-1",
    content: blocks,
    stop_reason: blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
    usage: { input_tokens: 0, output_tokens: 0 },
  });
}

function writeAnthropicSse(res, parsed) {
  const blocks = anthropicContentBlocks(parsed);
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(event("message_start", {
    type: "message_start",
    message: { id: `msg-capture-${seq}`, type: "message", role: "assistant", content: [], usage: { input_tokens: 0, output_tokens: 0 } },
  }));
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      res.write(event("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }));
      res.write(event("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }));
      res.write(event("content_block_stop", { type: "content_block_stop", index }));
    } else {
      res.write(event("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }));
      res.write(event("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }));
      res.write(event("content_block_stop", { type: "content_block_stop", index }));
    }
  });
  res.write(event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }));
  res.write(event("message_stop", { type: "message_stop" }));
  res.end();
}

/** OpenAI Responses SSE reply (Phase 3, C19). The reply text embeds an armed
 * [SGP…] token (echoTokenInTextNext) so display restoration is provable. */
function writeResponsesSse(res, parsed) {
  const mainAgentRequest = Array.isArray(parsed?.tools) && parsed.tools.length > 0;
  let text = `ok ${state.label}`;
  if (state.echoTokenInTextNext && mainAgentRequest) {
    state.echoTokenInTextNext = false; // one-shot
    const serialized = JSON.stringify(parsed);
    const token = serialized.match(TRANSPARENT_TOKEN)?.[0];
    if (token) text = `Noted. I will contact ${token} about the rotation.`;
  }
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(event("response.created", { type: "response.created", response: { id: `resp-${seq}` } }));
  const part = { type: "output_text", text, annotations: [] };
  const item = { type: "message", id: `msg-${seq}`, role: "assistant", status: "completed", content: [part] };
  res.write(event("response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...item, status: "in_progress", content: [] },
  }));
  res.write(event("response.content_part.added", {
    type: "response.content_part.added",
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    part: { ...part, text: "" },
  }));
  res.write(event("response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    delta: text,
  }));
  res.write(event("response.output_text.done", {
    type: "response.output_text.done",
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    text,
  }));
  res.write(event("response.content_part.done", {
    type: "response.content_part.done",
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    part,
  }));
  res.write(event("response.output_item.done", {
    type: "response.output_item.done",
    output_index: 0,
    item,
  }));
  res.write(event("response.completed", {
    type: "response.completed",
    response: { id: `resp-${seq}`, status: "completed", output: [item] },
  }));
  res.write("data: [DONE]\n\n");
  res.end();
}

function readBody(req, limitBytes = 20 * 1024 * 1024) {  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  try {
    if (req.method === "GET" && url === "/health") {
      return writeJson(res, 200, { ok: true, seq, label: state.label });
    }
    if (req.method === "GET" && url === "/v1/models") {
      return writeJson(res, 200, {
        object: "list",
        data: [{ id: "capture-1", object: "model", created: 0, owned_by: "capture-server" }],
      });
    }
    if (req.method === "POST" && url === "/control") {
      const parsed = JSON.parse((await readBody(req)) || "{}");
      if (typeof parsed.label === "string") state.label = parsed.label;
      if (typeof parsed.toolName === "string") state.toolName = parsed.toolName;
      if (parsed.toolArgs && typeof parsed.toolArgs === "object") state.toolArgs = parsed.toolArgs;
      if (parsed.toolCallNext === true) state.toolCallNext = true;
      if (parsed.toolCallNext === false) state.toolCallNext = false;
      if (parsed.echoTokenNext === true) state.echoTokenNext = true;
      if (parsed.echoTokenNext === false) state.echoTokenNext = false;
      if (parsed.cutStreamNext === true) state.cutStreamNext = true;
      if (parsed.cutStreamNext === false) state.cutStreamNext = false;
      if (parsed.echoTokenInTextNext === true) state.echoTokenInTextNext = true;
      if (parsed.echoTokenInTextNext === false) state.echoTokenInTextNext = false;
      if (typeof parsed.restorePathPrefix === "string") state.restorePathPrefix = parsed.restorePathPrefix;
      return writeJson(res, 200, { ok: true, state: { ...state, toolArgs: state.toolArgs } });
    }
    if (req.method === "POST" && url === "/v1/chat/completions") {
      const raw = await readBody(req);
      const rec = record(req, raw);
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = null;
      }
      if (parsed && parsed.stream === true) {
        writeSseCompletion(res, parsed);
      } else {
        writeCompletion(res, parsed);
      }
      console.log(`[capture] seq=${rec.seq} stream=${parsed?.stream === true} -> ${rec.file}`);
      return;
    }
    // Anthropic Messages dialect (Phase 3, C18): {baseURL}/messages.
    if (req.method === "POST" && url === "/v1/messages") {
      const raw = await readBody(req);
      const rec = record(req, raw);
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = null;
      }
      if (parsed && parsed.stream === true) {
        writeAnthropicSse(res, parsed);
      } else {
        writeAnthropicJson(res, parsed);
      }
      console.log(`[capture] seq=${rec.seq} anthropic stream=${parsed?.stream === true} -> ${rec.file}`);
      return;
    }
    // OpenAI Responses dialect (Phase 3, C19): {baseURL}/responses.
    if (req.method === "POST" && url === "/v1/responses") {
      const raw = await readBody(req);
      const rec = record(req, raw);
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = null;
      }
      writeResponsesSse(res, parsed);
      console.log(`[capture] seq=${rec.seq} responses stream -> ${rec.file}`);
      return;
    }
    return writeJson(res, 404, { error: { message: `no route ${req.method} ${url}` } });
  } catch (err) {
    console.error(`[capture] error on ${req.method} ${url}: ${err?.message ?? err}`);
    if (!res.headersSent) writeJson(res, 500, { error: { message: String(err?.message ?? err) } });
    else res.end();
  }
});

server.on("error", (err) => {
  console.error(`capture-server: ${err?.message ?? err}`);
  process.exit(1);
});

server.listen(portArg, "127.0.0.1", () => {
  const addr = server.address();
  console.log(`CAPTURE_SERVER_READY port=${addr.port} dir=${RECORD ? captureDir : "none"}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    // Exits immediately: captures are written synchronously, so there is
    // nothing to flush, and a graceful close would block on lingering
    // keep-alive connections.
    process.exit(0);
  });
}
