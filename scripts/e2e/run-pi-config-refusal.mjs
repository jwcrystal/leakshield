#!/usr/bin/env node
/**
 * Fail-closed check for a broken extension configuration.
 *
 * An invalid `LEAKSHIELD_PI_PERSIST*` value makes the extension factory throw.
 * pi must refuse to start (exit 1) before sending anything, rather than start
 * without the guard. Runs real pi 1.6.0 against a recording stub.
 *
 * Usage: node scripts/e2e/run-pi-config-refusal.mjs <path-to-pi-binary>
 * Requires `npm run build`.
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const piBinary = process.argv[2];
if (piBinary === undefined) {
  console.error("usage: node scripts/e2e/run-pi-config-refusal.mjs <pi-binary>");
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
const dir = await mkdtemp(join(tmpdir(), "pi-config-refusal-"));
await writeFile(join(dir, "models.json"), JSON.stringify({
  providers: {
    stub: { baseUrl: `${base}/v1`, api: "openai-completions", apiKey: "stub-key", models: [{ id: "stub-model" }] },
  },
}));
await writeFile(join(dir, "settings.json"), JSON.stringify({
  defaultProvider: "stub",
  defaultModel: "stub-model",
  extensions: [guard],
}));
await writeFile(join(dir, "guard.config.yaml"), `nda_keywords:\n  - ${CANARY}\nprivate_domains: []\ncustom_rules: []\n`);

try {
  const result = await new Promise((resolve) => {
    const child = spawn(piBinary, [
      "--offline", "--print", "--no-session", "--no-mcp", "--no-skills",
      "--no-prompt-templates", "--no-context-files", "--no-approve",
      "--model", "stub/stub-model", "-p", `hello ${CANARY}`,
    ], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: dir,
        PI_CODING_AGENT_DIR: dir,
        NO_PROXY: "127.0.0.1",
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        LEAKSHIELD_CONFIG: join(dir, "guard.config.yaml"),
        LEAKSHIELD_PI_PERSIST: "enabled",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });

  pass("pi refuses to start", result.code !== 0, `exit=${result.code}`);
  pass("no request reached the provider", requests.length === 0, `requests=${requests.length}`);
  pass(
    "the failure names the extension",
    /Failed to load extension/i.test(result.stderr),
    result.stderr.slice(0, 300),
  );
} finally {
  await new Promise((resolve) => stub.close(resolve));
  if (failures.length === 0) {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  } else {
    console.error(`\nartifacts kept at ${dir}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\npi config refusal check passed");
