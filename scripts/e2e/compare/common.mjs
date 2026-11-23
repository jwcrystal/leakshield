/** Shared pieces of the plugin comparison harness (see README.md here).
 * No credentials, no real model: every case talks to a loopback provider
 * stand-in with synthetic canary values. */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const SG_DIST = process.env.E2E_SG_DIST ?? path.join(REPO, "dist");
/** Directories that contain the plugin package (the folder with package.json). */
export const OFFICIAL = process.env.E2E_REHYDRA_PACKAGE;
export const EIGHTDOOR = process.env.E2E_EIGHTDOOR_PACKAGE;

export const EMAIL = "alice.test@example-test.invalid";
export const SECRET = "SyntheticCanaryValueQ7bNvR2s";
export const CANARIES = [EMAIL, SECRET];
export const TOKEN = /\[SGP[12]:[^\]\r\n]+\]|<PII\b[^>]*\/>/g;

export const INSTALL_HINT = `Install the third-party plugins somewhere private and point at them:
  npm install --prefix "$DIR/official"  --ignore-scripts @rehydra/opencode@0.14.0
  npm install --prefix "$DIR/eightdoor" --ignore-scripts opencode-rehydar@0.14.3
  export E2E_REHYDRA_PACKAGE="$DIR/official/node_modules/@rehydra/opencode"
  export E2E_EIGHTDOOR_PACKAGE="$DIR/eightdoor/node_modules/opencode-rehydar"`;

/** Absolute path of the OpenCode host: OPENCODE_BIN, else `opencode` on PATH. */
export function resolveBin() {
  const wanted = process.env.OPENCODE_BIN || "opencode";
  if (wanted.includes("/")) return path.resolve(wanted);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, wanted);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  return wanted;
}

export function hostVersion(bin) {
  const result = spawnSync(bin, ["--version"], { encoding: "utf8" });
  return result.error || result.status !== 0 ? undefined : result.stdout.trim();
}

export const knownSuites = ["baseline", "sg-hook", "sg-wire", "sg-persist-test", "official", "eightdoor", "eightdoor-default"];

/** baseline/sg-* always; the third-party suites only when their package is configured. */
export function defaultSuites() {
  return ["baseline", "sg-hook", "sg-wire", ...(OFFICIAL ? ["official"] : []), ...(EIGHTDOOR ? ["eightdoor"] : [])];
}

/** `--name=a,b` → ["a","b"]; absent → defaults. */
export function selected(flag, defaults) {
  const arg = process.argv.find((value) => value.startsWith(`--${flag}=`));
  return arg ? arg.slice(flag.length + 3).split(",") : defaults;
}

/** Exits 2 with a clear message instead of reporting N meaningless FAILs. */
export function preflight(suites) {
  const fail = (message) => { console.error(message); process.exit(2); };
  const bin = resolveBin();
  const version = hostVersion(bin);
  if (version === undefined) fail(`OpenCode host not found or not runnable: "${bin}". Put opencode on PATH or set OPENCODE_BIN=/path/to/opencode.`);
  for (const suite of suites) {
    if (!knownSuites.includes(suite)) fail(`Unknown suite "${suite}". Known: ${knownSuites.join(", ")}.`);
  }
  if (suites.some((suite) => suite.startsWith("sg-")) && !existsSync(path.join(SG_DIST, "adapters/opencode/transparent.js"))) {
    fail(`SG build not found at ${SG_DIST}. Run npm run build (or set E2E_SG_DIST).`);
  }
  if (suites.includes("official") && !(OFFICIAL && existsSync(path.join(OFFICIAL, "package.json")))) {
    fail(`Suite "official" needs E2E_REHYDRA_PACKAGE.\n${INSTALL_HINT}`);
  }
  if (suites.some((suite) => suite.startsWith("eightdoor")) && !(EIGHTDOOR && existsSync(path.join(EIGHTDOOR, "package.json")))) {
    fail(`Suite "eightdoor" needs E2E_EIGHTDOOR_PACKAGE.\n${INSTALL_HINT}`);
  }
  return { bin, version };
}

/** Private evidence directory; E2E_WORK_ROOT overrides the temp parent. */
export function makeOutputRoot(name) {
  const preferred = path.join(os.tmpdir(), "opencode");
  const parent = process.env.E2E_WORK_ROOT || (existsSync(preferred) ? preferred : os.tmpdir());
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  return mkdtempSync(path.join(parent, `${name}-`));
}

/** Isolated HOME/XDG so a case never reads or writes the user's real config. */
export function isolatedEnv(dir, bin) {
  return {
    HOME: path.join(dir, "home"), USER: "isolated-test", LOGNAME: "isolated-test", SHELL: "/bin/zsh", LANG: "en_US.UTF-8",
    PATH: `${path.dirname(bin)}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: dir, PWD: dir, CAPTURE_API_KEY: "synthetic-local-key",
    XDG_CONFIG_HOME: path.join(dir, "config"), XDG_DATA_HOME: path.join(dir, "data"),
    XDG_STATE_HOME: path.join(dir, "state"), XDG_CACHE_HOME: path.join(dir, "cache"),
  };
}

export function prepareCaseDirectory(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const sub of ["home", "config/opencode", "data", "state", "cache", "fixtures"]) {
    mkdirSync(path.join(dir, sub), { recursive: true });
  }
  writeFileSync(path.join(dir, ".env"), `TEST_SECRET=${SECRET}\n`);
  const guardConfig = path.join(dir, "guard.config.yaml");
  writeFileSync(guardConfig, "nda_keywords: []\nprivate_domains: []\ncustom_rules: []\nsettings:\n  max_chars: 200000\n  env_files:\n    - .env\n");
  return guardConfig;
}

const thirdPartyOptions = (suite, dir) => suite === "eightdoor-default" ? {} : {
  anonymizer: { secrets: { enabled: true, envFiles: [".env"], envBaseDirectory: dir, minValueLength: 8 }, ner: { mode: "disabled" } },
};

/** The `plugins` array of opencode.json for one suite. */
export function pluginsFor(suite, { dir, guardConfig }) {
  if (suite === "baseline") return [];
  if (suite === "official") return [{ package: OFFICIAL, options: thirdPartyOptions(suite, dir) }];
  if (suite.startsWith("eightdoor")) return [{ package: EIGHTDOOR, options: thirdPartyOptions(suite, dir) }];
  if (suite === "sg-persist-test") {
    // Test-only adapter: exercises the production guard/store across real host
    // process restarts with an injected key, so the user's OS keychain is never
    // touched. It does NOT validate the production keychain ladder.
    const adapter = path.join(dir, "persistence-test-plugin");
    mkdirSync(adapter);
    writeFileSync(path.join(adapter, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(path.join(adapter, "index.js"), `
      import { createTransparentSessionGuard } from ${JSON.stringify(path.join(SG_DIST, "adapters/opencode/transparent.js"))};
      import { loadConfig } from ${JSON.stringify(path.join(SG_DIST, "config/loader.js"))};
      import { InMemoryMappingKeyProvider } from ${JSON.stringify(path.join(SG_DIST, "decision/mapping-store.js"))};
      export default { id: 'sg-persistence-test', async setup(ctx) {
        const config = loadConfig(${JSON.stringify(guardConfig)}, ctx.location.directory);
        config.settings.encoding_detection = true;
        const guard = createTransparentSessionGuard(config, 'block', false, {
          path: ${JSON.stringify(path.join(dir, "test-mappings.db"))}, ttlDays: 7, keyFile: false,
          keyProvider: new InMemoryMappingKeyProvider(Buffer.alloc(32, 0x5a)),
        });
        await guard.setup(ctx);
        return guard.dispose;
      }};
    `);
    return [{ package: adapter }];
  }
  return [{ package: SG_DIST, options: { mode: "transparent", configPath: guardConfig, wireProtection: suite === "sg-wire" } }];
}
