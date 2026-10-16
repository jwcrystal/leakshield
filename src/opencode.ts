import type { Plugin as PluginNamespace } from "@opencode/plugin";
import type { PluginModule } from "@opencode-ai/plugin";
import { findConfigPath, loadConfigWithFingerprint, type LoadedGuardConfig } from "./config/loader.js";
import { createSessionKey } from "./decision/deidentify.js";
import { defaultStorePath } from "./decision/mapping-key.js";
import { EnvQueryService } from "./env-queries.js";
import { createFailClosedHooks, createHooks } from "./opencode-hooks.js";
import { createV1EnvTools } from "./opencode-env-tools.js";
import { createFailClosedV2Setup, createV2Setup } from "./opencode-v2.js";
import { createFailClosedTransparentGuard, createTransparentSessionGuard } from "./opencode-transparent.js";
import { PluginOptionsSchema, withDefaultMode, type PluginOptions } from "./plugin-options.js";
import type { GuardConfig } from "./types.js";

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

function getWorkspaceRoot(input: unknown): string {
  if (typeof input !== "object" || input === null) return process.cwd();
  const context = input as { worktree?: unknown; directory?: unknown };
  if (typeof context.worktree === "string") return context.worktree;
  if (typeof context.directory === "string") return context.directory;
  return process.cwd();
}

/** Whether the raw v2 plugin options select transparent mode, explicitly or
 * by omitting `mode` (the v2 default), even if the options are invalid. */
function rawModeIsTransparent(options: unknown): boolean {
  const resolved = withDefaultMode(options, "v2");
  return (
    typeof resolved === "object" &&
    resolved !== null &&
    (resolved as { mode?: unknown }).mode === "transparent"
  );
}

const v2Setup = async (ctx: V2PluginContext): Promise<PluginNamespace.Cleanup | void> => {
  try {
    const options: PluginOptions = PluginOptionsSchema.parse(withDefaultMode(ctx.options, "v2"));
    const loaded = loadConfigWithFingerprint(options.configPath, ctx.location.directory);
    const config = withEncodingDetection(loaded.config);
    if (options.mode === "transparent") {
      // Transparent pseudonymization arms its own bounded session service,
      // transport hooks, and disposal; deidentify/envQueries combos were
      // already rejected at the option schema. W2: persistence options flow
      // into the guard only when explicitly enabled (default memory-only,
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
      const guard = createFailClosedTransparentGuard(ctx.options?.wireProtection !== false);
      await guard.setup(ctx);
      return guard.dispose;
    }
    await createFailClosedV2Setup()(ctx);
  }
};

const v1Server = async (
  input: Parameters<NonNullable<PluginModule["server"]>>[0],
  rawOptions?: unknown,
) => {
  try {
    const options: PluginOptions = PluginOptionsSchema.parse(withDefaultMode(rawOptions, "v1"));
    if (options.deidentify) {
      // v1 has no de-identification pipeline; the shared options schema now
      // includes the flag, so v1 must explicitly reject it. The throw lands in
      // the catch below → fail-closed hooks.
      throw new Error("deidentify is only supported on OpenCode v2");
    }
    if (options.mode === "transparent") {
      // v1 has no native transport hooks to remask the final wire or restore
      // responses, so transparent mode cannot honor its contract there. The
      // throw lands in the catch below → fail-closed hooks.
      throw new Error("transparent mode is only supported on OpenCode v2");
    }
    const workspaceRoot = getWorkspaceRoot(input);
    const loaded = loadConfigWithFingerprint(options.configPath, workspaceRoot);
    const config = withEncodingDetection(loaded.config);
    const hooks = createHooks(config, options.mode);
    const envQueries = createEnvQueryService(options, workspaceRoot, loaded);
    if (!envQueries) return hooks;
    try {
      return { ...hooks, tool: await createV1EnvTools(envQueries) };
    } catch {
      // The opt-in env query tools failed to load on their own (e.g. a
      // missing v1 SDK module on an incomplete install). Only the feature
      // fails: the full protection hooks above stay exactly as armed as
      // they would be with envQueries off — no fail-closed downgrade, no
      // protection gap, no env tools.
      return hooks;
    }
  } catch {
    return createFailClosedHooks();
  }
};

/**
 * Dual-version OpenCode plugin entry. OpenCode v2 reads `id` and `setup(ctx)`;
 * OpenCode v1 (1.18.29+) calls `server(input, options)` and uses the returned hooks.
 */
const leakshieldPlugin = {
  id: "leakshield",
  setup: v2Setup,
  server: v1Server,
} satisfies PluginModule & V2Plugin;

export default leakshieldPlugin;
