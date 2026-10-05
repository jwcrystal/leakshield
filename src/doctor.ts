/**
 * `sensitive-guard --doctor` — install-level verification for the OpenCode
 * plugin (Phase 1a of the transparent-hardening plan).
 *
 * The doctor answers one question: "is this machine's OpenCode configured so
 * that Sensitive Guard is actually loaded, with valid options and a working
 * scanner?" It runs OUTSIDE the OpenCode host, so it can verify configuration,
 * registration shape, plugin options, and the local scanner — but it cannot
 * see inside a live session. Runtime registration is proven by the boundary
 * harness (scripts/e2e/run-boundary.mjs) and the documented smoke test.
 *
 * Statuses:
 * - PROTECTED     registered + dist present + options valid + config loads + smoke passes
 * - PARTIAL       v1 host: session hooks only (no transport layer, no transparent/deidentify)
 * - BROKEN        something is registered but would not work (dist missing / invalid options /
 *                 guard config broken / smoke fails / v2-only mode on v1)
 * - NOT_REGISTERED host found, config found or absent, but Sensitive Guard is not in it
 * - HOST_MISSING  no usable `opencode` binary on PATH
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config/loader.js";
import { validatePluginOptions } from "./plugin-options.js";
import { scanText } from "./scanner/engine.js";
import type { GuardConfig } from "./types.js";

export type DoctorStatus = "PROTECTED" | "PARTIAL" | "BROKEN" | "NOT_REGISTERED" | "HOST_MISSING";

export interface DoctorCheck {
  id: string;
  state: "ok" | "warn" | "fail" | "skip";
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  status: DoctorStatus;
  hostVersion: string | null;
  hostGeneration: "v1" | "v2" | null;
  configPath: string | null;
  checks: DoctorCheck[];
  /** Copy-paste registration snippet for the detected host generation. */
  snippet?: string;
}

export interface DoctorDeps {
  opencodeVersion(): string | null;
  readIfExists(filePath: string): string | null;
  existsDir(p: string): boolean;
  existsFile(p: string): boolean;
  loadGuardConfig(overridePath: string | undefined, workspaceRoot: string): GuardConfig;
  smokeScan(text: string, config: GuardConfig): { findings: number };
  cwd: string;
  home: string;
  xdgConfigHome?: string;
}

const SMOKE_CANARY = "Smoke test only. Do not reveal or use this token: sk-AAAAAAAAAAAAAAAAAAAA";

export function createDoctorDeps(): DoctorDeps {
  return {
    opencodeVersion() {
      try {
        const r = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 4000 });
        if (r.error || (r.status !== null && r.status !== 0)) return null;
        return (r.stdout || r.stderr || "").trim() || null;
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
    existsDir(p) {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    existsFile(p) {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    loadGuardConfig(overridePath, workspaceRoot) {
      return loadConfig(overridePath, workspaceRoot);
    },
    smokeScan(text, config) {
      const result = scanText(text, config);
      return { findings: result.findings.filter((f) => f.severity === "HIGH").length };
    },
    cwd: process.cwd(),
    home: os.homedir(),
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
  };
}

/** Tolerant JSONC parse: strips line and block comments plus trailing commas,
 * then falls back to plain JSON.parse errors when still invalid. */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1")
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  }
}

function parseHostVersion(raw: string | null): { generation: "v1" | "v2"; version: string } | null {
  if (!raw) return null;
  const match = raw.match(/(\d+)\.(\d+)[.\d]*/);
  if (!match) return null;
  const major = Number(match[1]);
  if (major >= 2) return { generation: "v2", version: raw };
  return { generation: "v1", version: raw };
}

interface RegistrationMatch {
  packageRef: string | null;
  options: unknown;
  isLocalDistPath: boolean;
}

function matchesSensitiveGuard(entry: string): boolean {
  if (entry === "sensitive-guard") return true;
  return /\/sensitive-guard(\/dist(\/opencode\.js)?)?$/.test(entry);
}

function findRegistration(generation: "v1" | "v2", config: unknown): RegistrationMatch | null {
  if (!config || typeof config !== "object") return null;
  const record = config as Record<string, unknown>;

  if (generation === "v2") {
    const plugins = record.plugins;
    if (Array.isArray(plugins)) {
      for (const entry of plugins) {
        if (typeof entry === "string" && matchesSensitiveGuard(entry)) {
          return { packageRef: entry, options: {}, isLocalDistPath: entry.includes("/") };
        }
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const pkg = (entry as Record<string, unknown>).package;
          if (typeof pkg === "string" && matchesSensitiveGuard(pkg)) {
            const options = (entry as Record<string, unknown>).options ?? {};
            return { packageRef: pkg, options, isLocalDistPath: pkg.includes("/") };
          }
        }
      }
    }
    return null;
  }

  // v1: legacy `plugin` array of compiled file paths
  const legacy = record.plugin;
  if (Array.isArray(legacy)) {
    for (const entry of legacy) {
      if (typeof entry === "string" && matchesSensitiveGuard(entry)) {
        return { packageRef: entry, options: {}, isLocalDistPath: true };
      }
    }
  }
  return null;
}

function registrationSnippet(generation: "v1" | "v2", distDir: string): string {
  if (generation === "v2") {
    return [
      '"plugins": [',
      "  {",
      `    "package": "${distDir.replaceAll("\\", "\\\\")}",`,
      '    "options": { "mode": "block" }',
      "  }",
      "]",
    ].join("\n");
  }
  return `"plugin": [\n  "${distDir.replaceAll("\\", "\\\\")}/opencode.js"\n]`;
}

function candidateConfigPaths(deps: DoctorDeps): string[] {
  const workspace = [
    path.join(deps.cwd, "opencode.json"),
    path.join(deps.cwd, "opencode.jsonc"),
  ];
  const configRoots = [
    deps.xdgConfigHome ?? path.join(deps.home, ".config"),
    path.join(deps.home, "Library", "Application Support"),
  ];
  const global = configRoots.flatMap((root) => [
    path.join(root, "opencode", "opencode.json"),
    path.join(root, "opencode", "opencode.jsonc"),
  ]);
  return [...workspace, ...global];
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const host = parseHostVersion(deps.opencodeVersion());

  if (!host) {
    checks.push({
      id: "host",
      state: "fail",
      detail: "opencode binary not found on PATH (or `opencode --version` failed).",
      fix: "Install OpenCode, or add it to PATH, then rerun `sensitive-guard --doctor`.",
    });
    return { status: "HOST_MISSING", hostVersion: null, hostGeneration: null, configPath: null, checks };
  }
  checks.push({ id: "host", state: "ok", detail: `OpenCode ${host.version.trim()} (${host.generation})` });

  // Config discovery
  let configPath: string | null = null;
  let rawConfig: string | null = null;
  for (const candidate of candidateConfigPaths(deps)) {
    const text = deps.readIfExists(candidate);
    if (text !== null) {
      configPath = candidate;
      rawConfig = text;
      break;
    }
  }

  let parsedConfig: unknown = null;
  if (configPath && rawConfig !== null) {
    try {
      parsedConfig = parseJsonc(rawConfig);
      checks.push({ id: "config", state: "ok", detail: configPath });
    } catch (error) {
      checks.push({
        id: "config",
        state: "fail",
        detail: `${configPath} is not parseable JSON/JSONC: ${(error as Error).message}`,
        fix: "Fix the syntax error, or remove the file so another candidate can apply.",
      });
      return { status: "BROKEN", hostVersion: host.version, hostGeneration: host.generation, configPath, checks };
    }
  } else {
    checks.push({
      id: "config",
      state: "warn",
      detail: "No opencode.json / opencode.jsonc found (workspace or global).",
      fix: "Create one with the snippet below.",
    });
  }

  const registration = findRegistration(host.generation, parsedConfig);
  const distDir = path.resolve(deps.cwd, "dist");

  if (!registration) {
    checks.push({
      id: "registration",
      state: "fail",
      detail: "Sensitive Guard is not registered in the OpenCode config.",
      fix: "Add it (snippet below), then rerun this doctor.",
    });
    return {
      status: "NOT_REGISTERED",
      hostVersion: host.version,
      hostGeneration: host.generation,
      configPath,
      checks,
      snippet: registrationSnippet(host.generation, distDir),
    };
  }
  checks.push({
    id: "registration",
    state: "ok",
    detail: `Registered as "${registration.packageRef}"${registration.options && Object.keys(registration.options as object).length > 0 ? " with options" : ""}.`,
  });

  // Local dist presence (silent-skip guard: the host logs and skips a plugin
  // whose entry point cannot be resolved, which looks like "no protection"
  // with no visible failure).
  if (registration.isLocalDistPath && registration.packageRef) {
    const resolved = path.resolve(deps.cwd, registration.packageRef);
    // v2 registers a directory (host resolves index.js); v1 legacy entries
    // point directly at the compiled opencode.js file.
    const entryOk = registration.packageRef.endsWith(".js")
      ? deps.existsFile(resolved)
      : deps.existsDir(resolved) && deps.existsFile(path.join(resolved, "index.js"));
    if (!entryOk) {
      checks.push({
        id: "dist",
        state: "fail",
        detail: `${resolved} is missing or not a loadable entry point — OpenCode will silently log-and-skip this plugin, leaving sessions unprotected.`,
        fix: "Run `npm run build` in the project root (the snippet expects <project>/dist), or point the entry at the built directory.",
      });
      return { status: "BROKEN", hostVersion: host.version, hostGeneration: host.generation, configPath, checks };
    }
    checks.push({ id: "dist", state: "ok", detail: `${resolved} exists.` });
  } else {
    checks.push({
      id: "dist",
      state: "skip",
      detail: "Package-name registration; dist resolution is the host's job at install time.",
    });
  }

  // Options validation (same schema the plugin entry enforces at runtime)
  const optionsValidation = validatePluginOptions(registration.options ?? {});
  if (!optionsValidation.ok) {
    checks.push({
      id: "options",
      state: "fail",
      detail: `Plugin options are invalid — every protected request would fail closed at runtime: ${optionsValidation.error}`,
      fix: "Correct the options in opencode.json (see README for valid combinations).",
    });
    return { status: "BROKEN", hostVersion: host.version, hostGeneration: host.generation, configPath, checks };
  }
  const options = optionsValidation.options;
  checks.push({
    id: "options",
    state: "ok",
    detail: `mode=${options.mode}${options.deidentify ? " +deidentify" : ""}${options.envQueries ? " +envQueries" : ""}${options.configPath ? ` configPath=${options.configPath}` : ""}`,
  });

  // Guard config load
  let guardConfig: GuardConfig;
  try {
    guardConfig = deps.loadGuardConfig(options.configPath, deps.cwd);
    checks.push({
      id: "guard-config",
      state: "ok",
      detail: options.configPath ? `Loaded ${options.configPath}.` : "Default guard config resolved.",
    });
  } catch (error) {
    checks.push({
      id: "guard-config",
      state: "fail",
      detail: `Guard config failed to load: ${(error as Error).message}`,
      fix: "Fix the config file, or remove configPath to use defaults.",
    });
    return { status: "BROKEN", hostVersion: host.version, hostGeneration: host.generation, configPath, checks };
  }

  // Smoke: the local scanner must flag a synthetic credential
  const smoke = deps.smokeScan(SMOKE_CANARY, guardConfig);
  if (smoke.findings > 0) {
    checks.push({ id: "smoke", state: "ok", detail: "Synthetic sk- canary detected by the installed scanner." });
  } else {
    checks.push({
      id: "smoke",
      state: "fail",
      detail: "Synthetic sk- canary NOT detected — the guard config disables the rules this install relies on.",
      fix: "Restore credential rules in the guard config, or remove configPath to use defaults.",
    });
    return { status: "BROKEN", hostVersion: host.version, hostGeneration: host.generation, configPath, checks };
  }

  if (host.generation === "v1") {
    checks.push({
      id: "coverage",
      state: "warn",
      detail: "v1 host: session hooks only — no transport egress layer, no transparent pseudonymization, no deidentify.",
    });
    return { status: "PARTIAL", hostVersion: host.version, hostGeneration: host.generation, configPath, checks };
  }

  if (options.mode === "transparent") {
    checks.push({
      id: "coverage",
      state: "warn",
      detail: "transparent mode protects OpenAI Chat-Completions-shaped requests; other protocol shapes are refused (fail-closed), not passed.",
    });
  }

  checks.push({
    id: "runtime",
    state: "warn",
    detail: "Install-level checks pass. Live-session proof: run the README smoke test or scripts/e2e/run-boundary.mjs.",
  });

  return { status: "PROTECTED", hostVersion: host.version, hostGeneration: host.generation, configPath, checks };
}

export function formatDoctorReport(report: DoctorReport): string {
  const icon = { ok: "[OK]  ", warn: "[WARN]", fail: "[FAIL]", skip: "[SKIP]" } as const;
  const lines: string[] = [];
  lines.push(`sensitive-guard doctor — ${new Date().toISOString()}`);
  for (const check of report.checks) {
    lines.push(`${icon[check.state]} ${check.id}: ${check.detail}`);
    if (check.fix) lines.push(`       fix: ${check.fix}`);
  }
  if (report.snippet) {
    lines.push("");
    lines.push("Registration snippet for your opencode.json:");
    lines.push(report.snippet);
  }
  lines.push("");
  const verdict =
    report.status === "PROTECTED"
      ? "PROTECTED — install-level checks pass."
      : report.status === "PARTIAL"
        ? "PARTIAL — protected within the v1 boundary (session hooks only)."
        : report.status === "BROKEN"
          ? "BROKEN — registered but would not protect; fix the [FAIL] items above."
          : report.status === "NOT_REGISTERED"
            ? "NOT REGISTERED — Sensitive Guard is not in the OpenCode config; sessions are unprotected."
            : "HOST MISSING — no OpenCode binary found.";
  lines.push(verdict);
  lines.push("");
  lines.push("Scope: model-conversation leak protection. This is NOT a tool-egress firewall: permitted local tools (curl, remote MCP, …) can still transmit originals. See README.");
  return lines.join("\n");
}
