/**
 * `leakshield --doctor` — install-level verification for the OpenCode
 * plugin (Phase 1a of the transparent-hardening plan).
 *
 * The doctor answers one question: "is this machine's OpenCode configured so
 * that LeakShield is actually loaded, with valid options and a working
 * scanner?" It runs OUTSIDE the OpenCode host, so it can verify configuration,
 * registration shape, plugin options, and the local scanner — but it cannot
 * see inside a live session. Runtime registration is proven by the boundary
 * harness (scripts/e2e/run-boundary.mjs) and the documented smoke test.
 *
 * Statuses:
 * - PROTECTED     registered + dist present + options valid + config loads + smoke passes
 * - PARTIAL       transparent hook-only mode (wireProtection=false): no final-body inspection
 * - BROKEN        something is registered but would not work (dist missing / invalid options /
 *                 guard config broken / smoke fails), or the host is OpenCode v1, which is
 *                 no longer supported (the package only blocks its model requests)
 * - NOT_REGISTERED host found, config found or absent, but LeakShield is not in it
 * - HOST_MISSING  no usable `opencode` binary on PATH
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config/loader.js";
import { defaultKeyfilePath, defaultStorePath } from "./decision/mapping-key.js";
import { InMemoryMappingKeyProvider, openMappingStore } from "./decision/mapping-store.js";
import { validatePluginOptions, type PluginOptions } from "./plugin-options.js";
import { BUILTIN_RULE_IDS } from "./rules/builtin.js";
import { skippedCustomRules, customRuleBoundaries } from "./rules/dynamic.js";
import { allowlistSuppressions } from "./scanner/allowlist.js";
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
  /** Copy-paste registration snippet for the OpenCode v2 config. */
  snippet?: string;
}

export interface DoctorDeps {
  opencodeVersion(): string | null;
  readIfExists(filePath: string): string | null;
  existsDir(p: string): boolean;
  existsFile(p: string): boolean;
  /** W2/B5: optional store-health probe (session count only). Defaults to a
   * throwaway-key open — counting needs no decryption. */
  openStoreProbe?(storePath: string, ttlDays: number): { sessions: number } | { error: string };
  loadGuardConfig(overridePath: string | undefined, workspaceRoot: string): GuardConfig;
  smokeScan(text: string, config: GuardConfig): { findings: number };
  /** Severity-agnostic scan for the allowlist diagnostics. Defaults to the real
   * scanner; `smokeScan` is a HIGH-only credential probe and would call a
   * working MEDIUM/LOW allowlist entry dead. `exact` lists the findings whose
   * text is exactly this input, tagged so doctor can ignore diagnostics that an
   * allowlist cannot suppress (the Unicode/homograph warning is one). */
  probeScan?(
    text: string,
    config: GuardConfig,
  ): { findings: number; exact: { description: string | null; unicodeWarning: boolean }[] };
  cwd: string;
  home: string;
  xdgConfigHome?: string;
}

const SMOKE_CANARY = "Smoke test only. Do not reveal or use this token: sk-AAAAAAAAAAAAAAAAAAAA";

/**
 * Severity-agnostic probe for the allowlist diagnostics: every finding, plus
 * the ones whose matched text is exactly the input. Findings carrying
 * `unicode_detected` are tagged because an allowlist cannot suppress them.
 */
function defaultProbeScan(
  text: string,
  config: GuardConfig,
): { findings: number; exact: { description: string | null; unicodeWarning: boolean }[] } {
  const result = scanText(text, config);
  return {
    findings: result.findings.length,
    exact: result.findings
      .filter((finding) => finding.match_text === text)
      .map((finding) => ({
        description: finding.description ?? null,
        unicodeWarning: (finding as { unicode_detected?: unknown }).unicode_detected !== undefined,
      })),
  };
}

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
    probeScan(text, config) {
      return defaultProbeScan(text, config);
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

function matchesLeakshield(entry: string): boolean {
  if (entry === "leakshield") return true;
  return /\/leakshield(\/dist(\/opencode\.js)?)?$/.test(entry);
}

function registrationSnippet(distDir: string): string {
  return [
    '"plugins": [',
    "  {",
    `    "package": "${distDir.replaceAll("\\", "\\\\")}",`,
    '    "options": { "mode": "block" }',
    "  }",
    "]",
  ].join("\n");
}

/**
 * Config locations grouped by precedence, highest first.
 *
 * OpenCode applies `plugins` from the user config dir, the project root and
 * `.opencode/`, lowest precedence first (https://opencode.ai/v2/docs/plugins/#configure
 * lists exactly those three). The two global roots are alternatives rather
 * than two merged files: the docs name `~/.config/opencode` as the user config
 * directory, so `~/Library/Application Support/opencode` is only a fallback for
 * a host that keeps its user config there. Within a root, `.json` wins over
 * `.jsonc`.
 */
function configRootGroups(deps: DoctorDeps): string[][] {
  const dotOpencode = [
    path.join(deps.cwd, ".opencode", "opencode.json"),
    path.join(deps.cwd, ".opencode", "opencode.jsonc"),
  ];
  const workspace = [
    path.join(deps.cwd, "opencode.json"),
    path.join(deps.cwd, "opencode.jsonc"),
  ];
  const configRoots = [
    deps.xdgConfigHome ?? path.join(deps.home, ".config"),
    path.join(deps.home, "Library", "Application Support"),
  ];
  return [
    dotOpencode,
    workspace,
    ...configRoots.map((root) => [
      path.join(root, "opencode", "opencode.json"),
      path.join(root, "opencode", "opencode.jsonc"),
    ]),
  ];
}

interface ConfigSource {
  path: string;
  config: unknown;
}

function readConfigFile(deps: DoctorDeps, candidates: string[]): { path: string; text: string } | null {
  for (const candidate of candidates) {
    const text = deps.readIfExists(candidate);
    if (text !== null) return { path: candidate, text };
  }
  return null;
}

/**
 * Config files doctor reads, highest precedence first: `.opencode/`, the
 * workspace file, and the one active global root. A stale file in the inactive
 * fallback root is not read, so it cannot turn a working install into a failure.
 */
function loadConfigSources(deps: DoctorDeps): {
  sources: ConfigSource[];
  broken: { path: string; error: string } | null;
} {
  const [dotOpencodeGroup, workspaceGroup, ...globalGroups] = configRootGroups(deps);
  const chosen = [readConfigFile(deps, dotOpencodeGroup), readConfigFile(deps, workspaceGroup)];
  for (const group of globalGroups) {
    const file = readConfigFile(deps, group);
    if (!file) continue;
    chosen.push(file);
    break; // the global roots are alternatives, not additional files
  }

  const sources: ConfigSource[] = [];
  for (const file of chosen) {
    if (!file) continue;
    try {
      sources.push({ path: file.path, config: parseJsonc(file.text) });
    } catch (error) {
      return { sources, broken: { path: file.path, error: (error as Error).message } };
    }
  }
  return { sources, broken: null };
}

function pluginEntryId(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const pkg = (entry as Record<string, unknown>).package;
    return typeof pkg === "string" ? pkg : null;
  }
  return null;
}

interface AppliedPlugin {
  id: string;
  options: unknown;
  source: string;
}

/**
 * Apply every `plugins` array doctor can read, lowest precedence first, the way
 * the host does: entries accumulate across files instead of replacing one
 * another, `-id` / `-prefix.*` / `-*` remove an entry, and a later entry
 * re-enables it (https://opencode.ai/v2/docs/plugins/#configure, #control).
 */
function applyPluginLists(sourcesLowToHigh: ConfigSource[]): {
  registered: AppliedPlugin | null;
  disabled: { source: string; entry: string } | null;
} {
  const enabled = new Map<string, AppliedPlugin>();
  let disabled: { source: string; entry: string } | null = null;

  const removeWhere = (source: string, entry: string, matches: (id: string) => boolean): void => {
    let removed = false;
    for (const id of [...enabled.keys()]) {
      if (!matches(id)) continue;
      enabled.delete(id);
      if (matchesLeakshield(id)) removed = true;
    }
    if (removed) disabled = { source, entry };
  };

  for (const source of sourcesLowToHigh) {
    const config = source.config;
    if (!config || typeof config !== "object") continue;
    const list = (config as Record<string, unknown>).plugins;
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry === "string") {
        if (entry.startsWith("-")) {
          const pattern = entry.slice(1);
          const prefix = pattern.endsWith(".*") ? pattern.slice(0, -2) : null;
          removeWhere(source.path, entry, (id) =>
            pattern === "*"
              ? true
              : prefix !== null
                ? id === prefix || id.startsWith(`${prefix}.`)
                : id === pattern,
          );
          continue;
        }
        if (entry === "*") continue; // wildcard enable: nothing specific to add
        enabled.set(entry, { id: entry, options: {}, source: source.path });
        if (matchesLeakshield(entry)) disabled = null;
        continue;
      }
      const id = pluginEntryId(entry);
      if (!id) continue;
      const options = (entry as Record<string, unknown>).options ?? {};
      enabled.set(id, { id, options, source: source.path });
      if (matchesLeakshield(id)) disabled = null;
    }
  }

  let registered: AppliedPlugin | null = null;
  for (const applied of enabled.values()) {
    if (matchesLeakshield(applied.id)) registered = applied;
  }
  return { registered, disabled: registered ? null : disabled };
}


/**
 * W2 (B5) persistence status — a warn/ok/skip check, never a status flip:
 * a degraded store weakens nothing (the plugin degrades to memory-only);
 * the check exists so "enabled but silently not working" is visible here
 * instead of only as a setup-time console WARN (decision §4.6).
 */
export function persistenceCheck(
  options: PluginOptions,
  deps: DoctorDeps,
): DoctorCheck {
  const persistence = options.persistence;
  if (!persistence.enabled) {
    return {
      id: "persistence",
      state: "skip",
      detail: "OFF (default) — mappings are memory-only, per process lifetime.",
    };
  }
  const storePath = persistence.path ?? defaultStorePath();
  const keySource = persistence.keyFile
    ? `OS keychain first; keyfile fallback allowed (${persistence.keyfilePath ?? defaultKeyfilePath()})`
    : "OS keychain";
  const base = `CONFIGURED (not runtime-verified); store=${storePath} ttl=${persistence.ttlDays}d cleanup=on-store-open key=${keySource}`;
  if (!deps.existsFile(storePath)) {
    return {
      id: "persistence",
      state: "warn",
      detail: `${base}; store not created yet; activation and key availability are unverified.`,
      fix: "Check the running plugin's persistence active/memory-only log and test restart restoration with synthetic data.",
    };
  }
  const probe =
    deps.openStoreProbe?.(storePath, persistence.ttlDays) ??
    defaultOpenStoreProbe(storePath, persistence.ttlDays);
  if ("error" in probe) {
    return {
      id: "persistence",
      state: "warn",
      detail: `${base}; store unreadable (${probe.error}) — the plugin degrades to memory-only; conversations are not blocked.`,
      fix: "Run `leakshield --forget --all` to reset the store (erases persisted mappings), or restore the file.",
    };
  }
  return {
    id: "persistence",
    state: "warn",
    // Honesty (R-round F6.2): the doctor counts sessions with a throwaway
    // key — it cannot and does not verify keychain health or decryptability.
    // Runtime setup logs remain the authoritative degradation signal.
    detail: `${base}; ${probe.sessions} persisted session(s) — runtime activation and decryptability not verified from doctor.`,
    fix: "Check the running plugin's persistence active/memory-only log and test restart restoration with synthetic data.",
  };
}

function defaultOpenStoreProbe(
  storePath: string,
  ttlDays: number,
): { sessions: number } | { error: string } {
  try {
    // Throwaway key + readOnly: counting sessions never decrypts rows, and
    // the doctor must never read the user's real keychain (it could prompt).
    const store = openMappingStore({
      path: storePath,
      keyProvider: new InMemoryMappingKeyProvider(),
      ttlDays,
      readOnly: true,
    });
    const sessions = store.sessionCount();
    store.close();
    return { sessions };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const host = parseHostVersion(deps.opencodeVersion());

  if (!host) {
    checks.push({
      id: "host",
      state: "fail",
      detail: "opencode binary not found on PATH (or `opencode --version` failed).",
      fix: "Install OpenCode, or add it to PATH, then rerun `leakshield --doctor`.",
    });
    return { status: "HOST_MISSING", hostVersion: null, hostGeneration: null, configPath: null, checks };
  }
  if (host.generation === "v1") {
    checks.push({
      id: "host",
      state: "fail",
      detail: `OpenCode ${host.version.trim()} (v1) is no longer supported. LeakShield only blocks model requests on a v1 host.`,
      fix: "Upgrade to OpenCode v2, then rerun `leakshield --doctor`.",
    });
    return { status: "BROKEN", hostVersion: host.version, hostGeneration: host.generation, configPath: null, checks };
  }
  checks.push({ id: "host", state: "ok", detail: `OpenCode ${host.version.trim()} (${host.generation})` });

  // Config discovery across every file OpenCode merges
  const { sources, broken } = loadConfigSources(deps);
  const configPaths = sources.map((source) => source.path);
  const configPath = broken?.path ?? configPaths[0] ?? null;

  if (broken) {
    checks.push({
      id: "config",
      state: "fail",
      detail: `${broken.path} is not parseable JSON/JSONC: ${broken.error}`,
      fix: "Fix the syntax error; doctor reads every config file OpenCode merges, so one broken file hides the rest.",
    });
    return { status: "BROKEN", hostVersion: host.version, hostGeneration: host.generation, configPath, checks };
  }

  if (sources.length === 0) {
    checks.push({
      id: "config",
      state: "warn",
      detail: "No opencode.json / opencode.jsonc found (workspace or global).",
      fix: "Create one with the snippet below.",
    });
  } else {
    checks.push({ id: "config", state: "ok", detail: configPaths.join(", ") });
  }

  const applied = applyPluginLists([...sources].reverse());
  const registration: RegistrationMatch | null = applied.registered
    ? {
        packageRef: applied.registered.id,
        options: applied.registered.options,
        isLocalDistPath: applied.registered.id.includes("/"),
      }
    : null;
  const distDir = path.resolve(deps.cwd, "dist");

  if (!registration) {
    checks.push({
      id: "registration",
      state: "fail",
      detail: applied.disabled
        ? `LeakShield is disabled by "${applied.disabled.entry}" in ${applied.disabled.source}, so the host does not load it.`
        : "LeakShield is not registered in the OpenCode config.",
      fix: "Add it (snippet below), then rerun this doctor.",
    });
    return {
      status: "NOT_REGISTERED",
      hostVersion: host.version,
      hostGeneration: host.generation,
      configPath,
      checks,
      snippet: registrationSnippet(distDir),
    };
  }
  const fromSource =
    applied.registered && sources.length > 1 ? ` (from ${applied.registered.source})` : "";
  checks.push({
    id: "registration",
    state: "ok",
    detail: `Registered as "${registration.packageRef}"${registration.options && Object.keys(registration.options as object).length > 0 ? " with options" : ""}${fromSource}.`,
  });

  // Local dist presence (silent-skip guard: the host logs and skips a plugin
  // whose entry point cannot be resolved, which looks like "no protection"
  // with no visible failure).
  if (registration.isLocalDistPath && registration.packageRef) {
    const resolved = path.resolve(deps.cwd, registration.packageRef);
    // A directory registration resolves to index.js through the host; an
    // entry ending in .js points directly at the compiled file.
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
    detail: `mode=${options.mode}${(registration.options as { mode?: unknown } | undefined)?.mode === undefined ? " (default)" : ""}${options.mode === "transparent" ? ` wireProtection=${options.wireProtection ?? true}` : ""}${options.attachments === "allow" ? " attachments=allow" : ""}${options.deidentify ? " +deidentify" : ""}${options.envQueries ? " +envQueries" : ""}${options.configPath ? ` configPath=${options.configPath}` : ""}`,
  });
  checks.push(persistenceCheck(options, deps));

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

  // Custom rules the scanner skips (the ReDoS timing heuristic; uncompileable
  // patterns already failed the load above). Descriptions only, never patterns.
  const skipped = skippedCustomRules(guardConfig);
  if (skipped.length > 0) {
    checks.push({
      id: "custom-rules",
      state: "warn",
      detail: `${skipped.length} custom rule(s) disabled and not enforced: ${skipped.map((rule) => `"${rule.description}" (${rule.reason === "invalid" ? "pattern does not compile" : "disabled by ReDoS check"})`).join(", ")}. The ReDoS check is a timing heuristic, not a guarantee.`,
      fix: "Rewrite the pattern without nested or overlapping quantifiers, such as (a+)+ or (a|a)*.",
    });
  }

  // Allowlists (issue #32) are an exact-match bypass, so they are surfaced
  // rather than silent: which entries exist, whether each still suppresses the
  // literal it names, and how many suppressions this process counted.
  const globalAllow = guardConfig.settings?.allowlist ?? [];
  const customRules = guardConfig.custom_rules ?? [];
  const ruleAllow = customRules.flatMap((rule) => rule.allow ?? []);
  const entries: { value: string; ruleIndex: number }[] = [];
  const seenEntry = new Set<string>();
  for (const value of globalAllow) {
    const key = `global\u0000${value}`;
    if (seenEntry.has(key)) continue;
    seenEntry.add(key);
    entries.push({ value, ruleIndex: -1 });
  }
  customRules.forEach((rule, ruleIndex) => {
    for (const value of rule.allow ?? []) {
      const key = `rule${ruleIndex}\u0000${value}`;
      if (seenEntry.has(key)) continue;
      seenEntry.add(key);
      entries.push({ value, ruleIndex });
    }
  });
  if (entries.length > 0) {
    const scan = deps.probeScan ?? defaultProbeScan;
    // An allowlist only suppresses a rule's own finding or an exact env value.
    // A Unicode evasion warning (zero-width or look-alike letters) is not a rule match,
    // so it must neither count as suppression nor as a broken filter.
    const suppressible = (
      exact: { description: string | null; unicodeWarning: boolean }[],
      ruleDescription: string | undefined,
    ) =>
      exact.filter(
        (finding) =>
          !finding.unicodeWarning && (ruleDescription === undefined || finding.description === ruleDescription),
      );
    const withoutAllowlists = (config: GuardConfig): GuardConfig => ({
      ...config,
      settings: { ...(config.settings ?? {}), allowlist: [] },
      custom_rules: (config.custom_rules ?? []).map((rule) => ({ ...rule, allow: undefined })),
    });
    const sample = entries.slice(0, 8);
    let broken = 0;
    let exercised = 0;
    let unverified = 0;
    // A per-rule entry must be judged against that rule alone: leaving built-in
    // detectors in place would report a correct suppression as BROKEN when the
    // same literal is also an email, a keyword or an env value.
    const isolateRule = (ruleIndex: number): GuardConfig => ({
      nda_keywords: [],
      private_domains: [],
      custom_rules: [customRules[ruleIndex]!],
      exact_value_detector: undefined,
      settings: {
        ...(guardConfig.settings ?? {}),
        allowlist: [],
        env_files: [],
        encoding_detection: false,
        private_cidrs: [],
        rule_overrides: Object.fromEntries([...BUILTIN_RULE_IDS].map((id) => [id, false])),
      },
    });
    for (const entry of sample) {
      const scope: GuardConfig = entry.ruleIndex < 0 ? guardConfig : isolateRule(entry.ruleIndex);
      const ruleDescription = entry.ruleIndex < 0 ? undefined : customRules[entry.ruleIndex]!.description;
      // Only an exact matched span can be suppressed, so the baseline must ask
      // for one: a rule matching a substring of the entry says nothing about it.
      const baseline = scan(entry.value, withoutAllowlists(scope));
      const withAllow = scan(entry.value, scope);
      if (suppressible(withAllow.exact, ruleDescription).length > 0) broken += 1;
      else if (suppressible(baseline.exact, ruleDescription).length > 0) exercised += 1;
      else unverified += 1;
    }
    const entryCount = entries.length === 1 ? "1 allowlist entry" : `${entries.length} allowlist entries`;
    const coverage = sample.length === entries.length ? "all" : `${sample.length} of them`;
    const counter = `${allowlistSuppressions()} suppression(s) counted in this process`;
    if (broken > 0) {
      checks.push({
        id: "allowlist",
        state: "fail",
        detail: `${broken} allowlisted literal(s) still produce a finding under their own scope. The exact-match filter is not working, so those values are not actually quiet. ${entryCount} total; ${counter}.`,
        fix: "Do not rely on those entries. Re-run the scanner with `--text` on the exact value and report it: an allowlisted literal must produce no rule or env finding (a standing Unicode warning is separate).",
      });
    } else if (unverified > 0) {
      checks.push({
        id: "allowlist",
        state: "warn",
        detail: `${entryCount} (global ${globalAllow.length}, per-rule ${ruleAllow.length}), exact match only; ${exercised} suppress when exercised, ${unverified} could not be exercised as a bare literal (a context-dependent pattern is judged only in place). ${coverage} exercised; ${counter}.`,
        fix: "Review the entries that doctor could not exercise; it cannot prove a context-dependent entry, and an entry that no longer matches anything is only risk.",
      });
    } else {
      checks.push({
        id: "allowlist",
        state: "ok",
        detail: `${entryCount} (global ${globalAllow.length}, per-rule ${ruleAllow.length}), exact match only; ${coverage} exercised, all suppress; ${counter}.`,
      });
    }
  }

  // `word_boundary` can only add \b at literal ASCII word edges. Where the edge
  // is a group/class/quantifier the rule is looser than it looks; say so.
  const boundaryHidden = customRules.filter((rule) => {
    if (rule.word_boundary !== true) return false;
    const edges = customRuleBoundaries(rule);
    return edges.lead === "hidden" || edges.trail === "hidden";
  });
  if (boundaryHidden.length > 0) {
    checks.push({
      id: "custom-rule-boundaries",
      state: "warn",
      detail: `${boundaryHidden.length} custom rule(s) set word_boundary but end or start with a group, class, quantifier or escape, where no \\b can be added: ${boundaryHidden.map((rule) => `"${rule.description}"`).join(", ")}. Those edges match inside larger words.`,
      fix: "Write \\b in the pattern yourself, e.g. \\bEMP-\\d{6}\\b, or finish the pattern with a literal word character.",
    });
  }

  // `path` is accepted but not implemented: the scanner has no source path for
  // chat or tool text. Say so instead of letting a rule look scoped when it is not.
  const pathRules = customRules.filter((rule) => (rule.path ?? []).length > 0);
  if (pathRules.length > 0) {
    checks.push({
      id: "custom-rule-paths",
      state: "warn",
      detail: `${pathRules.length} custom rule(s) set \`path\`, but path scoping is not implemented: they apply to every scanned text, including prompts and tool output.`,
      fix: "Remove `path` from those rules, or rely on the rule's pattern alone, until path scoping ships.",
    });
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

  // A failed check must not still read as PARTIAL or PROTECTED: an allowlist
  // failure is a "do not trust this install" signal, like a missing canary.
  if (checks.some((check) => check.state === "fail")) {
    return { status: "BROKEN", hostVersion: host.version, hostGeneration: host.generation, configPath, checks };
  }

  if (options.mode === "transparent") {
    checks.push({
      id: "coverage",
      state: "warn",
      detail: `${options.wireProtection === false ? "transparent hook-only: content hooks protect their snapshots; no outbound HTTP/WS/SDK admission, transport metadata checks, injected-fetch requirement or provider transport transform. Final bodies/frames are not inspected or remasked. Unknown routes, including /alpha/generate, are not gated. Optional incoming HTTP/WS hooks restore known display protocols after successful scoped host preparation for the same session/kind/model; unsupported or unverified replies remain literal. Tool safety remains. Content added after hooks may be unmasked, including late-added attachments." : "transparent mode protects three HTTP protocols by wire shape (Chat Completions, Anthropic Messages, Responses) and native Responses-family WS frames; unknown outbound dialects and intercepted routes, including /alpha/generate, are refused (fail-closed), not passed. AI SDK providers must honor OpenCode's injected HTTP fetch; missing or unsafe fetch options refuse. Bypass transports are outside coverage, not a proven blocked transport."} Both levels stop rewriting on reply-side SG failures and keep literal originals; provider errors and cancellation still propagate. Content-hook masking failures still refuse the affected model call with a safe reason/stage, never silently send raw content. Attachments policy at content hooks: ${options.attachments === "allow" ? "ALLOW — attachments pass through unscanned with a visible notice (you vouch for their content)" : "block — replaced with an omission notice"}. Complete original-history/restart restoration is not verified.`,
    });
  }

  checks.push({
    id: "runtime",
    state: "warn",
    detail: "Install-level checks pass. Live-session proof: run the README smoke test or scripts/e2e/run-boundary.mjs.",
  });

  return { status: options.mode === "transparent" && options.wireProtection === false ? "PARTIAL" : "PROTECTED", hostVersion: host.version, hostGeneration: host.generation, configPath, checks };
}

export function formatDoctorReport(report: DoctorReport): string {
  const icon = { ok: "[OK]  ", warn: "[WARN]", fail: "[FAIL]", skip: "[SKIP]" } as const;
  const lines: string[] = [];
  lines.push(`leakshield doctor — ${new Date().toISOString()}`);
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
        ? "PARTIAL — hook-first protection; final outbound HTTP bodies are not inspected."
        : report.status === "BROKEN"
          ? "BROKEN — registered but would not protect; fix the [FAIL] items above."
          : report.status === "NOT_REGISTERED"
            ? "NOT REGISTERED — LeakShield is not in the OpenCode config; sessions are unprotected."
            : "HOST MISSING — no OpenCode binary found.";
  lines.push(verdict);
  lines.push("");
  lines.push("Scope: model-conversation leak protection. This is NOT a tool-egress firewall: permitted local tools (curl, remote MCP, …) can still transmit originals. See README.");
  return lines.join("\n");
}
