#!/usr/bin/env node
/**
 * Refusal check for background model operations on a fetch-bypassing model.
 *
 * Runs real pi 1.6.0 with the extension, builds a small conversation on a
 * fetch-guarded model, switches to a `bedrock-converse-stream` model, then
 * asks for manual compaction and another prompt. Both must be refused before
 * any request leaves pi: the guard cannot see Bedrock's transport.
 *
 * Usage: node scripts/e2e/run-pi-compaction-refusal.mjs <path-to-pi-binary>
 * Requires `npm run build`.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const piBinary = process.argv[2];
if (piBinary === undefined) {
  console.error("usage: node scripts/e2e/run-pi-compaction-refusal.mjs <pi-binary>");
  process.exit(2);
}
const guard = join(root, "dist/adapters/pi/extension.js");
const CANARY = "PI98_PRIVATE_VALUE";
const failures = [];
const pass = (label, condition, detail = "") => {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures.push(label);
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
};

const requests = [];
const stub = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  requests.push({ path: request.url, raw: body.includes(CANARY) });
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write("data: " + JSON.stringify({
    id: "s",
    object: "chat.completion.chunk",
    created: 1,
    model: "stub-model",
    choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  }) + "\n\n");
  response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${stub.address().port}`;
const dir = await mkdtemp(join(tmpdir(), "pi-compact-refusal-"));
await writeFile(join(dir, "models.json"), JSON.stringify({
  providers: {
    stub: {
      baseUrl: `${base}/v1`,
      api: "openai-completions",
      apiKey: "stub-key",
      models: [{ id: "stub-model", contextWindow: 4000, maxTokens: 256 }],
    },
    bedrockx: {
      baseUrl: base,
      api: "bedrock-converse-stream",
      apiKey: "stub-key",
      models: [{ id: "br-model" }],
    },
  },
}));
await writeFile(join(dir, "settings.json"), JSON.stringify({
  defaultProvider: "stub",
  defaultModel: "stub-model",
  extensions: [guard],
  compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
}));
await writeFile(join(dir, "guard.config.yaml"), `nda_keywords:\n  - ${CANARY}\nprivate_domains: []\ncustom_rules: []\n`);

const child = spawn(piBinary, [
  "--offline", "--mode", "rpc", "--no-session", "--no-mcp", "--no-tools",
  "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve",
  "--model", "stub/stub-model",
], {
  cwd: dir,
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    HOME: dir,
    PI_CODING_AGENT_DIR: dir,
    NO_PROXY: "127.0.0.1",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    LEAKSHIELD_CONFIG: join(dir, "guard.config.yaml"),
  },
});
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk));
const lines = createInterface({ input: child.stdout });
const waitFor = (predicate) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout")), 20000);
  lines.on("line", function handler(line) {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (predicate(event)) {
      clearTimeout(timer);
      lines.off("line", handler);
      resolve(event);
    }
  });
});
const request = (message) => {
  const id = randomUUID();
  const done = waitFor((event) => event.type === "response" && event.id === id);
  child.stdin.write(JSON.stringify({ ...message, id }) + "\n");
  return done;
};

try {
  for (let turn = 0; turn < 3; turn++) {
    const done = waitFor((event) => event.type === "agent_end");
    child.stdin.write(JSON.stringify({
      type: "prompt",
      id: randomUUID(),
      message: `hello ${CANARY} ` + " context".repeat(300),
    }) + "\n");
    await done;
  }
  const before = requests.length;
  const switched = await request({ type: "set_model", provider: "bedrockx", modelId: "br-model" });
  const compacted = await request({ type: "compact" });
  const afterCompact = requests.length;
  const prompted = await request({ type: "prompt", message: `second ${CANARY}` });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const afterPrompt = requests.length;

  pass("conversation used the fetch-guarded model", before >= 3, `requests=${before}`);
  pass(
    "provider never received the canary",
    requests.every((entry) => !entry.raw),
  );
  pass("model switch to the Bedrock API succeeded", switched.success === true && switched.data?.api === "bedrock-converse-stream", JSON.stringify(switched));
  pass(
    "manual compaction was refused",
    compacted.success === false && /cancel/i.test(compacted.error ?? ""),
    JSON.stringify(compacted),
  );
  pass("compaction sent no request", afterCompact === before, `before=${before} after=${afterCompact}`);
  pass(
    "a prompt after the switch did not reach the provider",
    afterPrompt === before,
    `before=${before} after=${afterPrompt}`,
  );
} finally {
  child.stdin.end();
  child.kill();
  await new Promise((resolve) => child.once("close", resolve));
  await new Promise((resolve) => stub.close(resolve));
  if (failures.length === 0) {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  } else {
    console.error(`\nartifacts kept at ${dir}\n${stderr.slice(-1000)}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\npi compaction refusal check passed");
