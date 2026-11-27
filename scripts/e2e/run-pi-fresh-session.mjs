#!/usr/bin/env node
/**
 * Fresh-session check for the shipped pi extension on real pi 1.6.0.
 *
 * A. positive control: a placeholder minted in a session is restored when the
 *    provider echoes it back in that same session.
 * B. fresh session in the same process (via `AgentSessionRuntime.newSession`,
 *    the SDK path `/new` uses), mappings off: the literal token must survive.
 * C. fresh session in a new process, mappings off: the literal token must
 *    survive.
 * D. fresh session in a new process, encrypted store on: the literal token
 *    must survive. Resuming session 1 is the persistence positive control.
 *
 * C and D spawn this script as separate Node processes because the extension
 * installs its guard once per process on globalThis.
 *
 * Each fresh session also carries its own positive control: a canary-bearing
 * turn must reach the provider masked (no canary, at least one placeholder),
 * and echoing that session's new placeholder must come back as the canary.
 * Without those controls a fresh session that omitted the extension would
 * still pass every literal-token check.
 *
 * Keychain CLIs are stubbed inside the out tree and prepended to PATH so the
 * mapping key comes from the isolated keyfile, never the user's real Keychain.
 *
 * Every request body is written under `<out>/requests/`. The summary reports
 * booleans and counts only; the canary never leaves the guard config.
 *
 * Usage: node scripts/e2e/run-pi-fresh-session.mjs --runtime <npm-prefix> --out <dir>
 * Requires `npm run build` and pi 1.6.0 installed under `<runtime>`.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

const PI_VERSION = "1.6.0";
const CANARY = "PIFRESH_PRIVATE_VALUE";
const PERSIST_KEYS = [
  "LEAKSHIELD_PI_PERSIST",
  "LEAKSHIELD_PI_PERSIST_TTL_DAYS",
  "LEAKSHIELD_PI_PERSIST_PATH",
  "LEAKSHIELD_PI_PERSIST_KEYFILE",
  "LEAKSHIELD_PI_PERSIST_KEYFILE_PATH",
];
const LOADER_OPTIONS = {
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
};
const redact = (text) => String(text ?? "").split(CANARY).join("<canary>");
const countOccurrences = (text, needle) => text.split(needle).length - 1;

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * Both platform keychain probes resolve their CLI through PATH, so a temp
 * HOME does not isolate them: `security` would still reach the real login
 * Keychain. Prepend stubs that fail (exit 1) and log the invocation, which
 * makes the resolver step down to the isolated keyfile.
 */
function installKeychainStubs(binDir, logPath) {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(logPath, "");
  for (const name of ["security", "secret-tool"]) {
    const path = join(binDir, name);
    writeFileSync(
      path,
      `#!/bin/sh\nprintf '%s %s\\n' ${shellQuote(name)} "$*" >> ${shellQuote(logPath)}\nexit 1\n`,
    );
    chmodSync(path, 0o755);
  }
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
}

const option = (name) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
};

function placeholderRegex(PSEUDONYM_TOKEN_PREFIX_V2) {
  const escapedPrefix = PSEUDONYM_TOKEN_PREFIX_V2.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  return new RegExp(
    `${escapedPrefix}[A-Z_]+-[a-z]{4}-[a-z]{4}-[a-z]{4}\\]`,
    "g",
  );
}

function stream(response, text) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  const send = (data) => response.write(`data: ${JSON.stringify(data)}\n\n`);
  const base = {
    id: "chatcmpl_pifresh",
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
    usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 },
  });
  response.end("data: [DONE]\n\n");
}

function assistantText(session) {
  const last = [...session.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  if (last === undefined) {
    return { found: false, text: "", stopReason: null, errorMessage: null };
  }
  let text = "";
  if (typeof last.content === "string") text = last.content;
  else
    for (const part of last.content ?? [])
      if (part?.type === "text") text += part.text;
  return {
    found: true,
    text,
    stopReason: last.stopReason ?? null,
    errorMessage: last.errorMessage ? redact(last.errorMessage) : null,
  };
}

function facts(message, token) {
  return {
    found: message.found,
    hasCanary: message.text.includes(CANARY),
    hasToken: token !== null && message.text.includes(token),
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
  };
}

function startStub(config, prefix) {
  const state = {
    phase: config.phase,
    echoToken: config.echoToken ?? null,
    capturedToken: null,
    mintPhase: config.mintPhase ?? null,
    phaseCounts: {},
    requests: [],
  };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const phase = state.phase;
    const index = (state.phaseCounts[phase] ?? 0) + 1;
    state.phaseCounts[phase] = index;
    const tokens = body.match(prefix) ?? [];
    if (phase === state.mintPhase && state.capturedToken === null && tokens[0])
      state.capturedToken = tokens[0];
    const name = `${phase}--${String(index).padStart(3, "0")}.json`;
    writeFileSync(join(config.requestsDir, name), body);
    const recordedRequest = {
      phase,
      index,
      file: basename(name),
      canaryCount: countOccurrences(body, CANARY),
      tokenCount: tokens.length,
      placeholderCount: tokens.length,
    };
    state.lastRequest = recordedRequest;
    state.lastTokens = tokens;
    state.requests.push(recordedRequest);
    stream(
      response,
      state.echoToken === null ? "synthetic ok" : `ECHO ${state.echoToken}`,
    );
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () =>
      done({ server, state, base: `http://127.0.0.1:${server.address().port}` }),
    ),
  );
}

function writeSessionConfig(agentDir, base) {
  writeFileSync(
    join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          stub: {
            baseUrl: `${base}/v1`,
            api: "openai-completions",
            apiKey: "pifresh-loopback-key",
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
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(agentDir, "settings.json"),
    `${JSON.stringify(
      { defaultProvider: "stub", defaultModel: "stub-model" },
      null,
      2,
    )}\n`,
  );
}

async function runChild(config) {
  const REPO = resolve(import.meta.dirname, "../..");
  const extensionPath = join(REPO, "dist/adapters/pi/extension.js");
  const packageDir = join(
    config.runtimeDir,
    "node_modules/@earendil-works/pi-coding-agent",
  );
  const result = {
    tag: config.tag,
    mode: config.mode,
    ok: false,
    error: null,
    sessions: [],
    requests: [],
  };
  let stub;
  try {
    if (
      config.binDir &&
      !(process.env.PATH ?? "").startsWith(`${config.binDir}:`)
    ) {
      process.env.PATH = `${config.binDir}:${process.env.PATH ?? ""}`;
    }
    process.chdir(config.cwd);
    process.env.HOME = config.home;
    process.env.XDG_DATA_HOME = join(config.home, ".local/share");
    process.env.XDG_CONFIG_HOME = join(config.home, ".config");
    process.env.PI_CODING_AGENT_DIR = config.agentDir;
    process.env.PI_OFFLINE = "1";
    process.env.PI_SKIP_VERSION_CHECK = "1";
    process.env.LEAKSHIELD_CONFIG = config.configPath;
    for (const key of PERSIST_KEYS) delete process.env[key];
    if (config.persist?.enabled) {
      process.env.LEAKSHIELD_PI_PERSIST = "1";
      process.env.LEAKSHIELD_PI_PERSIST_PATH = config.persist.storePath;
      process.env.LEAKSHIELD_PI_PERSIST_KEYFILE = "1";
      process.env.LEAKSHIELD_PI_PERSIST_KEYFILE_PATH =
        config.persist.keyfilePath;
    }

    mkdirSync(join(config.agentDir, "sessions"), { recursive: true });
    mkdirSync(config.requestsDir, { recursive: true });
    const { PSEUDONYM_TOKEN_PREFIX_V2 } = await import(
      pathToFileURL(join(REPO, "dist/decision/pseudonymization.js")).href
    );
    const prefix = placeholderRegex(PSEUDONYM_TOKEN_PREFIX_V2);

    stub = await startStub(config, prefix);
    writeSessionConfig(config.agentDir, stub.base);
    const pi = await import(pathToFileURL(join(packageDir, "dist/index.js")).href);
    const errors = [];
    const onError = (error) =>
      errors.push({
        event: error.event,
        error: redact(error.error),
      });
    const checkLoad = (extensionErrors, where) => {
      if (extensionErrors.length === 0) return;
      throw new Error(
        `${where} extension load error: ` +
          JSON.stringify(
            extensionErrors.map((entry) => ({
              path: entry.path,
              error: redact(entry.error),
            })),
          ),
      );
    };
    const loaderOptions = {
      ...LOADER_OPTIONS,
      additionalExtensionPaths: [extensionPath],
    };

    if (config.mode === "same-process") {
      const sessionDir = join(config.agentDir, "sessions");
      const createRuntime = async ({
        cwd,
        agentDir,
        sessionManager,
        sessionStartEvent,
      }) => {
        const services = await pi.createAgentSessionServices({
          cwd,
          agentDir,
          resourceLoaderOptions: loaderOptions,
        });
        checkLoad(
          services.resourceLoader.getExtensions().errors,
          "services",
        );
        const created = await pi.createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          thinkingLevel: "off",
          tools: [],
        });
        checkLoad(created.extensionsResult.errors, "session");
        return {
          ...created,
          services,
          diagnostics: services.diagnostics,
        };
      };
      const runtime = await pi.createAgentSessionRuntime(createRuntime, {
        cwd: config.cwd,
        agentDir: config.agentDir,
        sessionManager: pi.SessionManager.create(config.cwd, sessionDir),
      });
      const bind = async (session) =>
        session.bindExtensions({ mode: "rpc", onError });
      await bind(runtime.session);
      runtime.setRebindSession(bind);

      const first = runtime.session;
      const firstId = first.sessionId;
      const echoIn = async (session, message) => {
        await session.prompt(message);
        return assistantText(session);
      };

      stub.state.phase = "A";
      await echoIn(
        first,
        `Synthetic NDA note for the fresh-session check: ${CANARY}.`,
      );
      const token = stub.state.capturedToken;
      result.sessions.push({
        phase: "A",
        id: firstId,
        file: first.sessionFile ?? null,
        persisted: first.sessionManager.isPersisted(),
      });

      stub.state.echoToken = token;
      const echoed = await echoIn(
        first,
        "Echo the protected value from the previous turn.",
      );
      result.a = { sessionId: firstId, token, ...facts(echoed, token) };

      const switched = await runtime.newSession();
      if (switched.cancelled) throw new Error("newSession was cancelled");
      const second = runtime.session;
      const secondId = second.sessionId;
      stub.state.phase = "B";
      stub.state.echoToken = token;
      const fresh = await echoIn(
        second,
        "Continue in this new session.",
      );
      result.ids = {
        first: firstId,
        second: secondId,
        distinct: firstId !== secondId,
      };
      result.sessions.push({
        phase: "B",
        id: secondId,
        file: second.sessionFile ?? null,
        persisted: second.sessionManager.isPersisted(),
      });
      result.b = { sessionId: secondId, ...facts(fresh, token) };

      stub.state.phase = "B-control";
      stub.state.echoToken = null;
      await echoIn(
        second,
        `Synthetic NDA note for the fresh-session check: ${CANARY}.`,
      );
      const controlRequest = stub.state.lastRequest ?? null;
      const controlToken = stub.state.lastTokens?.at(-1) ?? null;
      stub.state.echoToken = controlToken;
      const controlEcho = await echoIn(
        second,
        "Echo the protected value from the previous turn.",
      );
      result.freshControl = {
        request: controlRequest,
        token: controlToken,
        restored: facts(controlEcho, controlToken),
      };
      await runtime.dispose();
    } else {
      const sessionDir = join(config.agentDir, "sessions");
      const sessionManager =
        config.mode === "resume"
          ? pi.SessionManager.open(config.sessionFile, sessionDir, config.cwd)
          : pi.SessionManager.create(config.cwd, sessionDir);
      const loader = new pi.DefaultResourceLoader({
        cwd: config.cwd,
        agentDir: config.agentDir,
        ...loaderOptions,
      });
      await loader.reload();
      checkLoad(loader.extensionsResult.errors, "loader");
      const created = await pi.createAgentSession({
        cwd: config.cwd,
        agentDir: config.agentDir,
        resourceLoader: loader,
        thinkingLevel: "off",
        tools: [],
        sessionManager,
      });
      checkLoad(created.extensionsResult.errors, "session");
      const session = created.session;
      await session.bindExtensions({ mode: "rpc", onError });
      stub.state.phase = config.phase;
      stub.state.echoToken = config.echoToken ?? null;
      await session.prompt(
        config.mint
          ? `Synthetic NDA note for the fresh-session check: ${CANARY}.`
          : "Continue in this session.",
      );
      const token = config.mint ? stub.state.capturedToken : config.echoToken;
      const message = assistantText(session);
      result.sessions.push({
        phase: config.phase,
        id: session.sessionId,
        file: session.sessionFile ?? null,
        persisted: session.sessionManager.isPersisted(),
      });
      result.assistant = facts(message, token ?? null);
      if (config.mint) result.token = token;

      if (config.freshControl) {
        const controlPhase = `${config.phase}-control`;
        stub.state.phase = controlPhase;
        stub.state.echoToken = null;
        const before = stub.state.requests.length;
        await session.prompt(
          `Synthetic NDA note for the fresh-session check: ${CANARY}.`,
        );
        const recorded = stub.state.requests
          .slice(before)
          .filter((entry) => entry.phase === controlPhase);
        const controlRequest = recorded.at(-1) ?? null;
        const controlToken = stub.state.lastTokens?.at(-1) ?? null;
        stub.state.echoToken = controlToken;
        await session.prompt(
          "Echo the protected value from the previous turn.",
        );
        result.freshControl = {
          request: controlRequest,
          token: controlToken,
          restored: facts(assistantText(session), controlToken),
        };
      }
    }

    result.requests = stub.state.requests;
    result.sessionErrors = errors;
    result.ok = errors.length === 0;
    if (!result.ok)
      result.error = `extension handlers reported ${errors.length} error(s)`;
  } catch (error) {
    result.error = redact(error?.stack ?? error);
  } finally {
    if (stub !== undefined)
      await new Promise((done) => stub.server.close(done));
    writeFileSync(config.resultPath, JSON.stringify(result, null, 2));
  }
  process.exitCode = result.ok ? 0 : 1;
}

function spawnChild(config) {
  const args = [import.meta.filename, "--child", JSON.stringify(config)];
  return new Promise((done) => {
    const child = spawn(process.execPath, args, {
      cwd: config.cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("close", (code) => done({ code, stdout, stderr }));
  });
}

async function runMain() {
  const usage = () =>
    "usage: node scripts/e2e/run-pi-fresh-session.mjs --runtime <dir> --out <evidence-dir>";
  const runtimeArg = option("--runtime");
  const outArg = option("--out");
  if (!runtimeArg || !outArg) {
    console.error(usage());
    process.exit(2);
  }

  const runtimeDir = resolve(runtimeArg);
  const packageDir = join(
    runtimeDir,
    "node_modules/@earendil-works/pi-coding-agent",
  );
  const packageInfo = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8"),
  );
  if (packageInfo.version !== PI_VERSION) {
    console.error(
      `This check is pinned to pi ${PI_VERSION}, received ${packageInfo.version}`,
    );
    process.exit(2);
  }
  const REPO = resolve(import.meta.dirname, "../..");
  const extensionPath = join(REPO, "dist/adapters/pi/extension.js");
  if (!existsSync(extensionPath)) {
    console.error(`missing ${extensionPath}; run npm run build first`);
    process.exit(2);
  }
  const { PSEUDONYM_TOKEN_PREFIX_V2 } = await import(
    pathToFileURL(join(REPO, "dist/decision/pseudonymization.js")).href
  );

  const outPath = resolve(outArg);
  if (outPath.includes(delimiter)) {
    console.error(
      `--out must not contain "${delimiter}": the keychain stub directory is prepended to PATH`,
    );
    process.exit(2);
  }
  const isInside = (parent, child) => {
    const rel = relative(parent, child);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
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
  const REAL_OUT = realpathAllowingMissing(outPath);
  if (
    REAL_OUT.includes(delimiter) ||
    REAL_OUT === REAL_TMP ||
    !isInside(REAL_TMP, REAL_OUT) ||
    isInside(realpathSync(REPO), REAL_OUT) ||
    isInside(REAL_OUT, realpathSync(REPO)) ||
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
  const casesDir = join(ROOT, "cases");
  mkdirSync(requestsDir, { recursive: true });
  mkdirSync(casesDir, { recursive: true });
  const stubBinDir = join(ROOT, "keychain-stub");
  const stubLogPath = join(ROOT, "keychain-stub.log");
  installKeychainStubs(stubBinDir, stubLogPath);
  const configPath = join(ROOT, "guard.config.yaml");
  writeFileSync(
    configPath,
    `nda_keywords:\n  - ${CANARY}\nprivate_domains: []\ncustom_rules: []\n`,
  );
  const revision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO,
    encoding: "utf8",
  });
  const sourceCommit =
    revision.status === 0 ? revision.stdout.trim() : "not-recorded";

  const checks = [];
  const record = (label, ok, detail = "") => {
    const entry = { label, ok: !!ok, detail: redact(detail) };
    checks.push(entry);
    console.log(
      `${entry.ok ? "ok  " : "FAIL"} ${entry.label}${entry.ok || !entry.detail ? "" : `: ${entry.detail}`}`,
    );
    return entry.ok;
  };

  const caseConfig = (caseDir, tag, extra = {}) => {
    const agentDir = join(caseDir, "agent");
    const home = join(caseDir, "home");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    return {
      tag,
      mode: "new",
      phase: tag,
      mint: false,
      mintPhase: null,
      echoToken: null,
      sessionFile: null,
      persist: null,
      runtimeDir,
      agentDir,
      home,
      cwd: agentDir,
      configPath,
      requestsDir,
      binDir: stubBinDir,
      resultPath: join(caseDir, `result-${tag}.json`),
      ...extra,
    };
  };

  const runChildConfig = async (label, config) => {
    const run = await spawnChild(config);
    if (!existsSync(config.resultPath)) {
      record(
        label,
        false,
        `child exit ${run.code}, no result: ${redact(run.stderr.slice(-800))}`,
      );
      return null;
    }
    const result = JSON.parse(readFileSync(config.resultPath, "utf8"));
    if (!result.ok || run.code !== 0) {
      record(
        label,
        false,
        `child exit ${run.code}: ${redact(result.error ?? run.stderr.slice(-800))}`,
      );
      return null;
    }
    return result;
  };

  const abDir = join(casesDir, "A-B");
  const cDir = join(casesDir, "C");
  const dDir = join(casesDir, "D");

  const controlRequestOk = (control) =>
    control?.request?.canaryCount === 0 &&
    (control?.request?.placeholderCount ?? 0) > 0;
  const controlRestoreOk = (control) =>
    control?.restored?.hasCanary === true &&
    control?.restored?.hasToken === false;
  const controlDetail = (control) =>
    JSON.stringify({
      request: control?.request ?? null,
      restored: control?.restored ?? null,
    });
  const tokenDiffers = (control, previous) =>
    typeof control?.token === "string" &&
    control.token.length > 0 &&
    control.token !== previous;

  const ab = await runChildConfig(
    "A/B: harness ran in one real pi process",
    caseConfig(abDir, "AB", { mode: "same-process", mintPhase: "A" }),
  );
  const a = ab?.a;
  const b = ab?.b;

  record(
    "A: captured a placeholder from the minted request",
    !!a?.token,
    JSON.stringify({ captured: !!a?.token }),
  );
  record(
    "A: same-session echo was restored to the canary",
    a?.hasCanary === true && a?.hasToken === false,
    JSON.stringify({ hasCanary: a?.hasCanary, hasToken: a?.hasToken }),
  );
  record(
    "A: same-session assistant text no longer holds the literal token",
    a?.hasToken === false,
    JSON.stringify({ hasToken: a?.hasToken }),
  );

  record(
    "B: new session has a distinct session id",
    ab?.ids?.distinct === true,
    JSON.stringify(ab?.ids ?? null),
  );
  record(
    "B: new session kept the literal token (guard bound to the new id)",
    b?.hasToken === true,
    JSON.stringify({ found: b?.found, hasToken: b?.hasToken }),
  );
  record(
    "B: fresh session assistant text carries no canary",
    b?.hasCanary === false,
    JSON.stringify({ hasCanary: b?.hasCanary }),
  );
  record(
    "B: fresh control request masked the canary to a placeholder",
    controlRequestOk(ab?.freshControl),
    controlDetail(ab?.freshControl),
  );
  record(
    "B: fresh control echo of the new placeholder was restored to the canary",
    controlRestoreOk(ab?.freshControl),
    controlDetail(ab?.freshControl),
  );

  const cMint = await runChildConfig(
    "C: mint process ran",
    caseConfig(cDir, "C-mint", {
      mint: true,
      mintPhase: "C-mint",
      phase: "C-mint",
    }),
  );
  const cToken = cMint?.token ?? null;
  const cFresh = await runChildConfig(
    "C: fresh process ran",
    caseConfig(cDir, "C-fresh", {
      echoToken: cToken,
      phase: "C-fresh",
      freshControl: true,
    }),
  );
  record(
    "C: mint process and fresh process have distinct session ids",
    !!cMint?.sessions[0]?.id &&
      !!cFresh?.sessions[0]?.id &&
      cMint.sessions[0].id !== cFresh.sessions[0].id,
    JSON.stringify({
      mint: cMint?.sessions[0]?.id ?? null,
      fresh: cFresh?.sessions[0]?.id ?? null,
    }),
  );
  record(
    "C: fresh process kept the literal token",
    cFresh?.assistant?.hasToken === true,
    JSON.stringify({
      found: cFresh?.assistant?.found,
      hasToken: cFresh?.assistant?.hasToken,
    }),
  );
  record(
    "C: fresh process assistant text carries no canary",
    cFresh?.assistant?.hasCanary === false,
    JSON.stringify({ hasCanary: cFresh?.assistant?.hasCanary }),
  );
  record(
    "C: fresh control request masked the canary to a placeholder",
    controlRequestOk(cFresh?.freshControl),
    controlDetail(cFresh?.freshControl),
  );
  record(
    "C: fresh control echo of the new placeholder was restored to the canary",
    controlRestoreOk(cFresh?.freshControl),
    controlDetail(cFresh?.freshControl),
  );

  const persist = {
    enabled: true,
    storePath: join(dDir, "state/mappings.db"),
    keyfilePath: join(dDir, "state/mappings.key"),
  };
  const dMint = await runChildConfig(
    "D: mint process ran with persistence on",
    caseConfig(dDir, "D-mint", {
      mint: true,
      mintPhase: "D-mint",
      phase: "D-mint",
      persist,
    }),
  );
  const dToken = dMint?.token ?? null;
  const keychainLog = existsSync(stubLogPath)
    ? readFileSync(stubLogPath, "utf8").trim()
    : "";
  record(
    "D: keychain stub intercepted the mapping-key probe",
    keychainLog
      .split("\n")
      .filter(Boolean)
      .some((line) =>
        line.startsWith(
          process.platform === "darwin" ? "security " : "secret-tool ",
        ),
      ),
    JSON.stringify({
      invocations: keychainLog.split("\n").filter(Boolean).length,
      keyfileExists: existsSync(persist.keyfilePath),
    }),
  );
  record(
    "D: mapping key came from the isolated keyfile",
    existsSync(persist.keyfilePath),
    JSON.stringify({ keyfileExists: existsSync(persist.keyfilePath) }),
  );
  const dFresh = await runChildConfig(
    "D: fresh process ran with persistence on",
    caseConfig(dDir, "D-fresh", {
      echoToken: dToken,
      phase: "D-fresh",
      persist,
      freshControl: true,
    }),
  );
  const dSessionFile = dMint?.sessions[0]?.file ?? null;
  const dResume = dSessionFile
    ? await runChildConfig(
        "D: resumed process ran with persistence on",
        caseConfig(dDir, "D-resume", {
          mode: "resume",
          sessionFile: dSessionFile,
          echoToken: dToken,
          phase: "D-resume",
          persist,
        }),
      )
    : null;

  record(
    "D: fresh process has a distinct session id",
    !!dMint?.sessions[0]?.id &&
      !!dFresh?.sessions[0]?.id &&
      dMint.sessions[0].id !== dFresh.sessions[0].id,
    JSON.stringify({
      mint: dMint?.sessions[0]?.id ?? null,
      fresh: dFresh?.sessions[0]?.id ?? null,
    }),
  );
  record(
    "D: fresh process kept the literal token",
    dFresh?.assistant?.hasToken === true,
    JSON.stringify({
      found: dFresh?.assistant?.found,
      hasToken: dFresh?.assistant?.hasToken,
    }),
  );
  record(
    "D: fresh process assistant text carries no canary",
    dFresh?.assistant?.hasCanary === false,
    JSON.stringify({ hasCanary: dFresh?.assistant?.hasCanary }),
  );
  record(
    "D: fresh control request masked the canary to a placeholder",
    controlRequestOk(dFresh?.freshControl),
    controlDetail(dFresh?.freshControl),
  );
  record(
    "D: fresh control echo of the new placeholder was restored to the canary",
    controlRestoreOk(dFresh?.freshControl),
    controlDetail(dFresh?.freshControl),
  );
  record(
    "D control: resumed session restored the token from the store",
    !!dResume &&
      dResume.sessions[0]?.id === dMint?.sessions[0]?.id &&
      dResume.assistant?.hasCanary === true &&
      dResume.assistant?.hasToken === false,
    JSON.stringify({
      resumedSessionId: dResume?.sessions[0]?.id ?? null,
      mintSessionId: dMint?.sessions[0]?.id ?? null,
      hasCanary: dResume?.assistant?.hasCanary,
      hasToken: dResume?.assistant?.hasToken,
    }),
  );

  const scan = (() => {
    const byTag = new Map();
    for (const name of readdirSync(requestsDir)) {
      if (!name.endsWith(".json")) continue;
      const tag = name.split("--")[0];
      const body = readFileSync(join(requestsDir, name), "utf8");
      const entry = byTag.get(tag) ?? { requests: 0, canary: 0 };
      entry.requests += 1;
      entry.canary += countOccurrences(body, CANARY);
      byTag.set(tag, entry);
    }
    return byTag;
  })();
  const stats = (tags) => ({
    requests: tags.reduce((sum, tag) => sum + (scan.get(tag)?.requests ?? 0), 0),
    canary: tags.reduce((sum, tag) => sum + (scan.get(tag)?.canary ?? 0), 0),
  });
  const bStats = stats(["B", "B-control"]);
  const cStats = stats(["C-mint", "C-fresh", "C-fresh-control"]);
  const dStats = stats([
    "D-mint",
    "D-fresh",
    "D-fresh-control",
    "D-resume",
  ]);

  record(
    "A: every recorded request carries no canary",
    (scan.get("A")?.canary ?? 0) === 0 && (scan.get("A")?.requests ?? 0) > 0,
    JSON.stringify({ requests: scan.get("A")?.requests ?? 0, canary: scan.get("A")?.canary ?? 0 }),
  );
  record(
    "B: every recorded request carries no canary",
    bStats.canary === 0 && bStats.requests > 0,
    JSON.stringify(bStats),
  );
  record(
    "C: every recorded request carries no canary",
    cStats.canary === 0 && cStats.requests > 0,
    JSON.stringify(cStats),
  );
  record(
    "D: every recorded request carries no canary",
    dStats.canary === 0 && dStats.requests > 0,
    JSON.stringify(dStats),
  );

  const scoped = (letter) =>
    checks.filter((entry) => entry.label.startsWith(`${letter}:`));
  const aOk = scoped("A").every((entry) => entry.ok);
  const bOk = scoped("B").every((entry) => entry.ok);
  const cOk = scoped("C").every((entry) => entry.ok);
  const dFreshOk = scoped("D").every((entry) => entry.ok);
  const dControlOk =
    checks.find((entry) =>
      entry.label.startsWith("D control:"),
    )?.ok === true;

  const scenario = (letter, ok, extra) => ({
    verdict:
      letter === "A"
        ? ok
          ? "pass"
          : "fail"
        : aOk
          ? ok
            ? "pass"
            : "fail"
          : "unverified",
    restored: extra.restored,
    tokenLiteralKept: extra.tokenLiteralKept,
    requestCounts: extra.requestCounts,
    canaryInRequests: extra.canaryInRequests,
    sessionIds: extra.sessionIds,
    freshControl: extra.freshControl ?? null,
    checks: scoped(letter),
  });

  const summary = {
    harness: "run-pi-fresh-session",
    piVersion: packageInfo.version,
    nodeVersion: process.version,
    sourceCommit,
    placeholderPrefix: PSEUDONYM_TOKEN_PREFIX_V2,
    scenarios: {
      A: scenario("A", aOk, {
        restored: a?.hasCanary === true,
        tokenLiteralKept: a?.hasToken === true,
        requestCounts: { sameSession: scan.get("A")?.requests ?? 0 },
        canaryInRequests: scan.get("A")?.canary ?? 0,
        sessionIds: {
          count: 1,
          sameSession: true,
          distinct: null,
          ids: ab?.ids?.first ? [ab.ids.first] : [],
        },
      }),
      B: scenario("B", bOk, {
        restored: b?.hasCanary === true,
        tokenLiteralKept: b?.hasToken === true,
        requestCounts: {
          fresh: scan.get("B")?.requests ?? 0,
          freshControl: scan.get("B-control")?.requests ?? 0,
        },
        canaryInRequests: bStats.canary,
        sessionIds: {
          count: 2,
          distinct: ab?.ids?.distinct === true,
          ids: ab?.ids ? [ab.ids.first, ab.ids.second] : [],
        },
        freshControl: {
          request: ab?.freshControl?.request ?? null,
          tokenCaptured:
            typeof ab?.freshControl?.token === "string" &&
            ab.freshControl.token.length > 0,
          tokenDiffersFromOldSessionToken: tokenDiffers(
            ab?.freshControl,
            a?.token,
          ),
        },
      }),
      C: scenario("C", cOk, {
        restored: cFresh?.assistant?.hasCanary === true,
        tokenLiteralKept: cFresh?.assistant?.hasToken === true,
        requestCounts: {
          mint: scan.get("C-mint")?.requests ?? 0,
          fresh: scan.get("C-fresh")?.requests ?? 0,
          freshControl: scan.get("C-fresh-control")?.requests ?? 0,
        },
        canaryInRequests: cStats.canary,
        sessionIds: {
          distinct:
            !!cMint?.sessions[0]?.id &&
            !!cFresh?.sessions[0]?.id &&
            cMint.sessions[0].id !== cFresh.sessions[0].id,
          ids: [
            cMint?.sessions[0]?.id ?? null,
            cFresh?.sessions[0]?.id ?? null,
          ],
        },
        freshControl: {
          request: cFresh?.freshControl?.request ?? null,
          tokenCaptured:
            typeof cFresh?.freshControl?.token === "string" &&
            cFresh.freshControl.token.length > 0,
          tokenDiffersFromOldSessionToken: tokenDiffers(
            cFresh?.freshControl,
            cToken,
          ),
        },
      }),
      D: {
        ...scenario("D", dFreshOk, {
          restored: dFresh?.assistant?.hasCanary === true,
          tokenLiteralKept: dFresh?.assistant?.hasToken === true,
          requestCounts: {
            mint: scan.get("D-mint")?.requests ?? 0,
            fresh: scan.get("D-fresh")?.requests ?? 0,
            freshControl: scan.get("D-fresh-control")?.requests ?? 0,
            resume: scan.get("D-resume")?.requests ?? 0,
          },
          canaryInRequests: dStats.canary,
          sessionIds: {
            distinct:
              !!dMint?.sessions[0]?.id &&
              !!dFresh?.sessions[0]?.id &&
              dMint.sessions[0].id !== dFresh.sessions[0].id,
            ids: [
              dMint?.sessions[0]?.id ?? null,
              dFresh?.sessions[0]?.id ?? null,
            ],
          },
          freshControl: {
            request: dFresh?.freshControl?.request ?? null,
            tokenCaptured:
              typeof dFresh?.freshControl?.token === "string" &&
              dFresh.freshControl.token.length > 0,
            tokenDiffersFromOldSessionToken: tokenDiffers(
              dFresh?.freshControl,
              dToken,
            ),
          },
        }),
        persistenceControl: {
          restored: dResume?.assistant?.hasCanary === true,
          verdict: dControlOk ? "pass" : "fail",
          sessionIdReused: dResume?.sessions[0]?.id === dMint?.sessions[0]?.id,
        },
      },
    },
  };

  const serialized = JSON.stringify(summary, null, 2);
  if (serialized.includes(CANARY)) {
    console.error("refusing to write a summary that contains the canary");
    process.exit(1);
  }
  console.log(`\npi ${summary.piVersion} on node ${summary.nodeVersion}`);
  console.log(serialized);
  writeFileSync(join(ROOT, "summary.json"), `${serialized}\n`);
  console.log(`\nEvidence written to ${ROOT}`);
  if (checks.some((entry) => !entry.ok)) process.exitCode = 1;
}

const childArg = option("--child");
if (childArg !== undefined) await runChild(JSON.parse(childArg));
else await runMain();
