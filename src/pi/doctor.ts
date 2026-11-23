/**
 * pi adapter checks for `leakshield --doctor`.
 *
 * They answer whether the machine can run the managed boundary (pi present at
 * a supported version, extension built, user provider resolvable) and whether
 * the current shell is actually inside a managed launch. Like the Claude Code
 * checks, they never read or print a credential value.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DoctorCheck } from "../doctor.js";
import { MINIMUM_PI_MINOR, parsePiVersion } from "./launcher.js";
import { PI_HEALTH_PATH, PI_HEALTH_SERVICE } from "./proxy.js";
import {
  loadPiUserAgent,
  providerFromModel,
  resolvePiProvider,
  type PiUserAgent,
} from "./settings.js";

export type PiProxyProbe = { ok: true; upstream: string | null } | { ok: false; reason: "unreachable" | "not-leakshield" };

export interface PiDoctorDeps {
  piVersion(): string | null;
  env: Readonly<Record<string, string | undefined>>;
  readFile(filePath: string): string | null;
  fileExists(filePath: string): boolean;
  home: string;
  cwd: string;
  extensionPath(): string;
  probeProxy(baseUrl: string): Promise<PiProxyProbe>;
}

function isLoopbackUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  } catch {
    return false;
  }
}

function agentDirOf(deps: PiDoctorDeps): string {
  return deps.env.PI_CODING_AGENT_DIR ?? path.join(deps.home, ".pi", "agent");
}

export async function runPiDoctor(deps: PiDoctorDeps): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const version = deps.piVersion();
  if (version === null) {
    checks.push({ id: "pi", state: "skip", detail: "pi binary not found on PATH; pi checks skipped." });
    return checks;
  }
  if (parsePiVersion(version) === null) {
    checks.push({
      id: "pi-version",
      state: "fail",
      detail: `pi ${version} is not supported; this adapter needs >= 1.${MINIMUM_PI_MINOR} < 2.`,
      fix: "Upgrade pi, then rerun `leakshield --pi`.",
    });
    return checks;
  }
  checks.push({ id: "pi", state: "ok", detail: `pi ${version}` });

  const extensionPath = deps.extensionPath();
  checks.push(
    deps.fileExists(extensionPath)
      ? { id: "pi-extension", state: "ok", detail: `managed extension ${extensionPath}` }
      : {
          id: "pi-extension",
          state: "fail",
          detail: `the managed extension is missing at ${extensionPath}; this build is incomplete.`,
          fix: "Reinstall leakshield (the package must ship dist/pi/extension.js).",
        },
  );

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
    let provider: string | undefined;
    let model: string | undefined;
    let credential: boolean | undefined;
    try {
      const resolution = resolvePiProvider({ agent, env: deps.env });
      provider = resolution.provider;
      model = resolution.model;
      credential = resolution.upstream.apiKey !== undefined;
    } catch (error) {
      provider = deps.env.PI_PROVIDER ?? agent.settings.defaultProvider ?? providerFromModel(agent.settings.defaultModel);
      checks.push({
        id: "pi-provider",
        state: "warn",
        detail: `pi provider could not be resolved without flags: ${error instanceof Error ? error.message : String(error)}`,
        fix: "Pass --provider to `leakshield --pi`, or declare the provider in pi's models.json.",
      });
    }
    if (provider !== undefined && credential !== undefined) {
      checks.push({
        id: "pi-provider",
        state: "ok",
        detail: `${provider}${model !== undefined ? ` / ${model}` : ""}`,
      });
      checks.push(
        credential
          ? { id: "pi-credential", state: "ok", detail: `a credential is available for ${provider} (value not read).` }
          : {
              id: "pi-credential",
              state: "warn",
              detail: `no credential found in the environment or models.json for ${provider}.`,
              fix: `Export its API key or run \`pi auth login ${provider}\` before \`leakshield --pi\`.`,
            },
      );
    }
    // An entry that names a real upstream is expected; it becomes a bypass only
    // when pi runs without the launcher.
    const realEndpoints = Object.entries(agent.providers).filter(
      ([, entry]) => typeof entry.baseUrl === "string" && !isLoopbackUrl(entry.baseUrl),
    );
    if (realEndpoints.length > 0 && deps.env.LEAKSHIELD_PI_URL === undefined) {
      checks.push({
        id: "pi-route",
        state: "warn",
        detail: `pi's own models.json configures ${realEndpoints.map(([id]) => id).join(", ")}; a plain \`pi\` run sends provider requests directly and is not protected.`,
        fix: "Start pi with `leakshield --pi` (or `leakshield pi`), which routes its only provider through the loopback boundary.",
      });
    }
  }

  const launchUrl = deps.env.LEAKSHIELD_PI_URL;
  if (launchUrl === undefined) {
    checks.push({
      id: "pi-launcher",
      state: "warn",
      detail: "LEAKSHIELD_PI_URL is not set in this shell; this is not a managed pi launch.",
      fix: "Run `leakshield --pi` to start pi behind the provider boundary.",
    });
  } else if (!isLoopbackUrl(launchUrl)) {
    checks.push({
      id: "pi-launcher",
      state: "fail",
      detail: "LEAKSHIELD_PI_URL is not a loopback address; the extension refuses it.",
      fix: "Start pi through `leakshield --pi` instead of setting the environment by hand.",
    });
  } else {
    const probe = await deps.probeProxy(launchUrl);
    if (probe.ok) {
      checks.push({
        id: "pi-launcher",
        state: "ok",
        detail: `managed launch active, boundary forwards to ${probe.upstream ?? "the configured provider"}`,
      });
    } else if (probe.reason === "unreachable") {
      checks.push({
        id: "pi-launcher",
        state: "fail",
        detail: `LEAKSHIELD_PI_URL=${launchUrl} points at a local address where nothing answers; provider requests will fail.`,
        fix: "Restart pi through `leakshield --pi`.",
      });
    } else {
      checks.push({
        id: "pi-launcher",
        state: "fail",
        detail: `the service at ${launchUrl} is not the LeakShield pi boundary.`,
        fix: "Unset LEAKSHIELD_PI_URL and start pi through `leakshield --pi`.",
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
    async probeProxy(baseUrl) {
      try {
        const response = await fetch(new URL(PI_HEALTH_PATH, baseUrl), { signal: AbortSignal.timeout(2000) });
        const body: unknown = await response.json().catch(() => null);
        if (response.ok && typeof body === "object" && body !== null && (body as { service?: unknown }).service === PI_HEALTH_SERVICE) {
          const upstream = (body as { upstream?: unknown }).upstream;
          return { ok: true, upstream: typeof upstream === "string" ? upstream : null };
        }
        return { ok: false, reason: "not-leakshield" };
      } catch {
        return { ok: false, reason: "unreachable" };
      }
    },
  };
}
