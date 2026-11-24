#!/usr/bin/env node
/**
 * Real-pi wire-format check for the in-process pi adapter.
 *
 * Registers the built extension in a temporary pi agent directory and runs
 * real pi 1.6.0 against a recording loopback stub for one wire format:
 *
 *   node scripts/e2e/run-pi-wire.mjs <pi-binary> <api> [--package <installed-dir>]
 *
 * `api` is openai-completions, anthropic-messages or openai-responses.
 * Asserts the provider received only placeholders and that pi displayed the
 * restored value. Requires `npm run build`.
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
const api = process.argv[3];
const packageDir = process.argv[4] === "--package" && process.argv[5]
  ? path.resolve(process.argv[5]) : undefined;
if (piBinary === undefined || !["openai-completions", "anthropic-messages", "openai-responses"].includes(api)) {
  console.error("usage: node scripts/e2e/run-pi-wire.mjs <pi-binary> <openai-completions|anthropic-messages|openai-responses>");
  process.exit(2);
}
const extensionPath = path.join(packageDir ?? root, "dist/adapters/pi/extension.js");
if (!fs.existsSync(extensionPath)) {
  console.error(`missing ${extensionPath}; run npm run build first`);
  process.exit(2);
}

const CANARY = "PI_WIRE_CANARY";
const TOKEN = new RegExp(`${PSEUDONYM_TOKEN_PREFIX_V2.replace(/[[\]]/g, "\\$&")}[^\\]]+\\]`, "g");
const failures = [];
const pass = (label, condition, detail = "") => {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures.push(label);
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `leakshield-pi-wire-${api}-`));
const agentDir = path.join(tmp, "agent");
const work = path.join(tmp, "work");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(work, { recursive: true });
fs.writeFileSync(
  path.join(agentDir, "settings.json"),
  `${JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-model", ...(packageDir ? {} : { extensions: [extensionPath] }) }, null, 2)}\n`,
);
fs.writeFileSync(
  path.join(tmp, "guard.config.yaml"),
  `nda_keywords:\n  - ${CANARY}\nprivate_domains: []\ncustom_rules: []\n`,
);

const requests = [];
const stub = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ path: request.url, body });
    const echoed = (body.match(TOKEN) ?? [])[0] ?? "ok";
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (api === "anthropic-messages") {
      send(response, [
        ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "stub-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: echoed } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
        ["message_stop", { type: "message_stop" }],
      ]);
    } else if (api === "openai-responses") {
      const item = { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: echoed, annotations: [] }] };
      send(response, [
        ["response.created", { type: "response.created", response: { id: "resp_1", object: "response", created_at: 1, status: "in_progress", model: "stub-model", output: [] } }],
        ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", status: "in_progress", role: "assistant", content: [] } }],
        ["response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: echoed }],
        ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
        ["response.completed", { type: "response.completed", response: { id: "resp_1", object: "response", created_at: 1, status: "completed", model: "stub-model", output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } }],
      ]);
    } else {
      for (const [name, data] of [
        ["", { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "stub-model", choices: [{ index: 0, delta: { role: "assistant", content: echoed }, finish_reason: null }] }],
        ["", { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "stub-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }],
      ]) {
        response.write(`${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
      }
      response.write("data: [DONE]\n\n");
      response.end();
    }
  });
});

function send(response, events) {
  for (const [name, data] of events) response.write(`${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
  response.end();
}

await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const port = stub.address().port;
const basePath = api === "anthropic-messages" ? "" : "/v1";
fs.writeFileSync(
  path.join(agentDir, "models.json"),
  `${JSON.stringify(
    {
      providers: {
        stub: {
          baseUrl: `http://127.0.0.1:${port}${basePath}`,
          api,
          apiKey: "stub-upstream-key",
          models: [{ id: "stub-model", name: "Stub", contextWindow: 200000, maxTokens: 4096 }],
        },
      },
    },
    null,
    2,
  )}\n`,
);

try {
  const packageEnv = {
    ...process.env,
    HOME: tmp,
    PI_CODING_AGENT_DIR: agentDir,
    LEAKSHIELD_CONFIG: path.join(tmp, "guard.config.yaml"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PATH: `${path.dirname(path.resolve(piBinary))}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  if (packageDir) {
    const install = await runPackageCommand(piBinary, ["install", packageDir], packageEnv);
    pass(`${api}: pi install exits 0`, install.code === 0, install.stderr);
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    pass(`${api}: installed through settings.packages only`, settings.packages?.some(
      (entry) => typeof entry === "string" && path.resolve(agentDir, entry) === packageDir,
    ) && !settings.extensions?.length);
    const doctor = await runPackageCommand(process.execPath, [path.join(packageDir, "dist/cli.js"), "--doctor", "pi"], packageEnv);
    pass(`${api}: packaged doctor recognizes package with PARTIAL coverage`,
      doctor.code === 0 && doctor.stdout.includes("settings.packages") && doctor.stdout.includes("PARTIAL"), doctor.stdout + doctor.stderr);
  }
  const result = await new Promise((resolve) => {
    const child = spawn(
      piBinary,
      [
        "--offline",
        "--print",
        "--no-session",
        "--no-mcp",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-approve",
        "--model",
        "stub/stub-model",
        "-p",
        `Repeat the quoted text exactly: "${CANARY}"`,
      ],
      {
        cwd: work,
        env: {
          ...process.env,
          HOME: tmp,
          PI_CODING_AGENT_DIR: agentDir,
          LEAKSHIELD_CONFIG: path.join(tmp, "guard.config.yaml"),
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
  pass(`${api}: exit 0`, result.code === 0, `exit ${result.code}\n${result.stderr.slice(-1200)}`);
  pass(`${api}: one request`, requests.length === 1, `requests=${requests.length}`);
  pass(
    `${api}: provider never received the canary`,
    requests.every((request) => !request.body.includes(CANARY)),
    requests.find((request) => request.body.includes(CANARY))?.body.slice(0, 300),
  );
  pass(
    `${api}: request carried a placeholder`,
    requests.some((request) => (request.body.match(TOKEN) ?? []).length > 0),
  );
  pass(`${api}: reply was restored for display`, result.stdout.includes(CANARY), `stdout=${JSON.stringify(result.stdout.slice(0, 200))}`);
  if (packageDir) {
    const remove = await runPackageCommand(piBinary, ["remove", packageDir], packageEnv);
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    pass(`${api}: pi remove clears package registration`, remove.code === 0 && settings.packages?.length === 0);
  }
} finally {
  await new Promise((resolve) => stub.close(resolve));
  if (failures.length === 0) fs.rmSync(tmp, { recursive: true, force: true });
  else console.error(`\nartifacts kept at ${tmp}`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(`${api}: wire check passed`);

async function runPackageCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 30000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
