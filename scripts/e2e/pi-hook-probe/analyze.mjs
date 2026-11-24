import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";

const option = (name) => {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`Required: ${name} <directory>`);
  return resolve(value);
};
const output = option("--out");
const runtime = option("--runtime");
const artifact = (name) => join(output, name);
const evidence = JSON.parse(readFileSync(artifact("results.json"), "utf8"));
const rows = evidence.results;
let checks = 0;
const check = (value, label) => {
  assert.ok(value, label);
  checks++;
};
const get = (mode, api = "openai-completions", workflow = "normal") => {
  const result = rows.find(
    (r) => r.mode === mode && r.api === api && r.workflow === workflow,
  );
  assert.ok(result, `${mode}/${api}/${workflow}`);
  return result;
};
check(rows.length === 37, "37 scenarios ran");
for (const r of rows) check(!r.failure, `${r.id}: host execution completed`);
for (const api of [
  "openai-completions",
  "anthropic-messages",
  "openai-responses",
]) {
  check(
    get("baseline", api).requests.length === 1 &&
      get("baseline", api).requests[0].raw,
    `${api}: unguarded positive control`,
  );
  for (const mode of ["provider-mask", "wire"]) {
    const r = get(mode, api);
    check(
      r.requests.length === 1 && !r.requests[0].raw && r.requests[0].masked,
      `${api}/${mode}: masked request`,
    );
    check(
      r.outcomes[0].stopReason === "stop",
      `${api}/${mode}: completed reply`,
    );
  }
  for (const mode of ["provider-throw", "context-throw"]) {
    const r = get(mode, api);
    check(r.errors.length === 1, `${api}/${mode}: hook error observed`);
    check(
      r.requests.length === 1 && r.requests[0].raw,
      `${api}/${mode}: exception alone allowed raw request`,
    );
    check(
      r.outcomes[0].stopReason === "stop",
      `${api}/${mode}: host continued after hook error`,
    );
  }
  for (const mode of ["provider-abort", "context-abort"]) {
    const r = get(mode, api);
    check(
      r.requests.length === 0,
      `${api}/${mode}: explicit abort stopped network send`,
    );
    check(
      r.outcomes[0].stopReason === "aborted",
      `${api}/${mode}: host marked aborted`,
    );
  }
  for (const mode of ["wire-error", "wire-over-limit"]) {
    const r = get(mode, api);
    check(
      r.requests.length === 0,
      `${api}/${mode}: fetch boundary refused without upstream call`,
    );
    check(
      r.outcomes[0].stopReason === "error",
      `${api}/${mode}: local refusal surfaced as error`,
    );
  }
  const cli = readFileSync(artifact(`cli-${api}.log`), "utf8");
  check(
    cli.includes(`${api}: wire check passed`) && !cli.includes("FAIL"),
    `${api}: actual CLI adapter request masking and display restoration`,
  );
}
for (const mode of ["provider-mask", "context-mask", "wire"]) {
  const r = get(mode, "openai-completions", "full");
  check(r.requests.length === 6, `${mode}: full six-request sequence`);
  const ordinary = r.requests.filter((x) =>
    ["normal", "tool", "history"].includes(x.stage),
  );
  check(
    ordinary.length === 4 && ordinary.every((x) => !x.raw),
    `${mode}: system, prompt, history and tool results masked`,
  );
  check(
    ordinary.some((x) => x.toolResult) &&
      r.events.some((x) => x.type === "tool_execution_end"),
    `${mode}: real read tool ran`,
  );
  check(
    r.hooks.some((x) => x.name === "tool_result" && x.raw),
    `${mode}: read tool actually returned the original synthetic value before outbound masking`,
  );
  for (const stage of ["manual-compact", "tree-summary"]) {
    const requests = r.requests.filter((x) => x.stage === stage);
    check(
      requests.length === 1,
      `${mode}/${stage}: background provider request happened`,
    );
    check(
      requests[0].raw === (mode !== "wire"),
      `${mode}/${stage}: measured raw outcome`,
    );
    check(
      !r.hooks.some(
        (x) =>
          x.stage === stage &&
          [
            "context",
            "context_with_system",
            "before_provider_request",
          ].includes(x.name),
      ),
      `${mode}/${stage}: ordinary content hooks did not fire`,
    );
  }
  check(
    r.outcomes.some((x) => x.stage === "manual-compact" && x.completed),
    `${mode}: actual compaction completed`,
  );
  check(
    r.outcomes.some(
      (x) => x.stage === "tree-summary" && x.summaryCreated && !x.cancelled,
    ),
    `${mode}: actual tree summary completed via SDK`,
  );
  const auto = get(mode, "openai-completions", "auto");
  const automatic = auto.requests.filter(
    (x) => x.stage === "automatic-compact",
  );
  check(
    automatic.length === 1 && automatic[0].raw === (mode !== "wire"),
    `${mode}: automatic compaction measured`,
  );
  check(
    auto.events.some(
      (x) =>
        x.type === "compaction_end" && x.reason === "threshold" && !x.aborted,
    ),
    `${mode}: threshold compaction completed`,
  );
}
const cancelled = get("background-cancel", "openai-completions", "full");
check(
  cancelled.requests.length === 4 &&
    !cancelled.requests.some((x) =>
      ["manual-compact", "tree-summary"].includes(x.stage),
    ),
  "specialized cancellation stopped both background requests",
);
check(
  cancelled.outcomes.some(
    (x) => x.stage === "manual-compact" && /cancel/i.test(x.error ?? ""),
  ),
  "manual compaction cancellation observed",
);
check(
  cancelled.outcomes.some((x) => x.stage === "tree-summary" && x.cancelled),
  "tree cancellation observed",
);
const autoCancel = get("background-cancel", "openai-completions", "auto");
check(
  !autoCancel.requests.some((x) => x.stage === "automatic-compact") &&
    autoCancel.events.some((x) => x.type === "compaction_end" && x.aborted),
  "automatic compaction cancellation stopped summary request",
);
check(
  get("provider-mask-late").requests[0].raw,
  "late hook injection passed earlier payload masking",
);
check(
  !get("wire-late").requests[0].raw && get("wire-late").requests[0].masked,
  "fetch guard masked late hook injection",
);

const lock = JSON.parse(
  readFileSync(join(runtime, "package-lock.json"), "utf8"),
);
const digest = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const summary = {
  date: new Date().toISOString().slice(0, 10),
  piVersion: evidence.piVersion,
  nodeVersion: evidence.nodeVersion,
  scenarioCount: rows.length,
  assertionsPassed: checks,
  loopbackRequests: rows.reduce((n, r) => n + r.requests.length, 0),
  runtimePackageIntegrity:
    lock.packages["node_modules/@earendil-works/pi-coding-agent"].integrity,
  probeSha256: digest(new URL("./probe.mjs", import.meta.url)),
  resultsSha256: digest(artifact("results.json")),
  productionAdapterSourceCommit: evidence.sourceCommit,
  interpretation: {
    ordinaryHooks:
      "mask ordinary requests, history and tool results in tested cases",
    background:
      "generic context/payload hooks skipped by manual/automatic compaction and tree summaries",
    hookErrors: "throw/rejection alone fails open in these host callbacks",
    explicitAbort: "ctx.abort stops tested ordinary requests on all three APIs",
    specializedCancellation:
      "cancel result stops manual/automatic compaction and tree summaries",
    wire: "existing fetch guard masks normal and background requests, masks late additions, refuses forced errors/size limits",
  },
  limitations: [
    "loopback stubs, not real provider availability or incident frequency",
    "SDK AgentSession used for branch navigation; interactive TUI not exercised",
    "hook prototypes only substitute a synthetic canary; they do not implement production mapping/restoration",
    "abort race/retry variations, model switches, OAuth, non-fetch transports, Windows and multiple pi versions not covered",
    "forced wire-error injects a throwing Core to test the real fetch wrapper; over-limit uses the real Core",
  ],
};
writeFileSync(
  artifact("summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(JSON.stringify(summary, null, 2));
