import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

// Lab-only gate for a single pinned OpenAI-compatible loopback endpoint.
export function createLabGate(upstream, key) {
  const destination = new URL(upstream);
  if (destination.hostname !== "127.0.0.1" || destination.protocol !== "http:") {
    throw new Error("Loopback upstream required");
  }
  const consumed = new Set();
  return createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        throw new Error("Unsupported route");
      }
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 1024 * 1024) throw new Error("Body limit");
      }
      const { _pi98proof: proof, ...payload } = JSON.parse(body);
      if (!proof || typeof proof.nonce !== "string" || typeof proof.time !== "number" ||
          typeof proof.mac !== "string" || !/^[a-f0-9]{64}$/.test(proof.mac) ||
          Math.abs(Date.now() - proof.time) > 10000 || consumed.has(proof.nonce)) {
        throw new Error("Invalid proof");
      }
      const expected = createHmac("sha256", key)
        .update(JSON.stringify({ payload, nonce: proof.nonce, time: proof.time })).digest();
      if (!timingSafeEqual(expected, Buffer.from(proof.mac, "hex"))) throw new Error("Invalid signature");
      consumed.add(proof.nonce);
      const reply = await fetch(destination, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(payload), redirect: "error", signal: AbortSignal.timeout(5000),
      });
      const replyBody = await reply.arrayBuffer();
      response.writeHead(reply.status, { "content-type": reply.headers.get("content-type") ?? "text/plain" });
      response.end(Buffer.from(replyBody));
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Lab gate refused request" } }));
    }
  });
}
