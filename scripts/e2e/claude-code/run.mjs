#!/usr/bin/env node
// End-to-end check: a real `claude -p` session through the LeakShield proxy
// (dist/cli.js --claude-code-proxy) to the recording stub upstream. Uses an
// isolated CLAUDE_CONFIG_DIR, a synthetic API key and a synthetic canary; no
// account or network access is needed.
//
// --scenario refuse starts the proxy with a custom rule that flags Claude
// Code's own identifiers (`anthropic-beta: claude-code-…`, the model name):
// transport and structural positions the masker must refuse rather than
// rename. It checks that nothing reaches the upstream and Claude Code shows the
// refusal within its own bounded handling of a 400.
//
// Run `npm run build` first.
// Usage: node scripts/e2e/claude-code/run.mjs [--scenario mask|refuse] [--keep <dir>]
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const keepIndex = process.argv.indexOf("--keep");
const dir = keepIndex !== -1 ? path.resolve(process.argv[keepIndex + 1]) : mkdtempSync(path.join(tmpdir(), "leakshield-cc-"));
mkdirSync(path.join(dir, "work"), { recursive: true });
mkdirSync(path.join(dir, "config"), { recursive: true });

const scenarioIndex = process.argv.indexOf("--scenario");
const scenario = scenarioIndex !== -1 ? process.argv[scenarioIndex + 1] : "mask";
if (scenario !== "mask" && scenario !== "refuse") throw new Error("--scenario must be mask or refuse");
const CANARY = "sk-proj-Q7vR2mX9pL4kT8wN3zB6yH1cF5dJ0sGa";
const STUB_PORT = 18788;
const PROXY_PORT = 18787;
const log = path.join(dir, "upstream.jsonl");
writeFileSync(log, "");
writeFileSync(path.join(dir, "work", "notes.txt"), `deploy key: ${CANARY}\n`);

function start(cmd, args, name) {
  const child = spawn(cmd, args, { cwd: path.join(dir, "work"), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  return { child, output: () => out, name };
}

async function waitFor(url) {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`timed out waiting for ${url}`);
}

const cli = path.join(root, "dist", "cli.js");
if (!existsSync(cli)) throw new Error("dist/cli.js missing: run `npm run build` first");
const stub = start(process.execPath, [path.join(here, "stub-upstream.mjs"), "--port", String(STUB_PORT), "--log", log], "stub");
const proxyArgs = [cli, "--claude-code-proxy", "--port", String(PROXY_PORT), "--upstream", `http://127.0.0.1:${STUB_PORT}`];
if (scenario === "refuse") {
  const configPath = path.join(dir, "refuse.config.yaml");
  writeFileSync(configPath, [
    "custom_rules:",
    '  - description: "Claude Code identifiers (forces a refusal)"',
    '    pattern: "claude-[a-z]+-[0-9][a-z0-9.-]*"',
    "    severity: HIGH",
    "",
  ].join("\n"));
  proxyArgs.push("--config", configPath);
}
const proxy = start(process.execPath, proxyArgs, "proxy");
let failed = false;
try {
  await waitFor(`http://127.0.0.1:${STUB_PORT}/`);
  await waitFor(`http://127.0.0.1:${PROXY_PORT}/__leakshield/health`);

  const claude = spawn("claude", [
    "-p", `My key is ${CANARY}. Check notes.txt and count its bytes.`,
    "--model", "sonnet",
    "--allowedTools", "Bash(cat:*)", "Bash(wc:*)",
    "--max-turns", "5",
  ], {
    cwd: path.join(dir, "work"),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: path.join(dir, "config"),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${PROXY_PORT}`,
      ANTHROPIC_API_KEY: "sk-ant-api03-synthetic-e2e-key",
    },
  });
  let stdout = "";
  let stderr = "";
  claude.stdout.on("data", (d) => (stdout += d));
  claude.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((resolve) => claude.on("close", resolve));

  const records = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const posts = records.filter((r) => r.method === "POST");
  const placeholder = /\[SGP2:[A-Z_]+-[a-z]{4}-[a-z]{4}-[a-z]{4}\]/;
  const blocked = (proxy.output().match(/\[leakshield\] blocked POST/g) ?? []).length;
  const results = scenario === "refuse" ? [
    ["claude exited non-zero", code !== 0],
    ["no Messages request reached the upstream", posts.length === 0],
    ["claude showed the LeakShield refusal", /LeakShield blocked/.test(stdout + stderr)],
    // Claude Code 2.1.321 itself makes six attempts on any 400 from a plain
    // upstream (retry-count header 0, varying tool sets); more would mean the
    // refusal is being retried as a transient error.
    ["refusals stay within Claude Code's own 400 handling (1-6 attempts)", blocked >= 1 && blocked <= 6],
  ] : [
    ["claude exited 0", code === 0],
    ["upstream received Messages requests", posts.length >= 3],
    ["no upstream request carries the canary", records.every((r) => !JSON.stringify(r).includes(CANARY))],
    ["every Messages request carries a placeholder", posts.every((r) => placeholder.test(JSON.stringify(r.body)))],
    ["thinking history reached the upstream", posts.some((r) => JSON.stringify(r.body).includes('"type":"thinking"'))],
    ["tool_result history reached the upstream", posts.some((r) => JSON.stringify(r.body).includes('"type":"tool_result"'))],
    ["claude printed the restored canary", stdout.includes(CANARY)],
    ["claude printed no placeholder", !placeholder.test(stdout)],
  ];
  writeFileSync(path.join(dir, "claude-stdout.txt"), stdout);
  console.log(`claude ${(await import("node:child_process")).execFileSync("claude", ["--version"]).toString().trim()}`);
  console.log(`scenario: ${scenario}; proxy refusals logged: ${blocked}`);
  console.log(`requests at upstream: ${records.map((r) => `${r.method} ${r.url}`).join(", ")}`);
  console.log(`claude stdout: ${stdout.trim()}`);
  if (stderr.trim()) console.log(`claude stderr: ${stderr.trim()}`);
  for (const [name, ok] of results) {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
    if (!ok) failed = true;
  }
  console.log(`artifacts: ${dir}`);
} finally {
  stub.child.kill();
  proxy.child.kill();
  if (failed) console.log(`proxy output:\n${proxy.output()}`);
}
process.exitCode = failed ? 1 : 0;
