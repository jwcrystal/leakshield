#!/usr/bin/env node
/**
 * End-to-end check for codemode on the pi adapter.
 *
 * Runs the real pi 1.6.0 CLI against a recording loopback provider. The
 * provider plays a scripted codemode call whose source carries a placeholder:
 * the source must reach the sandbox literal, the inner `read` must receive the
 * restored path, and the provider must never see the original value.
 *
 * The second run plays a script that hands the placeholder to `tool_search`,
 * a tool LeakShield does not know: the inner call must be refused instead of
 * reaching the tool.
 *
 * Usage: node scripts/e2e/run-pi-codemode.mjs <path-to-pi-binary>
 * Requires `npm run build` first and Node.js 24.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PSEUDONYM_TOKEN_PREFIX_V2 } from "../../dist/decision/pseudonymization.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const piBinary = process.argv[2];
if (piBinary === undefined) {
  console.error("usage: node scripts/e2e/run-pi-codemode.mjs <pi-binary>");
  process.exit(2);
}
const extensionPath = path.join(root, "dist/adapters/pi/extension.js");
if (!fs.existsSync(extensionPath)) {
  console.error(`missing ${extensionPath}; run npm run build first`);
  process.exit(2);
}
const ALPHA = "PI223_ALPHA_VALUE";
const TOKEN = new RegExp(`${PSEUDONYM_TOKEN_PREFIX_V2.replace(/[[\]]/g, "\\$&")}[^\\]]+\\]`, "g");
const failures = [];
const pass = (label, condition, detail = "") => {
  if (condition) {
    console.log(`ok   ${label}`);
  } else {
    failures.push(`${label}${detail ? `: ${detail}` : ""}`);
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "leakshield-pi-codemode-"));
const home = path.join(tmp, "home");
const work = path.join(tmp, "work");
const agentDir = path.join(home, ".pi", "agent");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(work, { recursive: true });
fs.writeFileSync(path.join(work, ALPHA), `${ALPHA} file content\n`);
fs.writeFileSync(
  path.join(tmp, "guard.config.yaml"),
  `nda_keywords:\n  - ${ALPHA}\nprivate_domains: []\ncustom_rules: []\n`,
);
fs.writeFileSync(
  path.join(tmp, "probe-extension.mjs"),
  `import fs from "node:fs";
export default function (pi) {
  pi.registerTool({
    name: "probe_remote",
    label: "Probe",
    description: "Test tool that must never execute.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_id, params) {
      fs.writeFileSync(process.env.LEAKSHIELD_PROBE_MARKER, String(params.text));
      return { content: [{ type: "text", text: "probe ran" }] };
    },
  });
}
`,
);
fs.writeFileSync(
  path.join(agentDir, "settings.json"),
  `${JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-model", extensions: [extensionPath, path.join(tmp, "probe-extension.mjs")] }, null, 2)}\n`,
);
const requests = [];
const known = [];
let step = 0;
let script = () => ({ content: "nothing to do" });
let requestsThisRun = 0;
function rememberTokens(text) {
  for (const match of text.match(TOKEN) ?? []) {
    if (!known.includes(match)) known.push(match);
  }
}
/** Replies an OpenAI-compatible SSE stream with the next scripted action. */
function reply(response, body) {
  rememberTokens(JSON.stringify(body));
  const alpha = known.at(-1);
  const tool = (name, args) => ({
    id: `call_${step}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  });
  const action = alpha === undefined || requestsThisRun > 0 ? { content: "nothing to do" } : script(tool, alpha);
  step += 1;
  requestsThisRun += 1;
  const chunk = (delta, finish) => ({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: 1,
    model: "stub-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const events = [
    chunk({ role: "assistant", ...action }, action.content ? null : "tool_calls"),
    ...(action.content ? [chunk({}, "stop")] : []),
    "[DONE]",
  ];
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const event of events) response.write(`data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`);
  response.end();
}
const upstream = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ path: request.url, headers: request.headers, body });
    reply(response, JSON.parse(body || "{}"));
  });
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = upstream.address().port;
fs.writeFileSync(
  path.join(agentDir, "models.json"),
  `${JSON.stringify(
    {
      providers: {
        stub: {
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          api: "openai-completions",
          apiKey: "stub-upstream-key",
          models: [{ id: "stub-model", name: "Stub", contextWindow: 200000, maxTokens: 4096 }],
        },
      },
    },
    null,
    2,
  )}\n`,
);
function runPi(prompt) {
  return new Promise((resolve) => {
    const child = spawn(
      piBinary,
      [
        "--offline",
        "--print",
        "--no-mcp",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-approve",
        "--tools",
        "+codemode,+tool_search",
        "--model",
        "stub/stub-model",
        "-p",
        prompt,
      ],
      {
        cwd: work,
        env: {
          ...process.env,
          HOME: home,
          PI_CODING_AGENT_DIR: agentDir,
          LEAKSHIELD_CONFIG: path.join(tmp, "guard.config.yaml"),
          LEAKSHIELD_PROBE_MARKER: path.join(tmp, "probe-ran.txt"),
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const killer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}
function sessionLines() {
  const sessionDir = path.join(agentDir, "sessions");
  const files = fs.existsSync(sessionDir)
    ? fs.readdirSync(sessionDir, { recursive: true }).filter((name) => String(name).endsWith(".jsonl"))
    : [];
  return files.flatMap((name) =>
    fs
      .readFileSync(path.join(sessionDir, String(name)), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line)),
  );
}
try {
  // Run 1: the script reads a file through an inner call.
  step = 0;
  requestsThisRun = 0;
  script = (tool, alpha) => ({
    tool_calls: [tool("codemode", { code: `const r = await tools.read({ path: ${JSON.stringify(alpha)} });\nreturn r;` })],
  });
  const before = requests.length;
  const read = await runPi(`Read ${ALPHA} inside a codemode script.`);
  const readRequests = requests.slice(before);
  pass("read run exits 0", read.code === 0, `exit ${read.code}\n${read.stderr.slice(-2000)}`);
  pass("read run issued the codemode call", step >= 2, `steps=${step}`);
  pass(
    "provider never received the original value",
    readRequests.every((request) => !request.body.includes(ALPHA)),
    readRequests.find((request) => request.body.includes(ALPHA))?.body.slice(0, 400),
  );
  pass(
    "the inner read received the restored path",
    readRequests.at(-1)?.body.includes("file content") === true,
    readRequests.at(-1)?.body.slice(0, 400),
  );
  const codemodeCall = sessionLines()
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []))
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
    .find((part) => part?.type === "toolCall" && part?.name === "codemode");
  const codemodeSource = JSON.stringify(codemodeCall?.arguments ?? {});
  pass(
    "the saved codemode source kept the placeholder",
    codemodeSource.includes(PSEUDONYM_TOKEN_PREFIX_V2),
    codemodeSource.slice(0, 200),
  );

  // Run 2: the script hands the placeholder to a tool LeakShield does not know.
  step = 0;
  requestsThisRun = 0;
  script = (tool, alpha) => ({
    tool_calls: [
      tool("codemode", {
        code: `try {\n  return await tools.probe_remote({ text: ${JSON.stringify(alpha)} });\n} catch (error) {\n  return "blocked: " + error.message;\n}`,
      }),
    ],
  });
  const unknownBefore = requests.length;
  const unknown = await runPi(`Search tools for ${ALPHA} inside a codemode script.`);
  const unknownRequests = requests.slice(unknownBefore);
  pass(
    "the unknown inner tool never received the original value",
    unknownRequests.every((request) => !request.body.includes(ALPHA)),
    unknownRequests.find((request) => request.body.includes(ALPHA))?.body.slice(0, 400),
  );
  const unknownSession = sessionLines()
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []))
    .map((message) => JSON.stringify(message))
    .join("\n");
  pass(
    "the unknown inner tool never ran",
    !fs.existsSync(path.join(tmp, "probe-ran.txt")),
  );
  pass(
    "the refusal reached the transcript",
    /not a known pi built-in/.test(unknownSession),
    `requests=${unknownRequests.length} exit ${unknown.code}\n${unknown.stderr.slice(-1500)}`,
  );
} finally {
  await new Promise((resolve) => upstream.close(resolve));
  if (failures.length === 0 && process.env.LEAKSHIELD_E2E_KEEP !== "1") {
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    console.error(`\nartifacts kept at ${tmp}`);
  }
}
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall codemode checks passed");
