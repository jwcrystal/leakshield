import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGuardCore } from "leakshield/core";

const config = {
  nda_keywords: ["PI98_PRIVATE_VALUE"], private_domains: [], custom_rules: [],
  settings: { max_chars: 200000, show_line_numbers: true, preview_length: 60, encoding_detection: false },
};

// Single managed lab session, one Core owner, loopback research endpoints only.
export function createWireLab(upstream, {
  beforeWire = () => {},
  sessionID = randomUUID(),
  persistence,
  piSessionID,
  upstreamCredential,
} = {}) {
  const destination = new URL(upstream);
  if (destination.protocol !== "http:" || destination.hostname !== "127.0.0.1" ||
      destination.pathname !== "/v1/chat/completions" || destination.search ||
      destination.username || destination.password) throw new Error("Loopback chat endpoint required");
  const credential = randomBytes(32).toString("hex");
  const core = createGuardCore(config, "block", true, persistence, {}, {
    isCodeModeCall: () => false,
    isShellTool: () => false,
    classifyField: () => "verbatim",
    allowsDegradedRestore: () => false,
  });
  if (!core) throw new Error("Lab Core initialization failed");

  async function mask(payload) {
    if (payload?.model !== "stub-model") throw new Error("Unsupported model");
    const event = { sessionID, request: new Request(destination, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    }) };
    await core.onHttpRequest(event);
    return event;
  }

  const server = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== "Bearer " + credential) throw new Error("Unauthorized");
      if (piSessionID && request.headers["x-pi98-session"] !== piSessionID) {
        throw new Error("Session mismatch");
      }
      if (request.method !== "POST" ||
          !["/v1/chat/completions", "/lab/mask", "/lab/display", "/lab/tool"].includes(request.url)) {
        throw new Error("Unsupported route");
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) throw new Error("Body limit");
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (request.url === "/v1/chat/completions") {
        await beforeWire();
        const event = await mask(input);
        const reply = await fetch(destination, {
          method: "POST", headers: {
            "content-type": "application/json",
            ...(upstreamCredential ? { authorization: "Bearer " + upstreamCredential } : {}),
          },
          body: await event.request.text(), redirect: "error", signal: AbortSignal.timeout(5000),
        });
        response.writeHead(reply.status, { "content-type": reply.headers.get("content-type") ?? "text/plain" });
        if (reply.body) await pipeline(Readable.fromWeb(reply.body), response);
        else response.end();
        return;
      }
      let output;
      if (request.url === "/lab/mask") {
        output = await (await mask(input)).request.json();
      } else if (request.url === "/lab/display") {
        if (typeof input?.text !== "string") throw new Error("Invalid display input");
        const event = await mask({ model: "stub-model", messages: [{ role: "user", content: "display" }] });
        event.response = Response.json({ choices: [{ message: { role: "assistant", content: input.text } }] });
        await core.onHttpResponse(event);
        output = { text: (await event.response.json()).choices[0].message.content };
      } else {
        if (input?.tool !== "read" || !input.input || Array.isArray(input.input) ||
            typeof input.input.path !== "string" ||
            Object.keys(input.input).some((key) => !["path", "offset", "limit"].includes(key)) ||
            ["offset", "limit"].some((key) => input.input[key] !== undefined &&
              (!Number.isSafeInteger(input.input[key]) || input.input[key] < 1))) {
          throw new Error("Unsupported tool input");
        }
        const event = { sessionID, tool: "read", input: input.input };
        core.onToolBefore(event);
        output = event.input;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(output));
    } catch {
      if (response.headersSent) {
        response.destroy();
      } else {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Wire lab refused request" } }));
      }
    }
  });
  server.once("close", () => core.dispose());
  return { server, credential };
}
