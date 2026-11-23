/**
 * `leakshield pi` — managed launch of the pi coding agent.
 *
 * The launcher is the enforceable part of the pi adapter. It reads the user's
 * pi settings and models, resolves one provider, starts the loopback provider
 * boundary, and writes a generated agent directory whose only provider is that
 * boundary. The child never receives the upstream credential.
 *
 * Session storage stays with the user, so `--continue`, `--resume` and
 * `--session` behave as before. With `--persist`, the mapping store also
 * survives a restart and a resumed session can restore its placeholders.
 */
import path from "node:path";
import { defaultStorePath } from "../decision/mapping-key.js";
import type { GuardConfig } from "../types.js";
import type { PiProxy, PiProxyOptions } from "./proxy.js";
import {
  loadPiUserAgent,
  resolvePiProvider,
  resolveSessionDir,
  type PiModelEntry,
  type PiProviderResolution,
} from "./settings.js";

export const PI_EXTENSION_ENV_URL = "LEAKSHIELD_PI_URL";
export const PI_EXTENSION_ENV_TOKEN = "LEAKSHIELD_PI_TOKEN";
export const SUPPORTED_PI_MAJOR = 1;
export const MINIMUM_PI_MINOR = 6;

/** Provider credentials the managed child must not inherit. */
const CHILD_SCRUBBED_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "AZURE_OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "TOGETHER_API_KEY",
  "CEREBRAS_API_KEY",
  "BASETEN_API_KEY",
  "NVIDIA_API_KEY",
  "XAI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "FIREWORKS_API_KEY",
  "ZAI_API_KEY",
  "MISTRAL_API_KEY",
  "AI_GATEWAY_API_KEY",
  "PI_CODING_AGENT_DIR",
] as const;

const SAFE_MODEL_FIELDS = [
  "id",
  "name",
  "api",
  "reasoning",
  "thinkingLevelMap",
  "input",
  "inputLimits",
  "cost",
  "promptCache",
  "contextWindow",
  "maxTokens",
  "samplingParams",
  "samplingParamsByThinkingLevel",
  "compat",
] as const;

export interface PiLauncherArgs {
  provider?: string;
  model?: string;
  upstream?: string;
  api?: string;
  configPath?: string;
  controlPort: number;
  persist: boolean;
  persistTtlDays: number;
  persistPath?: string;
  persistKeyfile: boolean;
  piArgs: string[];
}

export interface ParsedLauncherArgs {
  launcher: PiLauncherArgs;
  error?: string;
}

function valueOf(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined;
}

/** Flags this launcher owns; everything else is forwarded to pi unchanged. */
export function parseLauncherArgs(args: readonly string[]): ParsedLauncherArgs {
  const launcher: PiLauncherArgs = {
    controlPort: 0,
    persist: false,
    persistTtlDays: 7,
    persistKeyfile: false,
    piArgs: [],
  };
  const ownedWithValue = new Set([
    "--provider",
    "--model",
    "--upstream",
    "--api",
    "--config",
    "--control-port",
    "--persist-ttl-days",
    "--persist-path",
  ]);
  const ownedBoolean = new Set(["--persist", "--persist-keyfile"]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (ownedBoolean.has(arg)) continue;
    if (ownedWithValue.has(arg)) {
      index += 1;
      continue;
    }
    launcher.piArgs.push(arg);
  }

  launcher.provider = valueOf(args, "--provider");
  launcher.model = valueOf(args, "--model");
  launcher.upstream = valueOf(args, "--upstream");
  launcher.api = valueOf(args, "--api");
  launcher.configPath = valueOf(args, "--config");
  launcher.persist = args.includes("--persist");
  launcher.persistKeyfile = args.includes("--persist-keyfile");
  launcher.persistPath = valueOf(args, "--persist-path");

  const rawPort = valueOf(args, "--control-port");
  if (rawPort !== undefined) {
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      return { launcher, error: "--control-port must be an integer from 0 to 65535" };
    }
    launcher.controlPort = port;
  }
  const rawTtl = valueOf(args, "--persist-ttl-days");
  if (rawTtl !== undefined) {
    const ttl = Number(rawTtl);
    if (!Number.isInteger(ttl) || ttl < 0 || ttl > 3650) {
      return { launcher, error: "--persist-ttl-days must be an integer from 0 to 3650" };
    }
    launcher.persistTtlDays = ttl;
  }
  return { launcher };
}

/** Accepts exactly pi 1.6.0 and later within major 1; anything else is refused. */
export function parsePiVersion(output: string | null): string | null {
  if (output === null) return null;
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(output);
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== SUPPORTED_PI_MAJOR || minor < MINIMUM_PI_MINOR) return null;
  return `${match[1]}.${match[2]}.${match[3]}`;
}

export interface PiManagedFiles {
  modelsJson: string;
  settingsJson: string;
}

function projectModel(entry: PiModelEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of SAFE_MODEL_FIELDS) {
    if (entry[field] !== undefined) out[field] = entry[field];
  }
  return out;
}

/** Builds the child's generated agent directory content. */
export function buildManagedFiles(
  resolution: PiProviderResolution,
  options: { proxyUrl: string; sessionDir: string; extensionPath: string },
): PiManagedFiles {
  const provider: Record<string, unknown> = {
    baseUrl: options.proxyUrl,
    api: resolution.upstream.api,
    apiKey: `$${PI_EXTENSION_ENV_TOKEN}`,
  };
  if (resolution.modelEntries.length > 0) {
    provider.models = resolution.modelEntries.map(projectModel);
  }
  const settings = {
    packages: [],
    extensions: [options.extensionPath],
    sessionDir: options.sessionDir,
    defaultProvider: resolution.provider,
  };
  return {
    modelsJson: `${JSON.stringify({ providers: { [resolution.provider]: provider } }, null, 2)}\n`,
    settingsJson: `${JSON.stringify(settings, null, 2)}\n`,
  };
}

export interface PiLauncherDeps {
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  home: string;
  readFile(filePath: string): string | null;
  writeFile(filePath: string, content: string, mode: number): void;
  mkdirp(dirPath: string, mode: number): void;
  rmrf(target: string): void;
  resolvePi(): string | null;
  piVersion(bin: string): string | null;
  /** Falls back to pi's own credential resolution (`pi auth print-api-key`). */
  piAuthKey(bin: string, provider: string): string | null;
  runChild(bin: string, args: readonly string[], env: Record<string, string>, cwd: string): Promise<number>;
  startProxy(options: PiProxyOptions): Promise<PiProxy>;
  loadGuardConfig(configPath: string | undefined, cwd: string): GuardConfig;
  extensionPath(): string;
  dataDir(): string;
  log(line: string): void;
  randomId(): string;
}

function childEnv(
  deps: PiLauncherDeps,
  agentDir: string,
  sessionDir: string,
  proxy: PiProxy,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(deps.env)) {
    if (value === undefined) continue;
    if ((CHILD_SCRUBBED_ENV as readonly string[]).includes(name)) continue;
    env[name] = value;
  }
  env.PI_CODING_AGENT_DIR = agentDir;
  env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  env[PI_EXTENSION_ENV_URL] = proxy.url;
  env[PI_EXTENSION_ENV_TOKEN] = proxy.token;
  return env;
}

/** Adds this package's extension to the user's pi settings. Idempotent. */
export function installPiExtension(
  deps: { readFile: PiLauncherDeps["readFile"]; writeFile: PiLauncherDeps["writeFile"]; mkdirp: PiLauncherDeps["mkdirp"]; extensionPath: PiLauncherDeps["extensionPath"] },
  agentDir: string,
): { ok: true; settingsPath: string; changed: boolean } | { ok: false; reason: string } {
  const settingsPath = path.join(agentDir, "settings.json");
  const raw = deps.readFile(settingsPath);
  let value: Record<string, unknown> = {};
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, reason: `${settingsPath} is not a JSON object` };
      }
      value = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, reason: `${settingsPath} is not valid JSON` };
    }
  }
  const extensionPath = deps.extensionPath();
  const extensions = value.extensions;
  if (extensions !== undefined && !Array.isArray(extensions)) {
    return { ok: false, reason: `${settingsPath}.extensions is not an array` };
  }
  const list = (extensions ?? []) as unknown[];
  // A relative entry in pi's settings resolves from the settings file.
  const normalized = (entry: string): string =>
    path.isAbsolute(entry) ? path.normalize(entry) : path.resolve(path.dirname(settingsPath), entry);
  if (list.some((entry) => typeof entry === "string" && normalized(entry) === normalized(extensionPath))) {
    return { ok: true, settingsPath, changed: false };
  }
  value.extensions = [...list, extensionPath];
  deps.mkdirp(agentDir, 0o700);
  deps.writeFile(settingsPath, `${JSON.stringify(value, null, 2)}\n`, 0o600);
  return { ok: true, settingsPath, changed: true };
}

export async function runPiLauncher(args: readonly string[], deps: PiLauncherDeps): Promise<number> {
  const { launcher, error } = parseLauncherArgs(args);
  if (error !== undefined) {
    deps.log(`leakshield: ${error}`);
    return 2;
  }
  const bin = deps.resolvePi();
  if (bin === null) {
    deps.log("leakshield: the pi CLI was not found on PATH; install @earendil-works/pi-coding-agent first");
    return 1;
  }
  if (parsePiVersion(deps.piVersion(bin)) === null) {
    deps.log(`leakshield: unsupported pi version (need >= 1.${MINIMUM_PI_MINOR} < 2); run \`pi --version\``);
    return 1;
  }

  const agentDir = deps.env.PI_CODING_AGENT_DIR ?? path.join(deps.home, ".pi", "agent");
  let agent;
  try {
    agent = loadPiUserAgent(agentDir, deps.readFile);
  } catch (loadError) {
    deps.log(`leakshield: ${loadError instanceof Error ? loadError.message : String(loadError)}`);
    return 1;
  }

  let resolution: PiProviderResolution;
  try {
    resolution = resolvePiProvider({
      agent,
      env: deps.env,
      provider: launcher.provider,
      model: launcher.model,
      upstreamOverride: launcher.upstream,
      apiOverride: launcher.api,
    });
  } catch (resolutionError) {
    deps.log(`leakshield: ${resolutionError instanceof Error ? resolutionError.message : String(resolutionError)}`);
    return 1;
  }

  let config: GuardConfig;
  try {
    config = deps.loadGuardConfig(launcher.configPath, deps.cwd);
  } catch (configError) {
    deps.log(
      `leakshield: could not load the guard config: ${configError instanceof Error ? configError.message : String(configError)}`,
    );
    return 1;
  }

  const apiKey = resolution.upstream.apiKey ?? deps.piAuthKey(bin, resolution.provider) ?? undefined;
  if (apiKey === undefined) {
    deps.log(
      `leakshield: no credential for pi provider "${resolution.provider}"; export its API key or run \`pi auth login ${resolution.provider}\``,
    );
    return 1;
  }

  const sessionDir = resolveSessionDir(agent, deps.env, deps.cwd);
  let proxy: PiProxy;
  try {
    proxy = await deps.startProxy({
      config,
      upstream: {
        baseUrl: resolution.upstream.baseUrl,
        api: resolution.upstream.api,
        apiKey,
        headers: resolution.upstream.headers,
      },
      models: resolution.models,
      port: launcher.controlPort,
      persistence: launcher.persist
        ? {
            ttlDays: launcher.persistTtlDays,
            path: launcher.persistPath ?? defaultStorePath(),
            keyFile: launcher.persistKeyfile,
          }
        : undefined,
    });
  } catch (proxyError) {
    deps.log(
      `leakshield: could not start the pi proxy: ${proxyError instanceof Error ? proxyError.message : String(proxyError)}`,
    );
    return 1;
  }

  const runDir = path.join(deps.dataDir(), "pi", `run-${deps.randomId()}`);
  const managedAgentDir = path.join(runDir, "agent");
  try {
    const files = buildManagedFiles(resolution, {
      proxyUrl: proxy.url,
      sessionDir,
      extensionPath: deps.extensionPath(),
    });
    deps.mkdirp(managedAgentDir, 0o700);
    deps.writeFile(path.join(managedAgentDir, "models.json"), files.modelsJson, 0o600);
    deps.writeFile(path.join(managedAgentDir, "settings.json"), files.settingsJson, 0o600);

    // Ambient discovery stays off: an unlisted extension or project package
    // could open its own connection and bypass the boundary. The explicit -e
    // path is still loaded, and these flags go last so they win over user args.
    // pi requires --model whenever --provider is given; without a model the
    // generated settings.json defaultProvider is the selection instead.
    const piArgs = [
      ...launcher.piArgs,
      ...(resolution.model !== undefined ? ["--provider", resolution.provider, "--model", resolution.model] : []),
      "--no-extensions",
      "--extension",
      deps.extensionPath(),
      "--no-approve",
    ];
    return await deps.runChild(bin, piArgs, childEnv(deps, managedAgentDir, sessionDir, proxy), deps.cwd);
  } finally {
    await proxy.close();
    deps.rmrf(runDir);
  }
}
