import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DoctorCheck } from "../doctor.js";
import { DEFAULT_PROXY_HOST, DEFAULT_PROXY_PORT, HEALTH_PATH, HEALTH_SERVICE } from "./proxy.js";

export type ProxyProbe = { ok: true; upstream: string | null } | { ok: false; reason: "unreachable" | "not-leakshield" };

export interface ClaudeCodeDoctorDeps {
  claudeVersion(): string | null;
  readIfExists(filePath: string): string | null;
  probeProxy(baseUrl: string): Promise<ProxyProbe>;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  home: string;
}

const PROXY_URL = `http://${DEFAULT_PROXY_HOST}:${DEFAULT_PROXY_PORT}`;
const ALTERNATE_PROVIDERS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];

export function createClaudeCodeDoctorDeps(): ClaudeCodeDoctorDeps {
  return {
    claudeVersion() {
      try {
        const r = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 4000 });
        if (r.error || (r.status !== null && r.status !== 0)) return null;
        return (r.stdout || "").trim() || null;
      } catch {
        return null;
      }
    },
    readIfExists(filePath) {
      try {
        return fs.readFileSync(filePath, "utf8");
      } catch {
        return null;
      }
    },
    async probeProxy(baseUrl) {
      try {
        const response = await fetch(new URL(HEALTH_PATH, baseUrl), { signal: AbortSignal.timeout(2000) });
        const body: unknown = await response.json().catch(() => null);
        if (response.ok && typeof body === "object" && body !== null && (body as { service?: unknown }).service === HEALTH_SERVICE) {
          const upstream = (body as { upstream?: unknown }).upstream;
          return { ok: true, upstream: typeof upstream === "string" ? upstream : null };
        }
        return { ok: false, reason: "not-leakshield" };
      } catch {
        return { ok: false, reason: "unreachable" };
      }
    },
    env: process.env,
    cwd: process.cwd(),
    home: os.homedir(),
  };
}

interface EnvSource {
  label: string;
  env: Record<string, unknown>;
}

/**
 * Claude Code applies settings `env` over the shell, and among settings files
 * the more specific one wins: project local, then project, then user.
 * Returned highest precedence first.
 */
function envSources(deps: ClaudeCodeDoctorDeps): { sources: EnvSource[]; broken: string[] } {
  const configDir = deps.env.CLAUDE_CONFIG_DIR || path.join(deps.home, ".claude");
  const files = [
    path.join(deps.cwd, ".claude", "settings.local.json"),
    path.join(deps.cwd, ".claude", "settings.json"),
    path.join(configDir, "settings.json"),
  ];
  const sources: EnvSource[] = [];
  const broken: string[] = [];
  for (const file of files) {
    const raw = deps.readIfExists(file);
    if (raw === null) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      const env = typeof parsed === "object" && parsed !== null ? (parsed as { env?: unknown }).env : undefined;
      if (typeof env === "object" && env !== null && !Array.isArray(env)) {
        sources.push({ label: file, env: env as Record<string, unknown> });
      }
    } catch {
      broken.push(file);
    }
  }
  sources.push({ label: "shell environment of this doctor run", env: { ...deps.env } });
  return { sources, broken };
}

function effective(sources: EnvSource[], key: string): { value: string; source: string } | null {
  for (const source of sources) {
    const value = source.env[key];
    if (typeof value === "string" && value.length > 0) return { value, source: source.label };
  }
  return null;
}

function isLoopbackUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  } catch {
    return false;
  }
}

/** Claude Code checks, independent of the OpenCode checks and their status. */
export async function runClaudeCodeDoctor(deps: ClaudeCodeDoctorDeps): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const version = deps.claudeVersion();
  if (version === null) {
    checks.push({ id: "claude-code", state: "skip", detail: "claude binary not found on PATH; Claude Code checks skipped." });
    return checks;
  }
  checks.push({ id: "claude-code", state: "ok", detail: version });

  const { sources, broken } = envSources(deps);
  for (const file of broken) {
    checks.push({
      id: "claude-code-settings",
      state: "warn",
      detail: `${file} is not valid JSON; its env block was not read.`,
      fix: "Fix the syntax, then rerun this doctor.",
    });
  }

  const provider = ALTERNATE_PROVIDERS.map((key) => effective(sources, key)).find((hit) => hit !== null && hit.value !== "0" && hit.value !== "false");
  if (provider) {
    checks.push({
      id: "claude-code-provider",
      state: "warn",
      detail: `A Bedrock/Vertex/Foundry provider is enabled (from ${provider.source}); those requests bypass ANTHROPIC_BASE_URL and the LeakShield proxy.`,
      fix: "Unset it to send Claude Code through the Anthropic API and the proxy.",
    });
  }

  if (deps.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST) {
    checks.push({
      id: "claude-code-host-managed",
      state: "warn",
      detail: "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST is set in this shell; Claude Code then ignores ANTHROPIC_BASE_URL from settings files, and the embedding app decides the endpoint.",
      fix: "Set ANTHROPIC_BASE_URL in the environment that launches Claude Code, or check the embedding app's provider settings.",
    });
  }

  const baseUrl = effective(sources, "ANTHROPIC_BASE_URL");
  if (baseUrl === null) {
    checks.push({
      id: "claude-code-proxy",
      state: "warn",
      detail: "ANTHROPIC_BASE_URL is not set, so Claude Code talks to Anthropic directly and is not protected.",
      fix: `Run \`leakshield --claude-code-proxy\`, then set ANTHROPIC_BASE_URL=${PROXY_URL} in your shell or in the "env" block of ~/.claude/settings.json.`,
    });
    return checks;
  }

  const probe = await deps.probeProxy(baseUrl.value);
  if (probe.ok) {
    checks.push({
      id: "claude-code-proxy",
      state: "ok",
      detail: `ANTHROPIC_BASE_URL=${baseUrl.value} (from ${baseUrl.source}) is the LeakShield proxy${probe.upstream ? `, forwarding to ${probe.upstream}` : ""}.`,
    });
  } else if (probe.reason === "unreachable" && isLoopbackUrl(baseUrl.value)) {
    checks.push({
      id: "claude-code-proxy",
      state: "fail",
      detail: `ANTHROPIC_BASE_URL=${baseUrl.value} (from ${baseUrl.source}) points at a local address where nothing answers; Claude Code requests will fail until the proxy runs.`,
      fix: "Start it with `leakshield --claude-code-proxy` (add `--port` if you changed the port).",
    });
  } else {
    checks.push({
      id: "claude-code-proxy",
      state: "warn",
      detail: `ANTHROPIC_BASE_URL=${baseUrl.value} (from ${baseUrl.source}) is not the LeakShield proxy, so Claude Code is not protected.`,
      fix: `Run \`leakshield --claude-code-proxy\` and set ANTHROPIC_BASE_URL=${PROXY_URL}.`,
    });
  }
  if (sources.length > 1 && baseUrl.source !== sources[sources.length - 1].label) {
    const shell = sources[sources.length - 1].env.ANTHROPIC_BASE_URL;
    if (typeof shell === "string" && shell.length > 0 && shell !== baseUrl.value) {
      checks.push({
        id: "claude-code-env",
        state: "warn",
        detail: `This shell sets ANTHROPIC_BASE_URL=${shell}, but ${baseUrl.source} overrides it inside Claude Code.`,
      });
    }
  }
  return checks;
}
