export const WEB_UI_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>LeakShield | Local Redaction Workbench</title>
<style>
  :root {
    --bg: #090b0d;
    --surface: #111519;
    --surface-raised: #171c21;
    --line: #283038;
    --line-strong: #3b4650;
    --text: #edf2f4;
    --muted: #8b98a3;
    --dim: #5d6972;
    --accent: #b9f227;
    --accent-ink: #101500;
    --danger: #ff665c;
    --warning: #ffc857;
    --safe: #57d98b;
    --radius: 3px;
  }

  * { box-sizing: border-box; }
  html { min-width: 320px; background: var(--bg); }
  body {
    margin: 0;
    min-height: 100vh;
    color: var(--text);
    background:
      linear-gradient(rgba(255,255,255,.018) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.018) 1px, transparent 1px),
      var(--bg);
    background-size: 32px 32px;
    font-family: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
  }

  button, textarea { font: inherit; }
  button:focus-visible, textarea:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .shell { width: min(1480px, 100%); margin: 0 auto; padding: 28px; }
  .topbar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 24px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--line);
  }
  .brand { display: flex; align-items: center; gap: 13px; }
  .mark {
    width: 38px;
    height: 38px;
    display: grid;
    place-items: center;
    color: var(--accent);
    border: 1px solid var(--accent);
    clip-path: polygon(12% 0, 100% 0, 100% 72%, 72% 100%, 0 100%, 0 12%);
  }
  h1 { margin: 0; font-size: 17px; letter-spacing: .08em; text-transform: uppercase; }
  .tagline { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
  .tagline-part { display: inline-block; }
  .local-badge {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    color: var(--safe);
    border: 1px solid #245d3b;
    background: #0d1d14;
    font-size: 11px;
    letter-spacing: .06em;
    text-transform: uppercase;
  }
  .local-badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

  .workflow {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 16px;
  }
  .panel { min-width: 0; border: 1px solid var(--line); background: rgba(17, 21, 25, .96); }
  .panel-head {
    min-height: 48px;
    padding: 12px 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px solid var(--line);
  }
  .panel-title { display: flex; align-items: center; gap: 9px; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; }
  .step { color: var(--accent); }
  .metrics { color: var(--dim); font-size: 11px; white-space: nowrap; }
  textarea {
    display: block;
    width: 100%;
    min-height: 440px;
    padding: 18px;
    resize: vertical;
    border: 0;
    color: #dbe4e8;
    background: #0d1013;
    font-size: 13px;
    line-height: 1.65;
    tab-size: 2;
    white-space: pre-wrap;
    word-break: break-all;
  }
  textarea::placeholder { color: #45515a; }
  #output { color: #c9e7d4; }
  #output:placeholder-shown { background: linear-gradient(135deg, #0d1013, #10151a); }

  .toolbar {
    min-height: 58px;
    padding: 10px 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    border-top: 1px solid var(--line);
    background: var(--surface-raised);
  }
  .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  button {
    min-height: 36px;
    padding: 8px 13px;
    cursor: pointer;
    color: var(--text);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: #20262c;
    font-size: 12px;
  }
  button:hover:not(:disabled) { border-color: #687782; background: #283038; }
  button:disabled { cursor: not-allowed; opacity: .42; }
  .primary { color: var(--accent-ink); border-color: var(--accent); background: var(--accent); font-weight: 700; }
  .primary:hover:not(:disabled) { border-color: #d1ff5b; background: #d1ff5b; }
  .shortcut { color: var(--dim); font-size: 10px; }

  .report {
    margin-top: 16px;
    border: 1px solid var(--line);
    background: rgba(17, 21, 25, .96);
  }
  .report[aria-busy="true"] { position: relative; }
  .report[aria-busy="true"]::after {
    content: "";
    position: absolute;
    top: 14px;
    right: 14px;
    width: 14px;
    height: 14px;
    border: 2px solid var(--line-strong);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin .7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .report-head {
    padding: 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    border-bottom: 1px solid var(--line);
  }
  .decision { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .decision-chip {
    padding: 5px 8px;
    color: var(--muted);
    border: 1px solid var(--line-strong);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .08em;
    white-space: nowrap;
  }
  .decision-chip.ALLOW { color: var(--safe); border-color: #2d7048; }
  .decision-chip.WARN { color: var(--warning); border-color: #765f2a; }
  .decision-chip.CONFIRM { color: var(--danger); border-color: #74342f; }
  .summary { overflow: hidden; color: var(--muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
  .status { color: var(--muted); font-size: 11px; text-align: right; }
  .status.error { color: var(--danger); }
  .status.success { color: var(--safe); }

  .findings { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .finding {
    min-width: 0;
    padding: 14px;
    border: 0;
    border-right: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    border-radius: 0;
    background: transparent;
    text-align: left;
  }
  .finding:hover { background: var(--surface-raised); }
  .finding-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .severity { font-size: 10px; font-weight: 700; letter-spacing: .06em; }
  .severity.HIGH { color: var(--danger); }
  .severity.MEDIUM { color: var(--warning); }
  .severity.LOW { color: #8ea1ff; }
  .location { color: var(--dim); font-size: 10px; }
  .finding-type { display: block; margin-top: 8px; font-size: 12px; }
  .finding-desc { display: block; margin-top: 4px; color: var(--muted); font-size: 11px; line-height: 1.5; }
  .empty { padding: 28px 14px; color: var(--dim); font-size: 12px; text-align: center; }
  .notice { padding: 10px 14px; color: var(--warning); border-top: 1px solid #58491f; background: #1b180d; font-size: 11px; }

  @media (max-width: 980px) {
    .workflow { grid-template-columns: 1fr; }
    textarea { min-height: 330px; }
    .findings { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 620px) {
    .shell { padding: 16px; }
    .topbar { align-items: stretch; flex-direction: column; }
    .local-badge { align-self: flex-start; }
    textarea { min-height: 280px; }
    .toolbar, .report-head { align-items: stretch; flex-direction: column; }
    .decision { align-items: flex-start; flex-wrap: wrap; }
    .summary { width: 100%; overflow: visible; text-overflow: clip; white-space: normal; line-height: 1.5; }
    .toolbar .actions { width: 100%; }
    .toolbar button { flex: 1; }
    .shortcut, .status { text-align: left; }
    .findings { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<main class="shell">
  <header class="topbar">
    <div class="brand">
      <div class="mark" aria-hidden="true">LS</div>
      <div>
        <h1>LeakShield</h1>
        <p class="tagline"><span class="tagline-part">本機敏感內容檢查台</span> <span class="tagline-part" lang="en">/ Local redaction workbench</span></p>
      </div>
    </div>
    <div class="local-badge"><span lang="en">Local only</span> · 127.0.0.1</div>
  </header>

  <section class="workflow" aria-label="敏感內容處理流程">
    <article class="panel">
      <div class="panel-head">
        <div class="panel-title"><span class="step">01</span><span>原始內容</span></div>
        <span class="metrics" id="inputMetrics">0 字元 · 0 行</span>
      </div>
      <textarea id="input" aria-label="原始內容" spellcheck="false" placeholder="貼上準備傳給 AI 的程式碼、設定或文件…"></textarea>
      <div class="toolbar">
        <div class="actions">
          <button class="primary" id="scanBtn" type="button">掃描內容</button>
          <button id="cancelBtn" type="button" hidden>取消</button>
          <button id="sampleBtn" type="button">載入範例</button>
          <button id="clearBtn" type="button">清除</button>
        </div>
        <span class="shortcut"><span lang="en">⌘/Ctrl + Enter</span> · 上限 512 KB</span>
      </div>
    </article>

    <article class="panel">
      <div class="panel-head">
        <div class="panel-title"><span class="step">02</span><span>安全版本</span></div>
        <span class="metrics" id="outputMetrics">等待掃描</span>
      </div>
      <textarea id="output" aria-label="脫敏後內容" readonly placeholder="掃描後的安全內容會出現在這裡"></textarea>
      <div class="toolbar">
        <div class="actions">
          <button class="primary" id="copyBtn" type="button" disabled>脫敏並複製</button>
        </div>
        <span class="status" id="copyStatus" aria-live="polite"></span>
      </div>
    </article>
  </section>

  <section class="report" id="report" aria-labelledby="reportTitle">
    <div class="report-head">
      <div class="decision">
        <span class="panel-title" id="reportTitle">風險判定</span>
        <span class="decision-chip" id="decisionChip"><span lang="en">NOT SCANNED</span></span>
        <span class="summary" id="summary">貼上內容後執行掃描</span>
      </div>
      <span class="status" id="scanStatus" aria-live="polite"></span>
    </div>
    <div class="findings" id="findings" aria-live="polite" role="status"><div class="empty">尚無掃描結果</div></div>
    <div class="notice" id="notice" hidden></div>
  </section>
</main>

<script>
const MAX_BODY_BYTES = 512 * 1024;
const input = document.getElementById('input');
const output = document.getElementById('output');
const scanBtn = document.getElementById('scanBtn');
const cancelBtn = document.getElementById('cancelBtn');
const copyBtn = document.getElementById('copyBtn');
const scanStatus = document.getElementById('scanStatus');
const copyStatus = document.getElementById('copyStatus');
const decisionChip = document.getElementById('decisionChip');
const summary = document.getElementById('summary');
const findings = document.getElementById('findings');
const notice = document.getElementById('notice');
const report = document.getElementById('report');
let activeController = null;
let metricsTimer = null;

function replaceFindingsWithMessage(message) {
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = message;
  findings.replaceChildren(empty);
}

function createFindingElement(finding) {
  const button = document.createElement('button');
  button.className = 'finding';
  button.type = 'button';
  button.dataset.line = finding.line ? String(Number(finding.line)) : '';

  const top = document.createElement('span');
  top.className = 'finding-top';

  const severity = document.createElement('span');
  severity.className = 'severity ' + String(finding.severity);
  severity.textContent = String(finding.severity);

  const location = document.createElement('span');
  location.className = 'location';
  location.textContent = finding.line ? '第 ' + Number(finding.line) + ' 行' : '位置未提供';
  top.append(severity, location);

  const type = document.createElement('span');
  type.className = 'finding-type';
  type.textContent = String(finding.type);

  const description = document.createElement('span');
  description.className = 'finding-desc';
  description.textContent = String(finding.description);

  button.append(top, type, description);
  return button;
}

function updateMetrics() {
  const content = input.value;
  const lines = content ? content.split('\n').length : 0;
  document.getElementById('inputMetrics').textContent = content.length + ' 字元 · ' + lines + ' 行';
}

function scheduleMetrics() {
  clearTimeout(metricsTimer);
  metricsTimer = setTimeout(updateMetrics, 150);
}

function setStatus(element, message, type) {
  element.textContent = message;
  element.className = 'status' + (type ? ' ' + type : '');
}

function resetResult() {
  output.value = '';
  copyBtn.disabled = true;
  copyBtn.textContent = '脫敏並複製';
  decisionChip.textContent = 'NOT SCANNED';
  decisionChip.className = 'decision-chip';
  summary.textContent = '貼上內容後執行掃描';
  replaceFindingsWithMessage('尚無掃描結果');
  document.getElementById('outputMetrics').textContent = '等待掃描';
  notice.hidden = true;
  notice.textContent = '';
  setStatus(scanStatus, '', '');
  setStatus(copyStatus, '', '');
}

function lineBounds(text, line) {
  const target = Number(line);
  if (!target || target < 1) return [0, 0];
  let start = 0;
  for (let current = 1; current < target; current += 1) {
    const next = text.indexOf('\n', start);
    if (next === -1) return [text.length, text.length];
    start = next + 1;
  }
  const end = text.indexOf('\n', start);
  return [start, end === -1 ? text.length : end];
}

function focusFinding(line) {
  const [start, end] = lineBounds(input.value, line);
  input.focus();
  input.setSelectionRange(start, Math.max(start, end));
  input.scrollTop = input.scrollHeight * (start / Math.max(1, input.value.length));
}

function renderResult(data) {
  decisionChip.textContent = data.decision + ' · ' + data.riskLevel;
  decisionChip.className = 'decision-chip ' + data.decision;
  summary.textContent = data.summary;
  report.setAttribute('aria-busy', 'false');

  const isAllowed = data.decision === 'ALLOW';
  const safeContent = isAllowed ? input.value : (data.redactedContent || '');
  output.value = safeContent;
  document.getElementById('outputMetrics').textContent = safeContent.length + ' 字元';

  const truncated = data.wasTruncated === true;
  const redactionFailed = data.redactionVerified === false;
  copyBtn.disabled = !safeContent || redactionFailed || truncated;
  copyBtn.textContent = isAllowed ? '複製原始內容' : '脫敏並複製';

  if (!data.findings.length) {
    replaceFindingsWithMessage('未偵測到敏感內容');
  } else {
    findings.replaceChildren(...data.findings.map(createFindingElement));
  }

  const showNotice = redactionFailed || truncated;
  notice.hidden = !showNotice;
  notice.textContent = redactionFailed
    ? '脫敏驗證未通過，安全版本不可複製。請縮小內容或手動檢查殘留項目。'
    : truncated
      ? '內容超過掃描上限，僅檢查了部分內容。請縮小範圍後重新掃描。'
      : '';
}

async function scan() {
  const content = input.value;
  if (!content.trim()) {
    setStatus(scanStatus, '請先輸入內容', 'error');
    input.focus();
    return;
  }
  if (content.length > MAX_BODY_BYTES) {
    setStatus(scanStatus, '內容超過 512 KB 上限，請縮小後再掃描', 'error');
    return;
  }

  if (activeController) activeController.abort();
  activeController = new AbortController();
  scanBtn.disabled = true;
  cancelBtn.hidden = false;
  copyBtn.disabled = true;
  report.setAttribute('aria-busy', 'true');
  setStatus(scanStatus, '掃描中…', '');
  try {
    const response = await fetch('/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
      signal: activeController.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '掃描失敗');
    renderResult(data);
    setStatus(scanStatus, data.findings.length + ' 個項目', data.decision === 'ALLOW' && !data.wasTruncated ? 'success' : '');
    document.getElementById('reportTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      resetResult();
      setStatus(scanStatus, '已取消掃描', 'error');
    } else {
      resetResult();
      setStatus(scanStatus, error instanceof Error ? error.message : '掃描失敗', 'error');
    }
  } finally {
    activeController = null;
    scanBtn.disabled = false;
    cancelBtn.hidden = true;
    report.setAttribute('aria-busy', 'false');
  }
}

function cancelScan() {
  if (activeController) activeController.abort();
}

async function copyOutput() {
  if (!output.value) return;
  try {
    await navigator.clipboard.writeText(output.value);
    setStatus(copyStatus, '已複製安全版本', 'success');
    return;
  } catch {
    // fall through to legacy path
  }
  output.focus();
  output.select();
  try {
    if (document.execCommand('copy')) {
      setStatus(copyStatus, '已複製安全版本', 'success');
      return;
    }
  } catch {
    // execCommand unavailable
  }
  setStatus(copyStatus, '請按 ⌘/Ctrl + C 複製', 'error');
}

input.addEventListener('input', () => {
  scheduleMetrics();
  if (output.value) resetResult();
});
input.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') scan();
});
scanBtn.addEventListener('click', scan);
cancelBtn.addEventListener('click', cancelScan);
copyBtn.addEventListener('click', copyOutput);
document.getElementById('clearBtn').addEventListener('click', () => {
  input.value = '';
  updateMetrics();
  resetResult();
  input.focus();
});
document.getElementById('sampleBtn').addEventListener('click', () => {
  input.value = [
    'const apiKey = "sk-' + 'demo'.repeat(6) + '";',
    'const dbUrl = " Server=10.0.0.1;User=admin;Password=s3cr3t; ";',
    'const token = "ghp_' + 'x'.repeat(20) + '";',
    'const contact = { email: "user@example.com", phone: "0912345678" };',
    'const awsKey = "AKIA" + "1234567890";',
    'const message = "hello world";'
  ].join('\n');
  updateMetrics();
  resetResult();
  input.focus();
});
findings.addEventListener('click', event => {
  const target = event.target.closest('[data-line]');
  if (target && target.dataset.line) focusFinding(target.dataset.line);
});
updateMetrics();
</script>
</body>
</html>`;
