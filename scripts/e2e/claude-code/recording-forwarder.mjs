#!/usr/bin/env node
// Recording pass-through to the real Anthropic API. Put it between the
// LeakShield proxy and api.anthropic.com to record exactly what leaves the
// machine. Request bodies and response bodies go to a JSONL file; credential
// headers are recorded only as "<present>".
//
// Usage: node recording-forwarder.mjs --port 8789 --log /path/sent.jsonl [--upstream https://api.anthropic.com]
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { Readable } from "node:stream";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : fallback;
};
const port = Number(arg("--port", "8789"));
const log = arg("--log", "sent.jsonl");
const upstream = arg("--upstream", "https://api.anthropic.com");
const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key", "cookie"]);
const DROP_REQUEST = new Set(["host", "connection", "content-length", "accept-encoding", "transfer-encoding", "keep-alive"]);
const DROP_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks);
    const entry = {
      method: req.method,
      url: req.url,
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, CREDENTIAL_HEADERS.has(k) ? "<present>" : v])),
      body: raw.toString("utf8"),
    };
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (!DROP_REQUEST.has(k) && typeof v === "string") headers.set(k, v);
      }
      const response = await fetch(new URL(req.url, upstream), {
        method: req.method,
        headers,
        body: raw.length > 0 ? raw : undefined,
      });
      const out = {};
      response.headers.forEach((v, k) => { if (!DROP_RESPONSE.has(k)) out[k] = v; });
      res.writeHead(response.status, out);
      const received = [];
      if (response.body) {
        for await (const chunk of Readable.fromWeb(response.body)) {
          received.push(chunk);
          res.write(chunk);
        }
      }
      res.end();
      entry.status = response.status;
      entry.response = Buffer.concat(received).toString("utf8");
    } catch (error) {
      entry.error = String(error);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
    appendFileSync(log, JSON.stringify(entry) + "\n");
  });
}).listen(port, "127.0.0.1", () => console.log(`recording forwarder on http://127.0.0.1:${port} -> ${upstream}`));
