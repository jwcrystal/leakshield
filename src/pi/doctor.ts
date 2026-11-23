/**
 * pi adapter checks for `leakshield --doctor`.
 *
 * In-process protection has no launcher to inspect, so the checks answer the
 * questions that decide whether pi will actually run behind the guard: is the
 * extension built, is it registered ahead of every other extension, does the
 * guard config load, and does the selected model use a wire API that goes
 * through fetch. Like the Claude Code checks, they never read or print a
 * credential value.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DoctorCheck } from "../doctor.js";
import { loadConfig } from "../config/loader.js";
import { piPersistenceOptions } from "./persistence.js";
import {
  defaultPiAgentDir,
  isSupportedPiApi,
  loadPiUserAgent,
  resolveExtensionEntry,
  resolvePiSelectedModel,
  type PiUserAgent,
} from "./settings.js";

export const MINIMUM_PI_MINOR = 6;
const PI_API_LIST = "openai-completions, openai-responses or anthropic-messages";

export interface PiDoctorDeps {
  piVersion(): string | null;
  env: Readonly<Record<string, string | undefined>>;
  readFile(filePath: string): string | null;
  fileExists(filePath: string): boolean;
  home: string;
  cwd: string;
  extensionPath(): string;
  /** Loads the guard config the extension would use. */
  checkConfig(): string | null;
}

export function parsePiVersion(raw: string): { major: number; minor: number } | null {
  const match = /^(\d+)\.(\d+)/.exec(raw.trim());
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function agentDirOf(deps: PiDoctorDeps): string {
  return deps.env.PI_CODING_AGENT_DIR ?? defaultPiAgentDir(deps.home);
}

function samePath(left: string, right: string): boolean {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

/** Index of the LeakShield entry in `settings.extensions`, or -1. */
export function extensionIndex(
  entries: readonly string[],
  extensionPath: string,
  cwd: string,
  agentDir: string,
): number {
  return entries.findIndex((entry) =>
    resolveExtensionEntry(entry, cwd, agentDir).some((candidate) => samePath(candidate, extensionPath)),
  );
}

export async function runPiDoctor(deps: PiDoctorDeps): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const version = deps.piVersion();
  if (version === null) {
    checks.push({ id: "pi", state: "skip", detail: "pi binary not found on PATH; pi checks skipped." });
    return checks;
  }
  const parsed = parsePiVersion(version);
  if (parsed === null || parsed.major !== 1 || parsed.minor < MINIMUM_PI_MINOR) {
    checks.push({
      id: "pi",
      state: "fail",
      detail: `pi ${version} is not supported; this adapter needs >= 1.${MINIMUM_PI_MINOR} < 2.`,
      fix: "Upgrade pi before relying on the LeakShield extension.",
    });
    return checks;
  }
  checks.push({ id: "pi", state: "ok", detail: `pi ${version}` });

  const extensionPath = deps.extensionPath();
  checks.push(
    deps.fileExists(extensionPath)
      ? { id: "pi-extension", state: "ok", detail: `extension ${extensionPath}` }
      : {
          id: "pi-extension",
          state: "fail",
          detail: `the extension is missing at ${extensionPath}; this build is incomplete.`,
          fix: "Reinstall leakshield (the package must ship dist/pi/extension.js).",
        },
  );

  const configError = deps.checkConfig();
  checks.push(
    configError === null
      ? { id: "pi-config", state: "ok", detail: "guard configuration loads (checked from this shell's directory)" }
      : {
          id: "pi-config",
          state: "fail",
          detail: `guard configuration could not be loaded: ${configError}`,
          fix: "Fix the guard config, or point LEAKSHIELD_CONFIG at the intended file. pi exits instead of running unprotected.",
        },
  );

  try {
    const persistence = piPersistenceOptions(deps.env);
    checks.push(
      persistence === undefined
        ? { id: "pi-persistence", state: "ok", detail: "mapping persistence is off; mappings last for the process" }
        : {
            id: "pi-persistence",
            state: "ok",
            detail: `mapping persistence is on (ttl ${persistence.ttlDays}d, ${persistence.path})`,
          },
    );
  } catch (error) {
    checks.push({
      id: "pi-persistence",
      state: "fail",
      detail: `persistence configuration is invalid: ${error instanceof Error ? error.message : String(error)}`,
      fix: "Fix the LEAKSHIELD_PI_PERSIST* values, or unset them; pi refuses to load the extension with an invalid value.",
    });
  }

  let agent: PiUserAgent | null = null;
  try {
    agent = loadPiUserAgent(agentDirOf(deps), deps.readFile);
  } catch (error) {
    checks.push({
      id: "pi-settings",
      state: "fail",
      detail: `pi configuration could not be read: ${error instanceof Error ? error.message : String(error)}`,
      fix: "Fix the JSON, or rerun with PI_CODING_AGENT_DIR pointing at the intended agent directory.",
    });
  }

  if (agent !== null) {
    const entries = (agent.settings.extensions ?? []).filter((entry): entry is string => typeof entry === "string");
    const index = extensionIndex(entries, extensionPath, deps.cwd, agent.agentDir);
    if (index === -1) {
      checks.push({
        id: "pi-extension-registered",
        state: "skip",
        detail: "LeakShield is not in pi settings.extensions; a run started with `-e` cannot be seen from here.",
        fix: `Add "${extensionPath}" first in settings.extensions to make this check meaningful, or keep using -e (which always loads before settings extensions).`,
      });
    } else if (index > 0) {
      const earlier = entries.slice(0, index).join(", ");
      checks.push({
        id: "pi-extension-registered",
        state: "warn",
        detail: `LeakShield is extension #${index + 1}; ${earlier} loads first and can keep the raw fetch. pi's own requests are still guarded.`,
        fix: "Move the LeakShield entry to the top of settings.extensions so no earlier extension can hold the raw fetch.",
      });
    } else {
      checks.push({
        id: "pi-extension-registered",
        state: "ok",
        detail: "LeakShield is the first entry of settings.extensions (CLI -e and package entries are not visible to this check)",
      });
    }

    const selected = resolvePiSelectedModel(agent, deps.env);
    if (selected === null) {
      checks.push({
        id: "pi-provider",
        state: "skip",
        detail: "no provider selected in settings; the guard checks the model at session start.",
      });
    } else if (selected.api === undefined) {
      checks.push({
        id: "pi-provider",
        state: "warn",
        detail: `${selected.provider}${selected.model !== undefined ? ` / ${selected.model}` : ""} declares no api; a built-in provider default applies.`,
        fix: `Declare "api" in pi's models.json (${PI_API_LIST}), or confirm the model at runtime.`,
      });
    } else if (!isSupportedPiApi(selected.api)) {
      checks.push({
        id: "pi-provider",
        state: "fail",
        detail: `${selected.provider}${selected.model !== undefined ? ` / ${selected.model}` : ""} uses api ${selected.api}, which does not go through fetch; the extension refuses the run.`,
        fix: `Select a model with ${PI_API_LIST}, or keep this provider for a host that can guard it.`,
      });
    } else {
      checks.push({
        id: "pi-provider",
        state: "ok",
        detail: `${selected.provider}${selected.model !== undefined ? ` / ${selected.model}` : ""} (${selected.api})`,
      });
    }
  }

  return checks;
}

/**
 * The extension ships next to this module in dist/pi/. A source checkout run
 * through tsx uses the TypeScript file, which pi can load directly.
 */
export function defaultPiExtensionPath(): string {
  const built = fileURLToPath(new URL("./extension.js", import.meta.url));
  if (fs.existsSync(built)) return built;
  const source = fileURLToPath(new URL("./extension.ts", import.meta.url));
  return fs.existsSync(source) ? source : built;
}

export function createPiDoctorDeps(extensionPath: string = defaultPiExtensionPath()): PiDoctorDeps {
  return {
    piVersion() {
      const result = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 4000 });
      if (result.error || (result.status !== null && result.status !== 0)) return null;
      return (result.stdout || "").trim() || null;
    },
    env: process.env,
    readFile(filePath) {
      try {
        return fs.readFileSync(filePath, "utf8");
      } catch {
        return null;
      }
    },
    fileExists(filePath) {
      try {
        return fs.existsSync(filePath);
      } catch {
        return false;
      }
    },
    home: os.homedir(),
    cwd: process.cwd(),
    extensionPath: () => extensionPath,
    checkConfig() {
      try {
        loadConfig(process.env.LEAKSHIELD_CONFIG, process.cwd());
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  };
}
