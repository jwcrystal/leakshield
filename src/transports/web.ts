import * as http from "http";
import { loadConfig } from "../config/loader.js";
import { scanText } from "../scanner/engine.js";
import type { Finding } from "../types.js";
import { t } from "../i18n/index.js";

// ─── HTML UI ─────────────────────────────────────────────────────────────────

const HTML = String.raw`<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>sensitive-guard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: ui-monospace, "Cascadia Code", "Source Code Pro", monospace; background: #0f1117; color: #e2e8f0; min-height: 100vh; padding: 2rem; }
  h1 { font-size: 1.25rem; font-weight: 700; margin-bottom: 0.25rem; }
  .subtitle { font-size: 0.8rem; color: #64748b; margin-bottom: 1.5rem; }
  .layout { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
  @media (max-width: 800px) { .layout { grid-template-columns: 1fr; } }
  label { font-size: 0.75rem; color: #94a3b8; display: block; margin-bottom: 0.4rem; }
  textarea {
    width: 100%; height: 420px; background: #1e2433; border: 1px solid #2d3748;
    border-radius: 6px; color: #e2e8f0; font-family: inherit; font-size: 0.82rem;
    padding: 0.75rem; resize: vertical; outline: none;
  }
  textarea:focus { border-color: #4f6ef7; }
  .actions { margin-top: 0.75rem; display: flex; gap: 0.75rem; align-items: center; }
  button {
    background: #4f6ef7; color: #fff; border: none; border-radius: 6px;
    padding: 0.5rem 1.25rem; font-family: inherit; font-size: 0.85rem;
    cursor: pointer; font-weight: 600;
  }
  button:hover { background: #3b5bdb; }
  button:disabled { background: #2d3748; color: #64748b; cursor: default; }
  #clearBtn { background: #2d3748; color: #94a3b8; }
  #clearBtn:hover { background: #374151; }
  .status { font-size: 0.78rem; color: #64748b; }
  #result { background: #1e2433; border: 1px solid #2d3748; border-radius: 6px; padding: 1rem; height: 420px; overflow-y: auto; font-size: 0.82rem; }
  .safe-banner { color: #34d399; font-weight: 700; margin-bottom: 0.5rem; }
  .unsafe-banner { color: #f87171; font-weight: 700; margin-bottom: 0.5rem; }
  .recommendation { color: #94a3b8; font-size: 0.78rem; margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid #2d3748; }
  .finding { margin-top: 0.75rem; padding: 0.6rem 0.75rem; border-radius: 4px; border-left: 3px solid; }
  .HIGH  { background: #2d1a1a; border-color: #f87171; }
  .MEDIUM { background: #2d2514; border-color: #fbbf24; }
  .LOW   { background: #1a2030; border-color: #64748b; }
  .finding-header { display: flex; gap: 0.5rem; align-items: baseline; }
  .badge { font-size: 0.7rem; font-weight: 700; padding: 0.1rem 0.4rem; border-radius: 3px; }
  .HIGH .badge { background: #f87171; color: #0f1117; }
  .MEDIUM .badge { background: #fbbf24; color: #0f1117; }
  .LOW .badge { background: #475569; color: #e2e8f0; }
  .finding-type { font-weight: 600; font-size: 0.82rem; }
  .finding-desc { color: #94a3b8; font-size: 0.78rem; margin-top: 0.2rem; }
  .finding-preview { color: #64748b; font-size: 0.75rem; margin-top: 0.15rem; font-style: italic; }
  .finding-loc { color: #475569; font-size: 0.72rem; }
  .empty-state { color: #475569; text-align: center; margin-top: 5rem; }
</style>
</head>
<body>
<h1>🛡️ sensitive-guard</h1>
<p class="subtitle">貼上程式碼或文字，掃描敏感內容後再傳給 AI</p>
<div class="layout">
  <div>
    <label for="input">輸入內容</label>
    <textarea id="input" placeholder="貼上程式碼、config、JSON、文件…"></textarea>
    <div class="actions">
      <button id="scanBtn" onclick="doScan()">掃描</button>
      <button id="clearBtn" onclick="doClear()">清除</button>
      <span class="status" id="status"></span>
    </div>
  </div>
  <div>
    <label>掃描結果</label>
    <div id="result"><div class="empty-state">尚未掃描</div></div>
  </div>
</div>
<script>
async function doScan() {
  const text = document.getElementById('input').value;
  if (!text.trim()) return;
  const btn = document.getElementById('scanBtn');
  const status = document.getElementById('status');
  btn.disabled = true;
  status.textContent = '掃描中…';
  try {
    const res = await fetch('/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });
    const data = await res.json();
    renderResult(data);
    status.textContent = '';
  } catch(e) {
    status.textContent = '錯誤：' + e.message;
  } finally {
    btn.disabled = false;
  }
}
function doClear() {
  document.getElementById('input').value = '';
  document.getElementById('result').innerHTML = '<div class="empty-state">尚未掃描</div>';
  document.getElementById('status').textContent = '';
}
function renderResult(data) {
  const el = document.getElementById('result');
  if (data.safe) {
    el.innerHTML = '<div class="safe-banner">✅ 未偵測到敏感內容，可以安全傳送。</div>'
      + '<div class="recommendation">' + esc(data.recommendation) + '</div>';
    return;
  }
  let html = '<div class="unsafe-banner">' + esc(data.summary) + '</div>';
  for (const f of data.findings) {
    const loc = f.line ? ' <span class="finding-loc">第 '+f.line+' 行, 欄 '+f.column+'</span>' : '';
    html += '<div class="finding ' + f.severity + '">'
      + '<div class="finding-header"><span class="badge">' + f.severity + '</span>'
      + '<span class="finding-type">' + esc(f.type) + '</span>' + loc + '</div>'
      + '<div class="finding-desc">' + esc(f.description) + '</div>'
      + '<div class="finding-preview">預覽：' + esc(f.preview) + '</div>'
      + '</div>';
  }
  html += '<div class="recommendation">' + esc(data.recommendation) + '</div>';
  el.innerHTML = html;
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
document.getElementById('input').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doScan();
});
</script>
</body>
</html>`;

// ─── Web Server ───────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 512 * 1024; // 512 KB — reject oversized payloads early
const BODY_TIMEOUT_MS = 10_000;    // 10 s   — abort stalled uploads
const RATE_LIMIT_MAX = 60;         // max requests per window per IP
const RATE_LIMIT_WINDOW_MS = 60_000;

// Sliding-window rate limiter keyed by remote IP.
const rateLimitMap = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const window = (rateLimitMap.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (window.length >= RATE_LIMIT_MAX) return true;
  window.push(now);
  rateLimitMap.set(ip, window);
  return false;
}

function jsonError(res: http.ServerResponse, status: number, message: string) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: message }));
}

export async function runWeb(port: number) {
  const config = loadConfig();

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HTML);
      return;
    }

    if (req.method === "POST" && req.url === "/scan") {
      const ip = req.socket.remoteAddress ?? "unknown";

      if (isRateLimited(ip)) {
        jsonError(res, 429, "rate limit exceeded — max 60 requests per minute");
        return;
      }

      const contentLength = parseInt(req.headers["content-length"] ?? "0", 10);
      if (contentLength > MAX_BODY_BYTES) {
        jsonError(res, 413, "request body too large — max 512 KB");
        return;
      }

      const chunks: Buffer[] = [];
      let received = 0;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        req.destroy();
        jsonError(res, 408, "request timeout");
      }, BODY_TIMEOUT_MS);

      req.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_BODY_BYTES) {
          clearTimeout(timer);
          req.destroy();
          jsonError(res, 413, "request body too large — max 512 KB");
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        clearTimeout(timer);
        if (timedOut) return;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { content?: string };
          const content = body.content ?? "";
          const result = scanText(content, config);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(result));
        } catch {
          jsonError(res, 400, "invalid JSON body");
        }
      });

      req.on("error", () => {
        clearTimeout(timer);
      });

      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(t("web.server_title"));
    console.log(t("web.server_url", { port }));
    console.log(t("web.server_stop"));
  });
}
