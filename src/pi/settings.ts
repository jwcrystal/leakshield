/**
 * pi user settings as inputs to the extension and the doctor.
 *
 * The extension protects the process it runs in; it never rewrites pi's agent
 * directory. This module only reads that configuration to answer what the
 * doctor needs: which provider and model are selected, which wire API they
 * use, and where the extension has to be registered.
 */
import path from "node:path";

interface PiModelEntry {
  id?: string;
  api?: string;
  baseUrl?: string;
  name?: string;
  [key: string]: unknown;
}

interface PiProviderEntry {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models?: PiModelEntry[];
  [key: string]: unknown;
}

interface PiUserSettings {
  defaultModel?: string;
  defaultProvider?: string;
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

export const SUPPORTED_PI_APIS: ReadonlySet<string> = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
]);

export type PiApi = "openai-completions" | "openai-responses" | "anthropic-messages";

export function isSupportedPiApi(value: string): value is PiApi {
  return SUPPORTED_PI_APIS.has(value);
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

/** pi's default agent directory for a home path. */
export function defaultPiAgentDir(home: string): string {
  return path.join(home, ".pi", "agent");
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
    const model = stringField(settingsValue, "defaultModel", "pi settings.json");
    const defaultProvider = stringField(settingsValue, "defaultProvider", "pi settings.json");
    const sessionDir = stringField(settingsValue, "sessionDir", "pi settings.json");
    if (model !== undefined) settings.defaultModel = model;
    if (defaultProvider !== undefined) settings.defaultProvider = defaultProvider;
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

export interface PiSelectedModel {
  provider: string;
  model?: string;
  api?: string;
  baseUrl?: string;
}

/**
 * The provider/model pi would start with. `defaultModel` may name a model id
 * or provider/id; a model entry's `api` overrides the provider's.
 */
export function resolvePiSelectedModel(agent: PiUserAgent, env: Readonly<Record<string, string | undefined>>): PiSelectedModel | null {
  const configured = env.PI_PROVIDER ?? agent.settings.defaultProvider;
  let model = agent.settings.defaultModel;
  let provider = configured;
  if (model !== undefined && model.includes("/")) {
    const slash = model.indexOf("/");
    provider = provider ?? model.slice(0, slash);
    model = model.slice(slash + 1);
  }
  if (provider === undefined || provider.length === 0) return null;
  const entry = agent.providers[provider];
  if (entry === undefined) return { provider, model };
  const declared = entry.models?.find((candidate) => candidate.id === model);
  return {
    provider,
    model,
    api: declared?.api ?? entry.api,
    baseUrl: declared?.baseUrl ?? entry.baseUrl,
  };
}

/** Resolves an extension entry against the working directory, the agent directory and as given. */
export function resolveExtensionEntry(entry: string, cwd: string, agentDir: string): string[] {
  const candidates = [path.resolve(cwd, entry), path.resolve(agentDir, entry), entry];
  return [...new Set(candidates)];
}
