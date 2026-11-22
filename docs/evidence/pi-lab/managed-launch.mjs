import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createWireLab } from "./wire-proxy.mjs";

function validateConfiguration(configuration, provider) {
  if (!configuration || Object.keys(configuration).some((key) => key !== "providers") ||
      !configuration.providers || Array.isArray(configuration.providers)) {
    throw new Error("Invalid provider configuration");
  }
  for (const [name, entry] of Object.entries(configuration.providers)) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name) || !entry ||
        Object.keys(entry).some((key) => !["api", "baseUrl", "apiKey", "model"].includes(key)) ||
        entry.api !== "openai-completions" || entry.model !== "stub-model" ||
        typeof entry.apiKey !== "string" || !/^[\x21-\x7e]{1,512}$/.test(entry.apiKey)) {
      throw new Error("Unsupported provider configuration");
    }
    const endpoint = new URL(entry.baseUrl);
    if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" ||
        endpoint.pathname !== "/v1" || endpoint.username || endpoint.password ||
        endpoint.search || endpoint.hash) throw new Error("Loopback /v1 endpoint required");
  }
  if (!Object.hasOwn(configuration.providers, provider)) throw new Error("Unknown provider");
  return structuredClone(configuration.providers[provider]);
}

function executeVersion(cli, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, ["--version"], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 && output.trim() === "1.6.0") resolve();
      else reject(new Error("Pinned pi 1.6.0 required"));
    });
  });
}

export async function checkManagedProxy(origin, credential, sessionID) {
  const response = await fetch(new URL("/lab/mask", origin), {
    method: "POST",
    headers: {
      "content-type": "application/json", authorization: "Bearer " + credential,
      "x-pi98-session": sessionID,
    },
    body: JSON.stringify({ model: "stub-model", messages: [{role: "user", content: "PI98_PRIVATE_VALUE"}] }),
    signal: AbortSignal.timeout(3000), redirect: "error",
  });
  const masked = await response.text();
  if (!response.ok || masked.includes("PI98_PRIVATE_VALUE") || !masked.includes("[SGP2:")) {
    throw new Error("Proxy masking health check failed");
  }
}

// Research launcher for a single managed loopback provider and ephemeral session.
export async function launchManagedLab(options) {
  if (Object.keys(options).some((key) =>
    !["pi", "configuration", "provider", "message", "mode", "cwd"].includes(key))) {
    throw new Error("Unsupported launch override");
  }
  const { pi, configuration, provider, message = "", mode = "print", cwd = process.cwd() } = options;
  if (!["print", "rpc"].includes(mode) || typeof message !== "string") throw new Error("Invalid launch mode");
  const selected = validateConfiguration(configuration, provider);
  const extension = resolve(import.meta.dirname, "wire-extension.mjs");
  await access(extension);
  const directory = await mkdtemp(join(tmpdir(), "pi98-managed-"));
  const sessionID = randomUUID();
  const env = {
    PATH: process.env.PATH, HOME: directory, PI_CODING_AGENT_DIR: directory,
    PI_OFFLINE: "1", NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1",
    TERM: process.env.TERM ?? "xterm-256color",
  };
  let proxy;
  let child;
  try {
    await executeVersion(resolve(pi), env);
    proxy = createWireLab(selected.baseUrl + "/chat/completions", {
      piSessionID: sessionID, sessionID, upstreamCredential: selected.apiKey,
    });
    await new Promise((resolve, reject) => {
      proxy.server.once("error", reject);
      proxy.server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${proxy.server.address().port}`;
    await checkManagedProxy(origin, proxy.credential, sessionID);
    await writeFile(join(directory, "models.json"), JSON.stringify({
      providers: { [provider]: {
        api: selected.api, baseUrl: origin + "/v1", apiKey: proxy.credential,
        models: [{ id: selected.model }],
      } },
    }), { mode: 0o600, flag: "wx" });
    await writeFile(join(directory, "settings.json"), JSON.stringify({
      compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 },
      retry: { enabled: false }, quietStartup: true,
    }), { mode: 0o600, flag: "wx" });
    Object.assign(env, { PI98_BROKER_URL: origin, PI98_BROKER_KEY: proxy.credential });
    child = spawn(resolve(pi), [
      "--offline", ...(mode === "print" ? ["--print"] : ["--mode", "rpc"]),
      "--no-extensions", "--extension", extension, "--no-themes",
      "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve",
      "--tools", "read", "--model", provider + "/" + selected.model,
      "--session-id", sessionID, "--session-dir", directory,
      ...(mode === "print" ? ["--", message] : []),
    ], { cwd, env, stdio: [mode === "rpc" ? "pipe" : "ignore", "pipe", "pipe"] });
    const finished = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    // Cleanup is registered immediately, including launch errors and early child exits.
    const completion = finished.finally(async () => {
      await new Promise((resolve) => proxy.server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    });
    return { child, completion, directory, origin, sessionID, credential: proxy.credential, env,
      async stop() { child.kill(); return completion; },
      async stopProxy() { await new Promise((resolve) => proxy.server.close(resolve)); },
    };
  } catch (error) {
    child?.kill();
    if (proxy) await new Promise((resolve) => proxy.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      pi: { type: "string" }, config: { type: "string" }, provider: { type: "string" },
      message: { type: "string", default: "" },
    } });
    if (!values.pi || !values.config || !values.provider) throw new Error("Required pi, config and provider");
    const run = await launchManagedLab({
      pi: values.pi, provider: values.provider, message: values.message,
      configuration: JSON.parse(await readFile(values.config, "utf8")),
    });
    run.child.stdout.pipe(process.stdout);
    run.child.stderr.pipe(process.stderr);
    const stop = () => run.child.kill();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const result = await run.completion;
      process.exitCode = result.code ?? 1;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  } catch {
    console.error("Managed loopback launch refused");
    process.exitCode = 1;
  }
}
