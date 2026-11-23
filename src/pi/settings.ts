/**
 * pi user settings as inputs to the managed launcher.
 *
 * The launcher reads the user's agent directory (settings.json and
 * models.json) to learn which provider and model they intend to use. It never
 * reuses that directory as the child's config directory: the child gets a
 * generated directory whose only provider is the loopback boundary, so an
 * ambient provider entry or extension cannot route around it.
 */
import path from "node:path";
import type { PiApi } from "./proxy.js";

export interface PiModelEntry {
  id?: string;
  api?: string;
  baseUrl?: string;
  name?: string;
  [key: string]: unknown;
}

export interface PiProviderEntry {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models?: PiModelEntry[];
  [key: string]: unknown;
}

export interface PiUserSettings {
  defaultProvider?: string;
  defaultModel?: string;
  sessionDir?: string;
  extensions?: unknown[];
  packages?: unknown[];
  [key: string]: unknown;
}

export interface PiUserAgent {
  agentDir: string;
  settings: PiUserSettings;
  providers: Record<string, PiProviderEntry>;
}

export interface PiUpstreamDefaults {
  baseUrl: string;
  api: PiApi;
  env: readonly string[];
}

/**
 * pi 1.6.0 catalog metadata for providers whose wire protocol this adapter
 * speaks. Providers missing here need explicit `--upstream` and `--api`.
 */
export const PI_BUILTIN_PROVIDERS: Readonly<Record<string, PiUpstreamDefaults>> = {
  anthropic: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages", env: ["ANTHROPIC_API_KEY"] },
  openai: { baseUrl: "https://api.openai.com/v1", api: "openai-responses", env: ["OPENAI_API_KEY"] },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", env: ["OPENROUTER_API_KEY"] },
  groq: { baseUrl: "https://api.groq.com/openai/v1", api: "openai-completions", env: ["GROQ_API_KEY"] },
  deepseek: { baseUrl: "https://api.deepseek.com", api: "openai-completions", env: ["DEEPSEEK_API_KEY"] },
  together: { baseUrl: "https://api.together.ai/v1", api: "openai-completions", env: ["TOGETHER_API_KEY"] },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", api: "openai-completions", env: ["CEREBRAS_API_KEY"] },
  baseten: { baseUrl: "https://inference.baseten.co/v1", api: "openai-completions", env: ["BASETEN_API_KEY"] },
  nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1", api: "openai-completions", env: ["NVIDIA_API_KEY"] },
  xai: { baseUrl: "https://api.x.ai/v1", api: "openai-responses", env: ["XAI_API_KEY"] },
  moonshotai: { baseUrl: "https://api.moonshot.ai/v1", api: "openai-completions", env: ["MOONSHOT_API_KEY"] },
  "moonshotai-cn": { baseUrl: "https://api.moonshot.cn/v1", api: "openai-completions", env: ["MOONSHOT_API_KEY"] },
  minimax: { baseUrl: "https://api.minimax.io/anthropic", api: "anthropic-messages", env: ["MINIMAX_API_KEY"] },
  "minimax-cn": { baseUrl: "https://api.minimaxi.com/anthropic", api: "anthropic-messages", env: ["MINIMAX_CN_API_KEY"] },
  fireworks: { baseUrl: "https://api.fireworks.ai/inference", api: "anthropic-messages", env: ["FIREWORKS_API_KEY"] },
  zai: { baseUrl: "https://api.z.ai/api/coding/paas/v4", api: "openai-completions", env: ["ZAI_API_KEY"] },
};

const SUPPORTED_APIS: ReadonlySet<string> = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
]);

/** pi accepts `provider/model` and an optional `:thinking` suffix. */
export function providerFromModel(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0) return undefined;
  return model.slice(0, slash);
}

export function isSupportedPiApi(value: string): value is PiApi {
  return SUPPORTED_APIS.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonFile(raw: string | null, label: string): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function stringField(record: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}.${key} must be a non-empty string`);
  return value;
}

/** Reads the user's pi agent configuration. Throws on malformed JSON. */
export function loadPiUserAgent(
  agentDir: string,
  readFile: (filePath: string) => string | null,
): PiUserAgent {
  const settingsRaw = readFile(path.join(agentDir, "settings.json"));
  const settingsValue = parseJsonFile(settingsRaw, "pi settings.json");
  if (settingsValue !== undefined && !isRecord(settingsValue)) throw new Error("pi settings.json must be a JSON object");
  const settings: PiUserSettings = {};
  if (settingsValue !== undefined) {
    const provider = stringField(settingsValue, "defaultProvider", "pi settings.json");
    const model = stringField(settingsValue, "defaultModel", "pi settings.json");
    const sessionDir = stringField(settingsValue, "sessionDir", "pi settings.json");
    if (provider !== undefined) settings.defaultProvider = provider;
    if (model !== undefined) settings.defaultModel = model;
    if (sessionDir !== undefined) settings.sessionDir = sessionDir;
    if (settingsValue.extensions !== undefined) {
      if (!Array.isArray(settingsValue.extensions)) throw new Error("pi settings.json.extensions must be an array");
      settings.extensions = settingsValue.extensions;
    }
    if (settingsValue.packages !== undefined) {
      if (!Array.isArray(settingsValue.packages)) throw new Error("pi settings.json.packages must be an array");
      settings.packages = settingsValue.packages;
    }
  }

  const modelsRaw = readFile(path.join(agentDir, "models.json"));
  const modelsValue = parseJsonFile(modelsRaw, "pi models.json");
  if (modelsValue !== undefined && !isRecord(modelsValue)) throw new Error("pi models.json must be a JSON object");
  const providers: Record<string, PiProviderEntry> = {};
  if (modelsValue !== undefined && modelsValue.providers !== undefined) {
    if (!isRecord(modelsValue.providers)) throw new Error("pi models.json.providers must be an object");
    for (const [id, entry] of Object.entries(modelsValue.providers)) {
      if (!isRecord(entry)) throw new Error(`pi models.json.providers.${id} must be an object`);
      if (entry.models !== undefined && !Array.isArray(entry.models)) {
        throw new Error(`pi models.json.providers.${id}.models must be an array`);
      }
      if (entry.headers !== undefined) {
        if (!isRecord(entry.headers) || Object.values(entry.headers).some((value) => typeof value !== "string")) {
          throw new Error(`pi models.json.providers.${id}.headers must be a string map`);
        }
      }
      providers[id] = entry as PiProviderEntry;
    }
  }
  return { agentDir, settings, providers };
}

/** Resolves pi's `apiKey` syntax: literal, `$NAME`, or `!command` (refused). */
export function resolveApiKeySpec(
  spec: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (spec === undefined) return undefined;
  if (spec.startsWith("!")) {
    throw new Error("pi models.json apiKey commands are not run by the LeakShield launcher; use a literal or $ENV value");
  }
  if (spec.startsWith("$")) {
    const value = env[spec.slice(1)];
    return value !== undefined && value.length > 0 ? value : undefined;
  }
  return spec.length > 0 ? spec : undefined;
}

export interface PiProviderResolution {
  provider: string;
  upstream: { baseUrl: string; api: PiApi; apiKey?: string; headers?: Record<string, string> };
  /** Model ids pi may request, when the provider entry declares them. */
  models: string[];
  /** Safe metadata for the declared models, copied without baseUrl or credentials. */
  modelEntries: PiModelEntry[];
  /** Forwards the user's model selection, including its `:thinking` suffix. */
  model?: string;
}

export interface PiProviderResolutionInput {
  agent: PiUserAgent;
  env: Readonly<Record<string, string | undefined>>;
  provider?: string;
  model?: string;
  upstreamOverride?: string;
  apiOverride?: string;
}

function declaredModels(entry: PiProviderEntry | undefined): PiModelEntry[] {
  if (entry?.models === undefined) return [];
  const models: PiModelEntry[] = [];
  for (const model of entry.models) {
    if (isRecord(model) && typeof model.id === "string" && model.id.length > 0) models.push(model);
  }
  return models;
}

export function resolvePiProvider(input: PiProviderResolutionInput): PiProviderResolution {
  const { agent, env } = input;
  const model = input.model ?? agent.settings.defaultModel;
  const provider =
    input.provider ?? agent.settings.defaultProvider ?? providerFromModel(model);
  if (provider === undefined || provider.length === 0) {
    throw new Error(
      "no pi provider selected; pass --provider (or set defaultProvider in pi's settings.json)",
    );
  }
  const entry = agent.providers[provider];
  const builtin = PI_BUILTIN_PROVIDERS[provider];

  const baseUrl = input.upstreamOverride ?? entry?.baseUrl ?? builtin?.baseUrl;
  if (baseUrl === undefined) {
    throw new Error(`pi provider "${provider}" has no known upstream; pass --upstream <url> and --api <api>`);
  }
  const api = input.apiOverride ?? entry?.api ?? builtin?.api;
  if (api === undefined) {
    throw new Error(`pi provider "${provider}" declares no api; pass --api (openai-completions, openai-responses, anthropic-messages)`);
  }
  if (!isSupportedPiApi(api)) {
    throw new Error(
      `pi provider "${provider}" uses api "${api}", which this LeakShield adapter does not speak; use a supported provider or --api`,
    );
  }

  let apiKey = resolveApiKeySpec(entry?.apiKey, env);
  if (apiKey === undefined) {
    for (const name of builtin?.env ?? []) {
      const value = env[name];
      if (value !== undefined && value.length > 0) {
        apiKey = value;
        break;
      }
    }
  }

  const headers: Record<string, string> = {};
  for (const [name, spec] of Object.entries(entry?.headers ?? {})) {
    const value = resolveApiKeySpec(spec, env);
    if (value !== undefined) headers[name] = value;
  }

  return {
    provider,
    upstream: { baseUrl, api, apiKey, headers: Object.keys(headers).length > 0 ? headers : undefined },
    models: declaredModels(entry).map((model) => model.id as string),
    modelEntries: declaredModels(entry),
    model,
  };
}

/** Session storage stays with the user so `--continue` and `--session` keep working. */
export function resolveSessionDir(
  agent: PiUserAgent,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): string {
  const override = env.PI_CODING_AGENT_SESSION_DIR;
  if (override !== undefined && override.length > 0) return path.resolve(cwd, override);
  if (agent.settings.sessionDir !== undefined) return path.resolve(cwd, agent.settings.sessionDir);
  return path.join(agent.agentDir, "sessions");
}
