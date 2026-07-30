import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { request, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createWebServer } from "../src/transports/web.js";

const servers: Server[] = [];

function parseCsp(value: string): Map<string, string> {
  return new Map(
    value.split(";").map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/);
      return [name, sources.join(" ")];
    }),
  );
}

async function startServer(): Promise<string> {
  const server = createWebServer();
  servers.push(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function postWithHost(baseUrl: string, host: string): Promise<number> {
  const target = new URL("/scan", baseUrl);
  const body = JSON.stringify({ content: "safe content" });

  return new Promise<number>((resolve, reject) => {
    const req = request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: {
        "Content-Length": Buffer.byteLength(body),
        "Content-Type": "application/json",
        Host: host,
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end(body);
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("local Web UI", () => {
  it("serves the redaction workflow with browser security headers", async () => {
    const baseUrl = await startServer();
    const response = await fetch(baseUrl);
    const html = await response.text();
    const csp = response.headers.get("content-security-policy") ?? "";
    const directives = parseCsp(csp);
    const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    const inlineStyle = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
    const scriptHash = createHash("sha256")
      .update(inlineScript ?? "", "utf8")
      .digest("base64");
    const styleHash = createHash("sha256")
      .update(inlineStyle ?? "", "utf8")
      .digest("base64");

    expect(response.status).toBe(200);
    expect(directives.get("default-src")).toBe("'none'");
    expect(directives.get("base-uri")).toBe("'none'");
    expect(directives.get("connect-src")).toBe("'self'");
    expect(directives.get("form-action")).toBe("'none'");
    expect(directives.get("frame-ancestors")).toBe("'none'");
    for (const directive of [
      "child-src",
      "font-src",
      "frame-src",
      "img-src",
      "manifest-src",
      "media-src",
      "object-src",
      "worker-src",
    ]) {
      expect(directives.get(directive)).toBe("'none'");
    }
    expect(inlineScript).toBeDefined();
    expect(inlineStyle).toBeDefined();
    expect(directives.get("script-src")).toBe(`'sha256-${scriptHash}'`);
    expect(directives.get("script-src-elem")).toBe(`'sha256-${scriptHash}'`);
    expect(directives.get("script-src-attr")).toBe("'none'");
    expect(directives.get("style-src")).toBe(`'sha256-${styleHash}'`);
    expect(directives.get("style-src-elem")).toBe(`'sha256-${styleHash}'`);
    expect(directives.get("style-src-attr")).toBe("'none'");
    expect(directives.get("require-trusted-types-for")).toBe("'script'");
    expect(directives.get("trusted-types")).toBe("'none'");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(csp).not.toContain("style-src 'unsafe-inline'");
    expect(html).not.toContain(".innerHTML");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(html).toContain("脫敏並複製");
    expect(html).toContain("風險判定");
  });

  it("returns a transport-safe decision and verified redaction", async () => {
    const baseUrl = await startServer();
    const secret = `sk-${"a".repeat(24)}`;
    const content = `  const apiKey = "${secret}";\n`;
    const response = await fetch(`${baseUrl}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const body = await response.json() as Record<string, unknown>;
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.decision).toBe("CONFIRM");
    expect(body.riskLevel).toBe("CRITICAL");
    expect(body.redactionVerified).toBe(true);
    expect(body.redactedContent).toContain("[REDACTED_API_KEY]");
    expect(body.redactedContent).toMatch(/^  const apiKey/);
    expect(body.redactedContent).toMatch(/;\n$/);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("originalContent");
    expect(serialized).not.toContain("match_text");
    expect(body).not.toHaveProperty("safePreview");
  });

  it("rejects malformed or empty scan requests", async () => {
    const baseUrl = await startServer();
    const malformed = await fetch(`${baseUrl}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    const empty = await fetch(`${baseUrl}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });

    expect(malformed.status).toBe(400);
    expect(empty.status).toBe(400);
  });

  it("rejects untrusted hosts and unsupported content types", async () => {
    const baseUrl = await startServer();
    const untrustedHostStatus = await postWithHost(baseUrl, "evil.example");
    const unsupportedType = await fetch(`${baseUrl}/scan`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "safe content",
    });

    expect(untrustedHostStatus).toBe(403);
    expect(unsupportedType.status).toBe(415);
  });

  it("rejects request bodies larger than 512 KB", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "a".repeat(513 * 1024) }),
    });

    expect(response.status).toBe(413);
  });

  it("surfaces wasTruncated when scanner exceeds max_chars with no findings", async () => {
    const baseUrl = await startServer();
    const oversized = "safe ".repeat(50000);
    const response = await fetch(`${baseUrl}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: oversized }),
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.decision).toBe("ALLOW");
    expect(body.wasTruncated).toBe(true);
  });

  it("does not rate-limit GET / regardless of POST traffic", async () => {
    const baseUrl = await startServer();
    const before = await fetch(baseUrl);
    expect(before.status).toBe(200);
    const after = await fetch(baseUrl);
    expect(after.status).toBe(200);
  });

  it("accepts Host header with mixed casing for localhost", async () => {
    const baseUrl = await startServer();
    const status = await postWithHost(baseUrl, "LocalHost");
    expect(status).not.toBe(403);
  });
});
