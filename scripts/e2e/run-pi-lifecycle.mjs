#!/usr/bin/env node
/**
 * Lifecycle check for the shipped pi extension on real pi 1.6.0.
 *
 * Loads `dist/adapters/pi/extension.js` through pi's own resource loader and
 * drives three background/lifecycle paths against a recording loopback stub,
 * with pi defaults for compaction, branch summaries and retries:
 *
 *   - automatic threshold compaction
 *   - branch summary from `session.navigateTree(..., { summarize: true })`
 *   - automatic retry after a retryable provider error
 *
 * Every request body is written under `<out>/requests/`. The summary reports
 * canary/placeholder counts only.
 *
 * Usage: node scripts/e2e/run-pi-lifecycle.mjs --runtime <npm-prefix> --out <dir>
 * Requires `npm run build` and pi 1.6.0 installed under `<runtime>`.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";

const option = (name) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
};
const usage = () =>
  "usage: node scripts/e2e/run-pi-lifecycle.mjs --runtime <dir> --out <evidence-dir>";
const runtime = option("--runtime");
const out = option("--out");
if (!runtime || !out) {
  console.error(usage());
  process.exit(2);
}

const runtimeDir = resolve(runtime);
const packageDir = join(
  runtimeDir,
  "node_modules/@earendil-works/pi-coding-agent",
);
const packageInfo = JSON.parse(
  readFileSync(join(packageDir, "package.json"), "utf8"),
);
if (packageInfo.version !== "1.6.0") {
  console.error(
    `This check is pinned to pi 1.6.0, received ${packageInfo.version}`,
  );
  process.exit(2);
}
const REPO = resolve(import.meta.dirname, "../..");
const extensionPath = join(REPO, "dist/adapters/pi/extension.js");
if (!existsSync(extensionPath)) {
  console.error(`missing ${extensionPath}; run npm run build first`);
  process.exit(2);
}
const isInside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const realpathAllowingMissing = (target) => {
  const missing = [];
  let current = resolve(target);
  while (!existsSync(current)) {
    missing.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return join(realpathSync(current), ...missing);
};
const REAL_TMP = realpathSync(tmpdir());
const REAL_HOME = realpathSync(homedir());
const REAL_OUT = realpathAllowingMissing(out);
if (
  REAL_OUT === REAL_TMP ||
  !isInside(REAL_TMP, REAL_OUT) ||
  isInside(realpathSync(REPO), REAL_OUT) ||
  isInside(REAL_HOME, REAL_OUT) ||
  isInside(REAL_OUT, REAL_HOME)
) {
  console.error(
    `--out must be a directory under os.tmpdir() (${REAL_TMP}), outside the repository and the real home; got ${REAL_OUT}`,
  );
  process.exit(2);
}
mkdirSync(REAL_OUT, { recursive: true });
// Writes go into a fresh directory this run created, so a symlink left under
// --out by an earlier run cannot redirect them.
const ROOT = mkdtempSync(join(REAL_OUT, "run-"));
console.log(`run directory: ${ROOT}`);
const requestsDir = join(ROOT, "requests");
mkdirSync(requestsDir, { recursive: true });
mkdirSync(join(ROOT, "cases"), { recursive: true });
const revision = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: REPO,
  encoding: "utf8",
});
const sourceCommit =
  revision.status === 0 ? revision.stdout.trim() : "not-recorded";

const CANARY = "PILIFE_PRIVATE_VALUE";
const CONFIG = join(ROOT, "guard.config.yaml");
writeFileSync(
  CONFIG,
  `nda_keywords:\n  - ${CANARY}\nprivate_domains: []\ncustom_rules: []\n`,
);
process.env.LEAKSHIELD_CONFIG = CONFIG;
// An inherited LEAKSHIELD_PI_PERSIST would point the shipped extension at the
// user's real mapping store and OS keychain.
for (const key of Object.keys(process.env))
  if (key.startsWith("LEAKSHIELD_PI_PERSIST")) delete process.env[key];
process.env.PI_OFFLINE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PI_CODING_AGENT_DIR = join(ROOT, "empty-global");

const pi = await import(pathToFileURL(join(packageDir, "dist/index.js")).href);
const { SETTINGS_DEFAULTS } = await import(
  pathToFileURL(join(packageDir, "dist/core/settings-defaults.js")).href
);
const { PSEUDONYM_TOKEN_PREFIX_V2 } = await import(
  pathToFileURL(join(REPO, "dist/decision/pseudonymization.js")).href
);

const escapedPrefix = PSEUDONYM_TOKEN_PREFIX_V2.replace(
  /[.*+?^${}()|[\]\\]/g,
  "\\$&",
);
const PLACEHOLDER = new RegExp(
  `${escapedPrefix}[A-Z_]+-[a-z]{4}-[a-z]{4}-[a-z]{4}\\]`,
  "g",
);
const BRANCH_MARK = "Create a structured summary of this conversation branch";
const COMPACT_MARK = "You are a context summarization assistant";
const redact = (value) => String(value ?? "").split(CANARY).join("<canary>");
const countCanary = (text) => text.split(CANARY).length - 1;
const countPlaceholders = (text) => (text.match(PLACEHOLDER) ?? []).length;
const eventNames = (events) => [...new Set(events.map((event) => event.type))];

function classify(body) {
  if (body.includes(BRANCH_MARK)) return "branch-summary";
  if (
    body.includes(COMPACT_MARK) ||
    body.includes("The messages above are a conversation to summarize")
  )
    return "summarizer";
  return "model";
}

let requestSeq = 0;
function stream(response, promptTokens, text) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  const send = (data) => response.write(`data: ${JSON.stringify(data)}\n\n`);
  const base = {
    id: "chatcmpl_pilifecycle",
    object: "chat.completion.chunk",
    created: 1,
    model: "stub-model",
  };
  send({
    ...base,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: text },
        finish_reason: null,
      },
    ],
  });
  send({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  send({
    ...base,
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: 5,
      total_tokens: promptTokens + 5,
    },
  });
  response.end("data: [DONE]\n\n");
}

function createStub(caseName, behaviour) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const kind = classify(body);
    const record = {
      case: caseName,
      index: ++requestSeq,
      path: request.url,
      kind,
      canaryCount: countCanary(body),
      placeholderCount: countPlaceholders(body),
    };
    writeFileSync(
      join(
        requestsDir,
        `${String(record.index).padStart(3, "0")}-${caseName}.json`,
      ),
      body,
    );
    requests.push(record);
    const action = behaviour({ body, kind, record });
    if (action.status !== 200) {
      response.writeHead(action.status, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(action.body));
      return;
    }
    stream(response, action.usage, action.text);
  });
  return { server, requests };
}

const note = (turn) =>
  `Turn ${turn} synthetic NDA note: ${CANARY}. Related values ${CANARY} and ${CANARY}.\n` +
  "Synthetic filler about an unreleased private program. ".repeat(700);

function printCheck(check) {
  if (check.ok) {
    console.log(`ok   ${check.label}`);
    return;
  }
  console.log(
    `FAIL ${check.label}${check.detail ? `: ${redact(check.detail)}` : ""}`,
  );
}

async function runCase(caseName, drive) {
  const dir = join(ROOT, "cases", caseName);
  mkdirSync(dir, { recursive: true });
  const events = [];
  const caseErrors = [];
  let compactionSeen = false;
  let modelHits = 0;
  let firstModelRequest = true;
  let firstCompactionEndSeq;

  const { server, requests } = createStub(caseName, ({ kind }) => {
    if (caseName === "retry" && kind === "model" && firstModelRequest) {
      firstModelRequest = false;
      return {
        status: 503,
        body: { error: { message: "overloaded", type: "server_error" } },
      };
    }
    let usage = 1200;
    if (caseName === "compaction" && kind === "model") {
      modelHits++;
      if (!compactionSeen && modelHits >= 4) usage = 190000;
    }
    return {
      status: 200,
      usage,
      text: kind === "model" ? "synthetic ok" : "## Goal\nSynthetic summary ok.",
    };
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        stub: {
          baseUrl: `${base}/v1`,
          api: "openai-completions",
          apiKey: "synthetic-loopback-key",
          models: [
            {
              id: "stub-model",
              name: "Stub",
              contextWindow: 200000,
              maxTokens: 256,
            },
          ],
        },
      },
    }),
  );
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify(
      { defaultProvider: "stub", defaultModel: "stub-model" },
      null,
      2,
    ),
  );

  const checks = [];
  const check = (label, ok, detail = "") => {
    const entry = { label, ok: !!ok, detail: redact(detail) };
    checks.push(entry);
    printCheck(entry);
    return entry.ok;
  };

  let session;
  let failure;
  try {
    const loader = new pi.DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [extensionPath],
    });
    await loader.reload();
    if (loader.extensionsResult.errors.length)
      throw new Error(
        "Extension load error: " +
          JSON.stringify(loader.extensionsResult.errors),
      );
    const created = await pi.createAgentSession({
      cwd: dir,
      agentDir: dir,
      resourceLoader: loader,
      thinkingLevel: "off",
      tools: [],
      sessionManager: pi.SessionManager.inMemory(dir),
    });
    if (created.extensionsResult.errors.length)
      throw new Error(
        "Extension load error: " +
          JSON.stringify(created.extensionsResult.errors),
      );
    session = created.session;
    session.subscribe((event) => {
      const record = { type: event.type };
      if (event.type === "compaction_start" || event.type === "compaction_end")
        record.reason = event.reason;
      if (event.type === "compaction_end") {
        record.aborted = event.aborted;
        record.hasResult = !!event.result;
        record.summaryLength = event.result?.summary?.length ?? 0;
        record.tokensBefore = event.result?.tokensBefore;
        record.estimatedTokensAfter = event.result?.estimatedTokensAfter;
        record.errorMessage = event.errorMessage
          ? redact(event.errorMessage)
          : undefined;
        if (event.result && firstCompactionEndSeq === undefined)
          firstCompactionEndSeq = requestSeq;
      }
      if (event.type === "auto_retry_start") {
        record.attempt = event.attempt;
        record.maxAttempts = event.maxAttempts;
        record.delayMs = event.delayMs;
      }
      if (event.type === "auto_retry_end") {
        record.success = event.success;
        record.attempt = event.attempt;
        record.finalError = event.finalError
          ? redact(event.finalError)
          : undefined;
      }
      if (event.type === "session_tree")
        record.hasSummaryEntry = !!event.summaryEntry;
      events.push(record);
      if (event.type === "compaction_start" && event.reason === "threshold")
        compactionSeen = true;
    });
    await session.bindExtensions({
      mode: "rpc",
      onError: (error) =>
        caseErrors.push({
          event: error.event,
          error: redact(error.error),
        }),
    });

    const prompt = async (message) => {
      await session.prompt(message);
      const last = session.messages.at(-1);
      return {
        role: last?.role,
        stopReason: last?.stopReason,
        errorMessage: last?.errorMessage
          ? redact(last.errorMessage)
          : undefined,
      };
    };

    const result = await drive({
      session,
      prompt,
      requests,
      events,
      check,
      dir,
    });

    const starts = events.filter((event) => event.type === "compaction_start");
    const ends = events.filter((event) => event.type === "compaction_end");
    const summarizers = requests.filter(
      (request) => request.kind === "summarizer",
    );
    const branchRequests = requests.filter(
      (request) => request.kind === "branch-summary",
    );
    const modelRequests = requests.filter(
      (request) => request.kind === "model",
    );
    const afterCompaction =
      firstCompactionEndSeq === undefined
        ? []
        : requests.filter(
            (request) =>
              request.kind === "model" &&
              request.index > firstCompactionEndSeq,
          );

    check(
      `${caseName}: no recorded request carries the canary`,
      requests.length > 0 &&
        requests.every((request) => request.canaryCount === 0),
      JSON.stringify(requests.map((request) => request.canaryCount)),
    );

    if (caseName === "compaction") {
      const threshold = starts.some((event) => event.reason === "threshold");
      const finished = ends.find(
        (event) =>
          event.hasResult && event.summaryLength > 0 && event.aborted === false,
      );
      check("compaction: threshold compaction started", threshold);
      check(
        "compaction: provider usage chunk parsed at the threshold",
        ends.some((event) => (event.tokensBefore ?? 0) >= 190000),
        JSON.stringify(ends.map((event) => event.tokensBefore)),
      );
      check(
        "compaction: summary entry created (not aborted or empty)",
        !!finished,
        JSON.stringify(
          ends.map((event) => ({
            reason: event.reason,
            aborted: event.aborted,
            summaryLength: event.summaryLength,
          })),
        ),
      );
      check(
        "compaction: summarizer request recorded",
        summarizers.length >= 1,
        `summarizer=${summarizers.length}`,
      );
      check(
        "compaction: model request recorded after compaction",
        afterCompaction.length >= 1,
        `after=${afterCompaction.length}`,
      );
      check(
        "compaction: every model request masked",
        modelRequests.every((request) => request.canaryCount === 0),
        JSON.stringify(modelRequests.map((r) => r.canaryCount)),
      );
      check(
        "compaction: summarizer and post-compaction requests masked",
        [...summarizers, ...afterCompaction].every(
          (request) =>
            request.canaryCount === 0 && request.placeholderCount > 0,
        ),
        JSON.stringify(
          [...summarizers, ...afterCompaction].map((request) => ({
            kind: request.kind,
            index: request.index,
            canaryCount: request.canaryCount,
            placeholderCount: request.placeholderCount,
          })),
        ),
      );
    }

    if (caseName === "branch-summary") {
      check(
        "branch: summary entry created",
        !!result?.summaryEntry,
        JSON.stringify(result?.summaryEntry ?? null),
      );
      check(
        "branch: branch-summary request recorded",
        branchRequests.length >= 1,
        `branch=${branchRequests.length}`,
      );
      check(
        "branch: branch-summary request masked",
        branchRequests.length >= 1 &&
          branchRequests.every(
            (request) =>
              request.canaryCount === 0 && request.placeholderCount > 0,
          ),
        JSON.stringify(
          branchRequests.map((request) => ({
            index: request.index,
            canaryCount: request.canaryCount,
            placeholderCount: request.placeholderCount,
          })),
        ),
      );
      check(
        "branch: prompt after navigation masked",
        !!result?.afterTreeRequest &&
          result.afterTreeRequest.canaryCount === 0 &&
          result.afterTreeRequest.placeholderCount > 0,
        JSON.stringify(result?.afterTreeRequest ?? null),
      );
    }

    if (caseName === "retry") {
      const startsRetry = events.filter(
        (event) => event.type === "auto_retry_start",
      );
      const endsRetry = events.filter(
        (event) => event.type === "auto_retry_end",
      );
      const layer =
        startsRetry.length > 0
          ? "pi-agent"
          : modelRequests.length >= 2
            ? "provider-sdk"
            : "none";
      check(
        "retry: at least two model requests for the turn",
        modelRequests.length >= 2,
        `model=${modelRequests.length}`,
      );
      check(
        "retry: final turn succeeded",
        result?.last?.stopReason === "stop",
        JSON.stringify(result?.last ?? null),
      );
      check(
        "retry: every attempt masked",
        modelRequests.length >= 2 &&
          modelRequests.every(
            (request) =>
              request.canaryCount === 0 && request.placeholderCount > 0,
          ),
        JSON.stringify(
          modelRequests.map((request) => ({
            index: request.index,
            canaryCount: request.canaryCount,
            placeholderCount: request.placeholderCount,
          })),
        ),
      );
      check(
        `retry: pi agent-level retry (${startsRetry.length} auto_retry_start, ${endsRetry.length} auto_retry_end)`,
        startsRetry.length > 0 &&
          endsRetry.some((event) => event.success === true),
        `layer=${layer} model=${modelRequests.length}`,
      );
      result.retryLayer = layer;
      result.retryEvents = { starts: startsRetry, ends: endsRetry };
    }

    const verdict = checks.some((entry) => !entry.ok)
      ? "fail"
      : checks.length > 0
        ? "pass"
        : "unverified";
    return {
      verdict,
      dir,
      requests,
      events,
      caseErrors,
      checks,
      result,
      counts: {
        requests: requests.length,
        model: modelRequests.length,
        summarizer: summarizers.length,
        branchSummary: branchRequests.length,
        modelAfterCompaction: afterCompaction.length,
        canaryInRequests: requests.reduce(
          (sum, request) => sum + request.canaryCount,
          0,
        ),
      },
      eventsRecorded: eventNames(events),
      compaction: {
        starts,
        ends: ends.map((event) => ({
          reason: event.reason,
          aborted: event.aborted,
          summaryLength: event.summaryLength,
          tokensBefore: event.tokensBefore,
          estimatedTokensAfter: event.estimatedTokensAfter,
        })),
      },
    };
  } catch (error) {
    failure = redact(error?.stack ?? error);
    checks.push({
      label: `${caseName}: harness ran`,
      ok: false,
      detail: failure,
    });
    printCheck(checks.at(-1));
    return {
      verdict: "fail",
      dir,
      requests,
      events,
      caseErrors,
      checks,
      failure,
      counts: {
        requests: requests.length,
        model: requests.filter((r) => r.kind === "model").length,
        summarizer: requests.filter((r) => r.kind === "summarizer").length,
        branchSummary: requests.filter((r) => r.kind === "branch-summary")
          .length,
        canaryInRequests: requests.reduce(
          (sum, request) => sum + request.canaryCount,
          0,
        ),
      },
      eventsRecorded: eventNames(events),
    };
  } finally {
    try {
      session?.dispose();
    } catch {}
    server.closeIdleConnections();
    await new Promise((done) => server.close(done));
  }
}

const compaction = await runCase("compaction", async ({ prompt }) => {
  for (let turn = 1; turn <= 5; turn++)
    await prompt(`Turn ${turn}. ${note(turn)}`);
  await prompt(
    `PILIFE_AFTER_COMPACTION ${CANARY}. ` +
      "Post-compaction context. ".repeat(40),
  );
  return {};
});

const branchSummary = await runCase(
  "branch-summary",
  async ({ session, prompt, requests }) => {
    for (let turn = 1; turn <= 3; turn++)
      await prompt(`Branch turn ${turn}. ${note(turn)}`);
    const firstUser = session.sessionManager
      .getEntries()
      .find(
        (entry) => entry.type === "message" && entry.message.role === "user",
      );
    if (!firstUser) throw new Error("no user entry to navigate to");
    const result = await session.navigateTree(firstUser.id, {
      summarize: true,
    });
    const after = await prompt(
      `PILIFE_AFTER_TREE ${CANARY}. ` + "After tree context. ".repeat(40),
    );
    const afterTreeRequest = requests.at(-1);
    return { ...result, afterTreeRequest, last: after };
  },
);

const retry = await runCase("retry", async ({ prompt }) => {
  const last = await prompt(`Retry turn. ${note(1)}`);
  return { last };
});

const summary = {
  piVersion: packageInfo.version,
  nodeVersion: process.version,
  sourceCommit,
  placeholderPrefix: PSEUDONYM_TOKEN_PREFIX_V2,
  defaults: {
    compaction: SETTINGS_DEFAULTS.compaction,
    retry: SETTINGS_DEFAULTS.retry,
    branchSummary: SETTINGS_DEFAULTS.branchSummary,
  },
  cases: {
    compaction: {
      verdict: compaction.verdict,
      counts: compaction.counts,
      events: compaction.eventsRecorded,
      compaction: compaction.compaction,
      checks: compaction.checks,
      attempts: compaction.requests.map((request) => ({
        index: request.index,
        path: request.path,
        kind: request.kind,
        canaryCount: request.canaryCount,
        placeholderCount: request.placeholderCount,
      })),
    },
    branchSummary: {
      verdict: branchSummary.verdict,
      counts: branchSummary.counts,
      events: branchSummary.eventsRecorded,
      checks: branchSummary.checks,
      attempts: branchSummary.requests.map((request) => ({
        index: request.index,
        path: request.path,
        kind: request.kind,
        canaryCount: request.canaryCount,
        placeholderCount: request.placeholderCount,
      })),
    },
    retry: {
      verdict: retry.verdict,
      counts: retry.counts,
      events: retry.eventsRecorded,
      layer: retry.result?.retryLayer,
      retryEvents: retry.result?.retryEvents,
      checks: retry.checks,
      attempts: retry.requests.map((request) => ({
        index: request.index,
        path: request.path,
        kind: request.kind,
        canaryCount: request.canaryCount,
        placeholderCount: request.placeholderCount,
      })),
    },
  },
};

console.log(`\npi ${summary.piVersion} on node ${summary.nodeVersion}`);
console.log(
  `defaults: compaction=${JSON.stringify(summary.defaults.compaction)} ` +
    `retry=${JSON.stringify(summary.defaults.retry)} ` +
    `branchSummary=${JSON.stringify(summary.defaults.branchSummary)}`,
);
console.log(JSON.stringify(summary, null, 2));
writeFileSync(join(ROOT, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`\nEvidence written to ${ROOT}`);
if (Object.values(summary.cases).some((entry) => entry.verdict === "fail"))
  process.exitCode = 1;
