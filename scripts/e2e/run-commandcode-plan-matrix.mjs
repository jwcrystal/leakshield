#!/usr/bin/env node
/** Synthetic routing matrix, not a subscription/entitlement test. Requires an
 * isolated installed opencode-cmd-provider package directory, selected through
 * E2E_PROVIDER_PACKAGE. Uses the unmodified published SDK and real OpenCode
 * against a loopback fake provider. Never fetches real credentials or models.
 * Run each plan/model sequentially; retain per-run evidence and aggregate JSON.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGE = process.env.E2E_PROVIDER_PACKAGE?.replace(/^aisdk:/, "");
if (!PACKAGE || !path.isAbsolute(PACKAGE)) throw new Error("Set E2E_PROVIDER_PACKAGE to an isolated absolute commandcode package directory.");
const packageJson = JSON.parse(readFileSync(path.join(PACKAGE, "package.json"), "utf8"));
if (packageJson.name !== "opencode-cmd-provider") throw new Error("This matrix requires the actual opencode-cmd-provider package.");
const { normalizePlan } = await import(pathToFileURL(path.join(PACKAGE, "dist/src/catalog/plans.js")).href);
const { createCommandCode } = await import(pathToFileURL(path.join(PACKAGE, "dist/src/provider/index.js")).href);
const plans = ["go", "goat", "pro", "prolegacy", "max", "max20", "teampro", "provider"];
const models = [{ id: "gpt-6.1", route: "chat" }, { id: "claude-sonnet-4-5", route: "messages" }];
const preferred = path.join(os.tmpdir(), "opencode");
const ROOT = mkdtempSync(path.join(process.env.E2E_WORK_ROOT || (existsSync(preferred) ? preferred : os.tmpdir()), "sg-plans-"));
const summary = { sdk: `${packageJson.name}@${packageJson.version}`, syntheticOnly: true, routingProbes: [], cases: [] };
console.log(`Evidence: ${ROOT}`);

// Inspect actual SDK wire construction without SG or any networking. A local
// 401 is deliberate: it ends the probe; it is not a successful conversation.
for (const plan of plans) {
  if (normalizePlan(plan) !== plan) throw new Error(`SDK did not recognize the pin ${plan}.`);
  for (const model of models) {
    const calls = [];
    const sdk = createCommandCode({ apiKey: "synthetic-local-key", baseURL: "https://capture.invalid", plan, maxRetries: 0,
      fetch: async (input, init) => {
        const body = JSON.parse(init.body);
        calls.push({ pathname: new URL(String(input)).pathname, bodyKeys: Object.keys(body).sort(),
          messageShape: body.messages?.[0] ? Object.keys(body.messages[0]).sort() : undefined,
          legacyMessageShape: body.conversation?.[0] ? Object.keys(body.conversation[0]).sort() : undefined });
        return new Response(JSON.stringify({ error: { type: "authentication_error", message: "Synthetic probe completed." } }), { status: 401, headers: { "content-type": "application/json" } });
      } });
    const { stream } = await sdk.languageModel(model.id).doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "synthetic routing probe" }] }], tools: [], providerOptions: {}, abortSignal: AbortSignal.timeout(5000) });
    const reader = stream.getReader();
    while (!(await reader.read()).done) { /* Drain the expected error event. */ }
    const expected = plan === "go" ? "/alpha/generate" : model.route === "chat" ? "/provider/v1/chat/completions" : "/provider/v1/messages";
    summary.routingProbes.push({ planPin: plan, model: model.id, expected, calls, passed: calls.length === 1 && calls[0].pathname === expected });
  }
}
writeFileSync(path.join(ROOT, "routing-probes.json"), JSON.stringify(summary.routingProbes, null, 2));

function runCase(plan, model, forceUpgrade = false) {
  const label = `${plan}-${model.route}${forceUpgrade ? "-403-fallback" : ""}`;
  const dir = path.join(ROOT, label);
  mkdirSync(dir, { mode: 0o700 });
  const result = spawnSync(process.execPath, [path.join(REPO, "scripts/e2e/run-responses-ws.mjs")], {
    cwd: REPO, encoding: "utf8", maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env, E2E_PROVIDER_PACKAGE: PACKAGE, E2E_MODEL_ID: model.id, E2E_PLAN: plan,
      E2E_BASE_PATH: "", E2E_LEGACY: plan === "go" ? "1" : "0", E2E_FORCE_UPGRADE: forceUpgrade ? "1" : "0" },
  });
  writeFileSync(path.join(dir, "runner.stdout.log"), result.stdout || "");
  writeFileSync(path.join(dir, "runner.stderr.log"), result.stderr || "");
  const summaryPath = result.stdout?.match(/^Summary: (.+)$/m)?.[1];
  const rows = summaryPath && existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf8")) : [];
  for (const row of rows) {
    // Title/auxiliary calls can select a different model family. Prove the
    // primary model's route separately; still leak-check every captured call.
    const compatibility = row.wireProtection === false;
    const expectedRoute = plan === "go" ? (compatibility ? ["legacy"] : [])
      : forceUpgrade && compatibility ? [model.route, "legacy"] : [model.route];
    const routeMatched = JSON.stringify(row.primaryRoutes) === JSON.stringify(expectedRoute);
    summary.cases.push({ ...row, matrixLabel: label, expectedRoutes: expectedRoute, routeMatched, passed: row.passed && routeMatched });
  }
  if (rows.length !== 2) summary.cases.push({ matrixLabel: label, passed: false, reason: "Missing two wire-mode results", exit: result.status });
  writeFileSync(path.join(ROOT, "summary.json"), JSON.stringify(summary, null, 2));
  const matrixRows = summary.cases.filter(row => row.matrixLabel === label);
  console.log(`${label}: ${result.status === 0 && rows.length === 2 && matrixRows.every(row => row.passed) ? "PASS" : "FAIL"}; ${plan === "go" || forceUpgrade ? "hook-only false / refused true" : "conversation/tools"}`);
}

for (const plan of plans) for (const model of models) runCase(plan, model);
// An apparently standard-compatible provider can change its route after a
// plan-gate error. Verify that exception separately, not just pinned happy paths.
for (const model of models) runCase("goat", model, true);
console.log(`Summary: ${path.join(ROOT, "summary.json")}`);
if (summary.routingProbes.some(row => !row.passed) || summary.cases.some(row => !row.passed)) process.exitCode = 1;
