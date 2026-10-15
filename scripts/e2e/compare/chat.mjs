#!/usr/bin/env node
/** Chat Completions comparison: baseline / SG (hook, wire, persistence) / official
 * Rehydra / EightDoor against the same 11 scenarios on a real OpenCode host.
 * Loopback provider stand-in, synthetic canaries, no credentials. See README.md.
 *   node scripts/e2e/compare/chat.mjs [--suite=a,b] [--case=x,y] [--assert]
 * Third-party suites run only when E2E_REHYDRA_PACKAGE / E2E_EIGHTDOOR_PACKAGE are set. */
import http from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  CANARIES, EMAIL, SECRET, SG_DIST, TOKEN, defaultSuites, isolatedEnv, makeOutputRoot,
  pluginsFor, prepareCaseDirectory, preflight, selected,
} from "./common.mjs";

const scenarios = ["clean", "secret-chat", "reply-restore", "read-output", "read-restore", "write-restore", "shell-simple", "shell-quoted", "system-secret", "restart-chat", "restart-write"];
const suites = selected("suite", defaultSuites());
const chosenScenarios = selected("case", scenarios);
const { bin: BIN, version: HOST_VERSION } = preflight(suites);
const OUT = makeOutputRoot("sg-compare-chat");

function tokens(text) { return [...String(text).matchAll(TOKEN)].map(m => m[0]); }
function lastUserText(body) {
  const users = (body.messages ?? []).filter(m => m.role === 'user');
  const last = users.at(-1);
  return typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
}
function parseEvents(stdout) {
  return stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
function runCLI(args, cwd, env) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(BIN, ['run', '--standalone', '--format', 'json', '--model', 'capture/capture-1', '--auto', '--print-logs', ...args], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, 45000);
    child.on('error', err => { clearTimeout(timer); resolve({ code: null, timedOut, stdout, stderr: stderr + err.message, ms: Date.now() - started }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, timedOut, stdout, stderr, ms: Date.now() - started }); });
  });
}

async function runCase(suite, scenario) {
  const dir = path.join(OUT, `${suite}--${scenario}`);
  const guardConfig = prepareCaseDirectory(dir);
  writeFileSync(path.join(dir, "notes.txt"), `Read marker READ_OK\nContact ${EMAIL}\nKey ${SECRET}\n`);
  writeFileSync(path.join(dir, "fixtures", EMAIL), "RESTORE_READ_OK\n");
  if (scenario === "system-secret") writeFileSync(path.join(dir, "AGENTS.md"), `# Project instructions\nContact ${EMAIL}. Use key ${SECRET}.\n`);
  const captures = [];
  let callIssued = false, phase = 1, oldToken, error;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'capture-1', object: 'model' }] })); return;
    }
    let body;
    try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
    const main = Array.isArray(body.tools) && body.tools.length > 0;
    captures.push({ phase, main, path: req.url, body });
    const user = lastUserText(body);
    const token = tokens(user)[0];
    if (token && phase === 1) oldToken ??= token;
    const toolNames = new Set((body.tools ?? []).map(t => t.function?.name));
    const shell = toolNames.has('shell') ? 'shell' : toolNames.has('bash') ? 'bash' : null;
    let tool, input, content = main ? 'OK_DONE' : 'Synthetic test title';
    const reference = suite === 'baseline' ? EMAIL : token;
    if (main && scenario === 'reply-restore') content = `Contact ${reference ?? 'NO_TOKEN'} OK_DONE`;
    if (main && !callIssued) {
      if (scenario === 'read-output') { tool = 'read'; input = { path: 'notes.txt' }; }
      if (scenario === 'read-restore') { tool = 'read'; input = { path: `fixtures/${reference ?? 'NO_TOKEN'}` }; }
      if (scenario === 'write-restore') { tool = 'write'; input = { path: 'restored.txt', content: `Contact ${reference ?? 'NO_TOKEN'}\n` }; }
      if (scenario === 'shell-simple') { tool = shell; input = { command: `printf %s ${reference ?? 'NO_TOKEN'}` }; }
      if (scenario === 'shell-quoted-only') { tool = shell; input = { command: `printf %s '${reference ?? 'NO_TOKEN'}'` }; }
      if (scenario === 'shell-quoted') { tool = shell; input = { command: `printf '%s' '${reference ?? 'NO_TOKEN'}' > shell-result.txt` }; }
      if (scenario === 'restart-write' && phase === 2) { tool = 'write'; input = { path: 'restart-result.txt', content: `Contact ${suite === 'baseline' ? EMAIL : oldToken ?? 'NO_OLD_TOKEN'}\n` }; }
      if (tool) callIssued = true;
    }
    if (main && ['read-restore', 'write-restore', 'shell-simple', 'shell-quoted-only', 'shell-quoted'].includes(scenario) && !reference) error = 'No placeholder found in provider user message';
    const message = tool ? {
      role: 'assistant', content: null,
      tool_calls: [{ id: `call_synthetic_${phase}`, type: 'function', function: { name: tool, arguments: JSON.stringify(input) } }],
    } : { role: 'assistant', content };
    const finish = tool ? 'tool_calls' : 'stop';
    const id = `chatcmpl-synthetic-${captures.length}`;
    const base = { id, created: Math.floor(Date.now() / 1000), model: 'capture-1' };
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      send({ role: 'assistant' });
      if (tool) send({ tool_calls: message.tool_calls.map((t, index) => ({ ...t, index })) });
      else {
        // Deliberately split a placeholder across native SSE chunks.
        const cut = content.includes('PII') || content.includes('SGP') ? Math.floor(content.length / 2) : content.length;
        send({ content: content.slice(0, cut) });
        if (cut < content.length) send({ content: content.slice(cut) });
      }
      send({}, finish);
      if (body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 100, completion_tokens: 15, total_tokens: 115 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 15, total_tokens: 115 } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const plugins = pluginsFor(suite, { dir, guardConfig });
  const config = {
    $schema: 'https://opencode.ai/config.json', update: 'disable', snapshots: false,
    providers: { capture: { name: 'Local synthetic capture', env: ['CAPTURE_API_KEY'], package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'synthetic-local-key' }, models: { 'capture-1': { name: 'Capture 1' } } } },
    plugins,
  };
  writeFileSync(path.join(dir, 'config/opencode/opencode.json'), JSON.stringify(config, null, 2));
  const env = isolatedEnv(dir, BIN);
  const prompt = ['clean', 'read-output', 'system-secret'].includes(scenario)
    ? 'Explain Foundation and agenda. 中文正常對話。 Complete this test.'
    : ['read-restore', 'write-restore', 'shell-simple', 'shell-quoted-only', 'shell-quoted', 'reply-restore', 'restart-write'].includes(scenario)
      ? `Use this contact in the requested local operation: ${EMAIL}.`
      : `Contact ${EMAIL} and rotate ${SECRET}.`;
  const runs = [];
  try {
    runs.push(await runCLI([prompt], dir, env));
    if (scenario.startsWith('restart-') && runs[0].code === 0 && !runs[0].timedOut) {
      phase = 2; callIssued = false;
      runs.push(await runCLI(['--continue', 'Continue the earlier task using its prior context.'], dir, env));
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  for (let i = 0; i < runs.length; i++) {
    writeFileSync(path.join(dir, `run${i + 1}.stdout.jsonl`), runs[i].stdout);
    writeFileSync(path.join(dir, `run${i + 1}.stderr.log`), runs[i].stderr);
  }
  writeFileSync(path.join(dir, 'captures.json'), JSON.stringify(captures, null, 2));
  const events = runs.flatMap(r => parseEvents(r.stdout));
  const texts = events.filter(e => e.type === 'text').map(e => e.part?.text ?? e.text ?? '').join('\n');
  const tools = events.filter(e => e.type === 'tool_use').map(e => ({ tool: e.part?.tool, state: e.part?.state }));
  const toolErrors = tools.filter(t => t.state?.status === 'error');
  const requestedToolCase = ['read-output', 'read-restore', 'write-restore', 'shell-simple', 'shell-quoted-only', 'shell-quoted', 'restart-write'].includes(scenario);
  let correct = !requestedToolCase;
  if (scenario === 'read-output') correct = tools.some(t => t.tool === 'read' && t.state?.status === 'completed' && t.state?.output?.includes('READ_OK'));
  if (scenario === 'read-restore') correct = tools.some(t => t.tool === 'read' && t.state?.status === 'completed' && t.state?.output?.includes('RESTORE_READ_OK'));
  if (scenario === 'write-restore') correct = existsSync(path.join(dir, 'restored.txt')) && readFileSync(path.join(dir, 'restored.txt'), 'utf8').includes(EMAIL);
  if (scenario === 'shell-simple' || scenario === 'shell-quoted-only') correct = tools.some(t => ['shell', 'bash'].includes(t.tool) && t.state?.status === 'completed' && t.state?.output?.includes(EMAIL));
  if (scenario === 'shell-quoted') correct = existsSync(path.join(dir, 'shell-result.txt')) && readFileSync(path.join(dir, 'shell-result.txt'), 'utf8') === EMAIL;
  if (scenario === 'restart-write') correct = runs.length === 2 && existsSync(path.join(dir, 'restart-result.txt')) && readFileSync(path.join(dir, 'restart-result.txt'), 'utf8').includes(EMAIL);
  if (scenario === 'reply-restore') correct = texts.includes(EMAIL);
  const leakage = captures.flatMap((c, index) => CANARIES.filter(value => JSON.stringify(c.body).includes(value)).map(value => ({ request: index + 1, phase: c.phase, kind: c.main ? 'primary' : 'title', category: value === EMAIL ? 'email' : 'env-secret' })));
  const completed = runs.every(r => r.code === 0 && !r.timedOut && parseEvents(r.stdout).some(e => e.type === 'text' && (e.part?.text ?? e.text ?? '').includes('OK_DONE')))
    && (!scenario.startsWith('restart-') || runs.length === 2);
  const row = {
    suite, scenario, completed, correct, leakCount: leakage.length, leakage,
    exitCodes: runs.map(r => r.code), toolErrorCount: toolErrors.length,
    toolErrors: toolErrors.map(t => ({ tool: t.tool, error: t.state.error })),
    mainRequests: captures.filter(c => c.main).length, titleRequests: captures.filter(c => !c.main).length,
    hasPlaceholder: captures.some(c => tokens(lastUserText(c.body)).length > 0),
    runCount: runs.length, timedOut: runs.some(r => r.timedOut), elapsedMs: runs.reduce((n, r) => n + r.ms, 0),
    harnessError: error ?? null, dir,
  };
  writeFileSync(path.join(dir, 'result.json'), JSON.stringify(row, null, 2));
  console.log(`${suite.padEnd(10)} ${scenario.padEnd(15)} conversation=${completed ? 'OK' : 'FAIL'} operation=${correct ? 'OK' : 'FAIL'} leaks=${leakage.length} toolErrors=${toolErrors.length} exit=${row.exitCodes.join(',')}`);
  return row;
}

const rows = [];
console.log(`OpenCode ${HOST_VERSION}; suites=${suites.join(",")}; SG=${SG_DIST}; synthetic local provider only\nEvidence: ${OUT}`);
for (const suite of suites) {
  for (const scenario of chosenScenarios) {
    rows.push(await runCase(suite, scenario));
    writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(rows, null, 2));
  }
}
console.log(`Done: ${rows.length} cases. ${path.join(OUT, "summary.json")}`);
if (process.argv.includes('--assert') && rows.some(r => !r.completed || !r.correct || r.harnessError || (r.suite !== 'baseline' && r.leakCount > 0))) process.exitCode = 1;
