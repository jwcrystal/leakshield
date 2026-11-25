import type { Plugin as PluginNamespace } from "@opencode/plugin";
import type { PluginModule } from "@opencode-ai/plugin";
import { findConfigPath, loadConfigWithFingerprint, type LoadedGuardConfig } from "../../config/loader.js";
import { createSessionKey } from "../../decision/deidentify.js";
import { defaultStorePath } from "../../decision/mapping-key.js";
import { EnvQueryService } from "./env-queries.js";
import { createFailClosedHooks } from "./hooks.js";
import { createFailClosedV2Setup, createV2Setup } from "./v2.js";
import { createFailClosedTransparentGuard, createTransparentSessionGuard } from "./transparent.js";
import { validatePluginOptions, withDefaultMode, type PluginOptions } from "../../guard-options.js";
import type { GuardConfig } from "../../types.js";

type V2Plugin = PluginNamespace.Plugin;
type V2PluginContext = PluginNamespace.Context;

function withEncodingDetection(config: GuardConfig): GuardConfig {
  return {
    ...config,
    settings: {
      ...config.settings,
      encoding_detection: true,
    },
  };
}

/**
 * Builds the readonly env query service when the `envQueries` option is on.
 * The env_files allowlist, workspace root, and guard configuration are frozen
 * at setup from one configuration read (`loadConfigWithFingerprint`), so the
 * authorization can never be a mix of two different config states. Per-call
 * config drift disables queries until restart (handled inside the service),
 * never a silent fallback.
 */
function createEnvQueryService(
  options: PluginOptions,
  workspaceRoot: string,
  loaded: LoadedGuardConfig,
): EnvQueryService | undefined {
  if (!options.envQueries) return undefined;
  return new EnvQueryService({
    envFiles: loaded.config.settings.env_files ?? [],
    workspaceRoot,
    resolveConfigPath: () => findConfigPath(options.configPath),
    configFingerprint: loaded.fingerprint,
  });
}

/** Whether the raw v2 plugin options select transparent mode, explicitly or
 * by omitting `mode` (the v2 default), even if the options are invalid. */
function rawModeIsTransparent(options: unknown): boolean {
  const resolved = withDefaultMode(options);
  return (
    typeof resolved === "object" &&
    resolved !== null &&
    (resolved as { mode?: unknown }).mode === "transparent"
  );
}

/**
 * The refusal text appended when setup fails, so a user who never runs the
 * doctor still sees why every request is blocked. Option validation messages
 * name option keys and fixed rules, never the rejected values (see
 * `validatePluginOptions`). A guard config failure is described generically:
 * its error can carry file paths or custom rule descriptions.
 */
function invalidOptionsReason(error: string): string {
  const detail = error.replace(/\(root\): /g, "").replace(/[.\s]+$/, "");
  return `Invalid LeakShield options in opencode.json: ${detail}. Fix them and restart OpenCode; \`leakshield --doctor\` shows the details.`;
}
const CONFIG_LOAD_REASON =
  "The LeakShield guard config file could not be loaded. Run `leakshield --doctor` to see why, fix it and restart OpenCode.";

const v2Setup = async (ctx: V2PluginContext): Promise<PluginNamespace.Cleanup | void> => {
  let failureReason: string | undefined;
  try {
    const validation = validatePluginOptions(ctx.options);
    if (!validation.ok) {
      failureReason = invalidOptionsReason(validation.error);
      throw new Error("invalid plugin options");
    }
    const options: PluginOptions = validation.options;
    let loaded: LoadedGuardConfig;
    try {
      loaded = loadConfigWithFingerprint(options.configPath, ctx.location.directory);
    } catch (error) {
      failureReason = CONFIG_LOAD_REASON;
      throw error;
    }
    const config = withEncodingDetection(loaded.config);
    if (options.mode === "transparent") {
      // Transparent pseudonymization arms its own bounded session service,
      // transport hooks, and disposal. deidentify is still rejected at the
      // option schema; envQueries is accepted but ignored (warned below) since
      // the guard_env_* tools are not registered here. W2: persistence options
      // flow into the guard only when explicitly enabled (default memory-only,
      // zero behavior change).
      const persistence = options.persistence.enabled
        ? {
            ttlDays: options.persistence.ttlDays,
            path: options.persistence.path ?? defaultStorePath(),
            keyFile: options.persistence.keyFile,
            keyfilePath: options.persistence.keyfilePath,
          }
        : undefined;
      const guard = createTransparentSessionGuard(
        config,
        options.attachments,
        options.wireProtection ?? true,
        persistence,
      );
      await guard.setup(ctx);
      if (options.envQueries) {
        console.warn(
          "[leakshield] envQueries is ignored in transparent mode: the guard_env_* tools are not registered, and env files the agent reads are only partly masked (values shorter than 8 characters stay visible). Set mode to \"block\" or \"redact\" to use envQueries.",
        );
      }
      // Hook-only must leave provider routing/transport preferences untouched.
      if (options.wireProtection === false) return () => guard.dispose();
      try {
        // Native OpenAI defaults to WebSocket in OpenCode v2. HTTP uses the
        // same Responses protocol, but passes through our final wire hooks.
        // This registration is replayed on provider reload and removed on
        // unload; no persisted config, endpoint or credential is changed.
        // Explicit provider config is applied later by the host and can
        // override this compatibility preference; supported Responses-family
        // WS routes now have independent frame masking/restoration hooks.
        const registration = await ctx.provider.transform((editor) => {
          for (const { provider } of editor.list()) {
            if (provider.package !== "@opencode/ai/providers/openai") continue;
            editor.update(provider.id, (draft) => {
              draft.settings = { ...draft.settings, transport: "http" };
            });
          }
        });
        return async () => {
          try {
            await registration.dispose();
          } finally {
            await guard.dispose();
          }
        };
      } catch (error) {
        await guard.dispose();
        throw error;
      }
    }
    const deidentify = options.deidentify ? { sessionKey: createSessionKey() } : undefined;
    const envQueries = createEnvQueryService(options, ctx.location.directory, loaded);
    await createV2Setup(config, options.mode, deidentify, envQueries)(ctx);
  } catch {
    // Fail closed at the selected layer. Wire mode covers transport routes
    // too; explicit hook-only refuses content/tool dispatch without adding
    // transport gates or requiring the SDK API. The raw
    // option is inspected because a schema/refine failure leaves `options`
    // unset. The fallback's dispose is returned for host-triggered cleanup.
    if (rawModeIsTransparent(ctx.options)) {
      const guard = createFailClosedTransparentGuard(ctx.options?.wireProtection !== false, failureReason);
      await guard.setup(ctx);
      return guard.dispose;
    }
    await createFailClosedV2Setup(failureReason)(ctx);
  }
};

const V1_UNSUPPORTED =
  "LeakShield no longer supports OpenCode v1, so the request was blocked before anything was sent. Upgrade to OpenCode v2.";

/**
 * OpenCode v1 is not supported. This stub exists only so a v1 host that still
 * loads the package aborts every model request instead of running unprotected.
 * It must not throw: a host could swallow the error and carry on with no guard.
 */
const v1Server = async () => createFailClosedHooks(V1_UNSUPPORTED);

/**
 * OpenCode plugin entry. OpenCode v2 reads `id` and `setup(ctx)`. `server` is
 * the fail-closed stub for v1 hosts (1.18.29+), which call `server(input, options)`.
 */
const leakshieldPlugin = {
  id: "leakshield",
  setup: v2Setup,
  server: v1Server,
} satisfies PluginModule & V2Plugin;

export default leakshieldPlugin;
