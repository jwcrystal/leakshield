import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createPiGuard } from "../src/adapters/pi/guard.js";
import { loadConfig } from "../src/config/loader.js";

const SECRET = "FRAMING_SYNTHETIC_PRIVATE_VALUE";
const config = { ...loadConfig(undefined, process.cwd()), nda_keywords: [SECRET], private_domains: [], custom_rules: [] };
const routes = [
  { api: "openai-completions", path: "/v1/chat/completions", body: { model: "stub", messages: [{ role: "user", content: `中文 ${SECRET}` }] } },
  { api: "anthropic-messages", path: "/v1/messages", body: { model: "stub", max_tokens: 8, messages: [{ role: "user", content: `中文 ${SECRET}` }] } },
  { api: "openai-responses", path: "/v1/responses", body: { model: "stub", input: `中文 ${SECRET}` } },
];

// Real native fetch, synthetic data and loopback only. Existing OpenCode tests
// also assert the shared remaskers remove the header on rebuilt requests.
describe.each(routes)("$api request framing", ({ api, path, body }) => {
  it("drops a stale length and lets fetch send the complete masked UTF-8 body", async () => {
    const received: Array<{ body: string; length: string | undefined }> = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received.push({ body: Buffer.concat(chunks).toString("utf8"), length: req.headers["content-length"] });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing loopback address");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const guard = createPiGuard({
        config,
        fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
          expect((input as Request).headers.get("content-length")).toBeNull();
          return fetch(input, init);
        }) as typeof fetch,
      });
      guard.setSession("framing-test");
      guard.setModel({ api, provider: "stub", id: "stub", baseUrl });
      const response = await guard.handle(new Request(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "1" },
        body: JSON.stringify(body),
      }));
      expect(response.status).toBe(200);
      await response.text();
      expect(received).toHaveLength(1);
      expect(received[0].body).not.toContain(SECRET);
      expect(received[0].body).toContain("中文");
      expect(received[0].body).toContain("[SGP2:");
      expect(received[0].length).toBe(String(Buffer.byteLength(received[0].body)));
      expect(() => JSON.parse(received[0].body)).not.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
