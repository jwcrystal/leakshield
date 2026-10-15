#!/usr/bin/env node
/** OPT-IN live smoke: uses the existing managed OpenCode host's commandcode
 * credentials through the public API. Never reads/copies/displays API keys.
 * Creates private test Locations with SG + a content-free egress observer.
 * Makes four small model calls (two protocol families x two wire settings).
 * No tools/project files/real secrets, no global config writes or restart.
 * E2E_LIVE=1 acknowledges live usage. Retains only boolean/count diagnostics.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.E2E_LIVE !== "1") throw new Error("Live test requires E2E_LIVE=1; it uses real account credits.");
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = process.env.OPENCODE_BIN || "opencode";
const preferred = path.join(os.tmpdir(), "opencode");
const ROOT = mkdtempSync(path.join(process.env.E2E_WORK_ROOT || (existsSync(preferred) ? preferred : os.tmpdir()), "sg-live-compatible-"));
const EMAIL = "alice.canary@example-test.invalid";
const models = [{ id: "gpt-6-luna", route: "chat" }, { id: "claude-haiku-4-5-20251001", route: "messages" }];
const rows = [];

function api(method, endpoint, data, cwd, timeout = 25000) {
  const args = ["api", method, endpoint];
  if (data !== undefined) args.push("--data", JSON.stringify(data));
  const start = Date.now();
  const result = spawnSync(BIN, args, { cwd, encoding: "utf8", timeout, maxBuffer: 10 * 1024 * 1024 });
  try {
    return { status: result.status, durationMs: Date.now() - start, value: JSON.parse(result.stdout) };
  } catch {
    // Do not persist CLI/server stderr: provider errors can embed transport
    // details. Only safe diagnostics enter the retained evidence.
    return { status: result.status, durationMs: Date.now() - start, parseFailed: true, timedOut: result.error?.code === "ETIMEDOUT" };
  }
}

console.log(`Live evidence: ${ROOT}`);
for (const wireProtection of [false, true]) {
  const directory = path.join(ROOT, wireProtection ? "wire" : "hook");
  const observer = path.join(directory, "egress-observer");
  mkdirSync(path.join(directory, ".opencode"), { recursive: true, mode: 0o700 });
  mkdirSync(observer, { mode: 0o700 });
  writeFileSync(path.join(directory, "AGENTS.md"), "Synthetic plugin verification only. Do not read files, run tools, or use real user data.\n");
  const configPath = path.join(directory, "guard.config.yaml");
  writeFileSync(configPath, "nda_keywords: []\nprivate_domains: []\ncustom_rules: []\nsettings:\n  env_files: []\n");
  const tracePath = path.join(directory, "egress-flags.jsonl");
  writeFileSync(path.join(observer, "package.json"), JSON.stringify({ name: "sg-synthetic-egress-observer", version: "0.0.0", type: "module", main: "index.js" }));
  writeFileSync(path.join(observer, "index.js"), `
import { appendFileSync } from "node:fs";
export default { id: "sg-synthetic-egress-observer", async setup(ctx) {
  const registered = await ctx.session.hook("http.request", async (event) => {
    const body = await event.request.clone().text();
    const pathname = new URL(event.request.url).pathname;
    const route = pathname.endsWith("/chat/completions") ? "chat" : pathname.endsWith("/messages") ? "messages" : pathname.endsWith("/responses") ? "responses" : "unknown";
    appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ sessionID: event.sessionID, kind: event.kind, route,
      syntheticOriginalPresent: body.includes(${JSON.stringify(EMAIL)}), placeholderPresent: /\\[SGP[12]:/.test(body), bytes: Buffer.byteLength(body) }) + "\\n", { mode: 0o600 });
  });
  return () => registered.dispose();
} };
`);
  writeFileSync(path.join(directory, ".opencode/opencode.json"), JSON.stringify({ plugins: [
    { package: path.join(REPO, "dist"), options: { mode: "transparent", configPath, wireProtection } },
    { package: observer },
  ] }, null, 2));
  const query = `?location[directory]=${encodeURIComponent(directory)}`;
  const listed = api("get", `/api/plugin${query}`, undefined, directory);
  const plugins = Array.isArray(listed.value?.data) ? listed.value.data : [];
  // The loader's plugin records vary across host versions. A successful model
  // request AND an SG placeholder in the scoped egress probe is the stronger
  // runtime proof; record registration presence without inventing loaded state.
  const sgRegistered = JSON.stringify(plugins).includes("sensitive-guard");
  for (const model of models) {
    const created = api("post", "/api/session", { title: `SG synthetic live ${model.route} ${wireProtection ? "wire" : "hook"}`,
      model: { providerID: "commandcode", id: model.id }, location: { directory } }, directory);
    const session = created.value?.data ?? created.value;
    const sessionID = session?.id;
    let generated;
    if (typeof sessionID === "string" && sessionID.startsWith("ses_")) {
      generated = api("post", `/api/session/${sessionID}/generate`, { prompt: `Reply with exactly this one line and nothing else: Contact ${EMAIL} LIVE_OK. Do not use tools.` }, directory, 90000);
    }
    const data = generated?.value?.data ?? generated?.value;
    const text = typeof data === "string" ? data : typeof data?.text === "string" ? data.text : "";
    const traces = existsSync(tracePath) ? readFileSync(tracePath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.sessionID === sessionID) : [];
    const passed = generated?.status === 0 && traces.length > 0 && traces.every(row => row.route === model.route && !row.syntheticOriginalPresent && row.placeholderPresent)
      && text.includes(EMAIL) && text.includes("LIVE_OK") && !/\[SGP[12]:/.test(text);
    rows.push({ model: model.id, expectedRoute: model.route, wireProtection, directory, sessionID,
      sgRegistered, passed, createExit: created.status, generateExit: generated?.status,
      timedOut: generated?.timedOut ?? false, generateDurationMs: generated?.durationMs,
      responseShape: typeof data === "object" && data !== null ? Object.keys(data).slice(0,10) : typeof data,
      responseTextLength: text.length, restoredSyntheticEmail: text.includes(EMAIL), markerPresent: text.includes("LIVE_OK"), placeholderInDisplay: /\[SGP[12]:/.test(text), traces });
    writeFileSync(path.join(ROOT, "summary.json"), JSON.stringify({ realAccountUsage: true, rows }, null, 2));
    console.log(`${model.route} wire=${wireProtection}: ${passed ? "PASS" : "FAIL"}; requests=${traces.length}; restored=${text.includes(EMAIL)}`);
    // Remove only the transient sessions created by this test. No user session
    // or Location data is deleted; the content-free evidence remains on disk.
    if (typeof sessionID === "string" && sessionID.startsWith("ses_")) api("delete", `/api/session/${sessionID}`, undefined, directory);
  }
}
console.log(`Summary: ${path.join(ROOT, "summary.json")}`);
if (rows.some(row => !row.passed)) process.exitCode = 1;
