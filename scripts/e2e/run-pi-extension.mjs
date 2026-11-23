#!/usr/bin/env node
/**
 * End-to-end check for the in-process pi adapter.
 *
 * Registers the built extension in a temporary pi agent directory and runs the
 * real pi 1.6.0 CLI against a recording loopback provider. The provider plays a
 * scripted tool sequence (read, write, edit, bash) and asserts that no original
 * value reaches it, while the local tools receive the restored values. The
 * encrypted mapping store is enabled, so the resumed run loads persisted
 * mappings from a second process.
 *
 * Usage: node scripts/e2e/run-pi-extension.mjs <path-to-pi-binary>
 * Requires `npm run build` first (the script imports the built placeholder
 * prefix) and Node.js 24.
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
  console.error("usage: node scripts/e2e/run-pi-extension.mjs <pi-binary>");
  process.exit(2);
}
const extensionPath = path.join(root, "dist/pi/extension.js");
if (!fs.existsSync(extensionPath)) {
  console.error(`missing ${extensionPath}; run npm run build first`);
  process.exit(2);
}

const ALPHA = "PI98_ALPHA_VALUE";
const BETA = "PI98_BETA_VALUE";
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "leakshield-pi-e2e-"));
const home = path.join(tmp, "home");
const work = path.join(tmp, "work");
const agentDir = path.join(home, ".pi", "agent");
const storePath = path.join(tmp, "mappings.db");
const keyfilePath = path.join(tmp, "mappings.key");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(work, { recursive: true });
fs.writeFileSync(path.join(work, ALPHA), `${ALPHA} file content\n`);
fs.writeFileSync(
  path.join(tmp, "guard.config.yaml"),
  `nda_keywords:\n  - ${ALPHA}\n  - ${BETA}\nprivate_domains: []\ncustom_rules: []\n`,
);
fs.writeFileSync(
  path.join(agentDir, "settings.json"),
  `${JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-model", extensions: [extensionPath] }, null, 2)}\n`,
);

const requests = [];
const known = [];
let step = 0;

function rememberTokens(text) {
  for (const match of text.match(TOKEN) ?? []) {
    if (!known.includes(match)) known.push(match);
  }
}

/** Replies an OpenAI-compatible SSE stream with the next scripted action. */
function reply(response, body) {
  rememberTokens(JSON.stringify(body));
  const alpha = known[0];
  const beta = known[1] ?? known[0];
  const tool = (name, args) => ({
    id: `call_${step}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  });
  const actions = [
    () => ({ tool_calls: [tool("read", { path: alpha })] }),
    () => ({ tool_calls: [tool("write", { path: "out.txt", content: alpha })] }),
    () => ({ tool_calls: [tool("edit", { path: "out.txt", edits: [{ oldText: alpha, newText: beta }] })] }),
    () => ({ tool_calls: [tool("bash", { command: `cat ${alpha}` })] }),
    () => ({ content: `finished with ${alpha}` }),
  ];
  const action = alpha === undefined ? { content: "nothing to do" } : actions[Math.min(step, actions.length - 1)]();
  step += 1;
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

function runPi(prompt, extra = []) {
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
        "--model",
        "stub/stub-model",
        ...extra,
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
          LEAKSHIELD_PI_PERSIST: "1",
          LEAKSHIELD_PI_PERSIST_PATH: storePath,
          LEAKSHIELD_PI_PERSIST_KEYFILE: "1",
          LEAKSHIELD_PI_PERSIST_KEYFILE_PATH: keyfilePath,
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function expectFile(label, filePath, expected) {
  const value = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  pass(label, value.includes(expected), `content=${JSON.stringify(value.slice(0, 120))}`);
}

try {
  const first = await runPi(
    `Read ${ALPHA}, and note ${BETA}. Then write, edit and cat the value.`,
  );
  pass("first run exits 0", first.code === 0, `exit ${first.code}\n${first.stderr.slice(-2000)}`);
  pass("scripted tool sequence ran", step >= 5, `steps=${step}`);
  pass(
    "provider never received an original value",
    requests.every((request) => !request.body.includes(ALPHA) && !request.body.includes(BETA)),
    requests.find((request) => request.body.includes(ALPHA) || request.body.includes(BETA))?.body.slice(0, 400),
  );
  pass(
    "every provider request carried placeholders",
    requests.length > 0 && requests.every((request) => (request.body.match(TOKEN) ?? []).length > 0),
    `requests=${requests.length}`,
  );
  pass(
    "tool results were masked before the next request",
    requests.length >= 5 && requests.slice(1).every((request) => !request.body.includes(ALPHA)),
  );
  expectFile("write and edit used the restored values", path.join(work, "out.txt"), BETA);
  const sessionDir = path.join(agentDir, "sessions");
  const sessionFiles = fs.existsSync(sessionDir)
    ? fs.readdirSync(sessionDir, { recursive: true }).filter((name) => String(name).endsWith(".jsonl"))
    : [];
  pass("pi persisted a session in the user's session directory", sessionFiles.length > 0);
  pass(
    "the encrypted mapping store was written",
    fs.existsSync(storePath) && fs.statSync(storePath).size > 0,
    `store=${storePath}`,
  );
  pass(
    "the mapping store holds no plaintext value",
    !fs.readFileSync(storePath).includes(ALPHA) && !fs.readFileSync(storePath).includes(BETA),
  );
  const sessionLines = sessionFiles.flatMap((name) =>
    fs
      .readFileSync(path.join(sessionDir, String(name)), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line)),
  );
  const assistantText = sessionLines
    .filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
    .map((entry) => JSON.stringify(entry.message))
    .join("\n");
  pass("saved tool-call arguments contain placeholders", assistantText.includes(PSEUDONYM_TOKEN_PREFIX_V2));

  const before = requests.length;
  const second = await runPi("Continue and finish.", ["--continue"]);
  pass("resumed run exits 0", second.code === 0, `exit ${second.code}\n${second.stderr.slice(-2000)}`);
  pass("resumed run sent a new masked request", requests.length > before && !requests.at(-1).body.includes(ALPHA));
  const resumedBody = requests.at(-1)?.body ?? "";
  pass("resumed session history stays masked", !resumedBody.includes(ALPHA) && !resumedBody.includes(BETA));
  pass("resumed session loaded prior history", resumedBody.includes(PSEUDONYM_TOKEN_PREFIX_V2));
} finally {
  await new Promise((resolve) => upstream.close(resolve));
  if (failures.length === 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    console.error(`\nartifacts kept at ${tmp}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall pi adapter checks passed");
