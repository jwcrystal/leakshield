import { createHash } from "node:crypto";
import * as http from "node:http";
import { z } from "zod";
import { loadConfig } from "../config/loader.js";
import { toDecisionResult } from "../decision/model.js";
import { t } from "../i18n/index.js";
import { scanText } from "../scanner/engine.js";
import { redactAndVerify } from "../scanner/redaction-verifier.js";
import { WEB_UI_HTML } from "./web-ui.js";

const MAX_BODY_BYTES = 512 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

const scanRequestSchema = z.object({
  content: z.string().refine((value) => value.trim().length > 0),
});

const rateLimitMap = new Map<string, number[]>();
const inlineScript = WEB_UI_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
const inlineStyle = WEB_UI_HTML.match(/<style>([\s\S]*?)<\/style>/)?.[1];

if (inlineScript === undefined || inlineStyle === undefined) {
  throw new Error("Web UI inline script or style not found");
}

const inlineScriptHash = createHash("sha256")
  .update(inlineScript, "utf8")
  .digest("base64");
const inlineStyleHash = createHash("sha256")
  .update(inlineStyle, "utf8")
  .digest("base64");

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": [
    "default-src 'none'",
    "base-uri 'none'",
    "child-src 'none'",
    "connect-src 'self'",
    "font-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "img-src 'none'",
    "manifest-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    `script-src 'sha256-${inlineScriptHash}'`,
    `script-src-elem 'sha256-${inlineScriptHash}'`,
    "script-src-attr 'none'",
    `style-src 'sha256-${inlineStyleHash}'`,
    `style-src-elem 'sha256-${inlineStyleHash}'`,
    "style-src-attr 'none'",
    "worker-src 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join("; "),
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;

  const hostname = host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : host.split(":", 1)[0];

  const lower = hostname.toLowerCase();
  return lower === "127.0.0.1" || lower === "localhost" || lower === "::1";
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const activeRequests = (rateLimitMap.get(ip) ?? []).filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
  );

  if (activeRequests.length === 0) {
    rateLimitMap.delete(ip);
  }

  if (activeRequests.length >= RATE_LIMIT_MAX) return true;

  rateLimitMap.set(ip, [...activeRequests, now]);
  return false;
}

function writeJson(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(body));
}

function writeError(res: http.ServerResponse, status: number, message: string): void {
  if (res.headersSent || res.destroyed) return;
  writeJson(res, status, { error: message });
}

function handleScanRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ReturnType<typeof loadConfig>,
): void {
  const ip = req.socket.remoteAddress ?? "unknown";
  if (isRateLimited(ip)) {
    writeError(res, 429, "請稍後再試：每分鐘最多掃描 60 次");
    return;
  }

  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    writeError(res, 415, "Content-Type 必須是 application/json");
    return;
  }

  const contentLength = Number.parseInt(req.headers["content-length"] ?? "0", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    writeError(res, 413, "內容超過 512 KB 上限");
    return;
  }

  const chunks: Buffer[] = [];
  let received = 0;
  let complete = false;
  const timer = setTimeout(() => {
    if (complete) return;
    complete = true;
    writeError(res, 408, "請求逾時");
    req.destroy();
  }, BODY_TIMEOUT_MS);

  req.on("data", (chunk: Buffer) => {
    if (complete) return;
    received += chunk.length;

    if (received > MAX_BODY_BYTES) {
      complete = true;
      clearTimeout(timer);
      writeError(res, 413, "內容超過 512 KB 上限");
      req.destroy();
      return;
    }

    chunks.push(chunk);
  });

  req.on("end", () => {
    if (complete) return;
    complete = true;
    clearTimeout(timer);

    try {
      const parsedJson: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const parsedRequest = scanRequestSchema.safeParse(parsedJson);
      if (!parsedRequest.success) {
        writeError(res, 400, "content 必須是非空字串");
        return;
      }

      const { content } = parsedRequest.data;
      const scan = scanText(content, config);
      const {
        originalContent: _originalContent,
        safePreview: _safePreview,
        ...decision
      } = toDecisionResult(scan, content, config);
      const redaction = scan.findings.length > 0
        ? redactAndVerify(content, config)
        : undefined;

      writeJson(res, 200, {
        ...decision,
        redactedContent: redaction?.redacted,
        redactionVerified: redaction?.verified,
        residualFindings: redaction?.residualFindings,
        wasTruncated: redaction?.wasTruncated ?? scan.was_truncated ?? false,
      });
    } catch {
      writeError(res, 400, "無效的 JSON 內容");
    }
  });

  req.on("error", () => {
    complete = true;
    clearTimeout(timer);
    if (!res.headersSent && !res.destroyed) res.destroy();
  });
}

export function createWebServer(): http.Server {
  const config = loadConfig();

  return http.createServer((req, res) => {
    if (!isAllowedHost(req.headers.host)) {
      writeError(res, 403, "不允許的 Host");
      return;
    }

    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": "text/html; charset=utf-8",
      });
      res.end(WEB_UI_HTML);
      return;
    }

    if (req.method === "POST" && req.url === "/scan") {
      handleScanRequest(req, res, config);
      return;
    }

    writeError(res, 404, "找不到資源");
  });
}

export async function runWeb(port: number): Promise<void> {
  const server = createWebServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      console.log(t("web.server_title"));
      console.log(t("web.server_url", { port }));
      console.log(t("web.server_stop"));
      resolve();
    });
  });
}
