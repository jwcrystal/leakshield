import type { Plugin as PluginNamespace } from "@opencode/plugin";
import type { PluginModule } from "@opencode-ai/plugin";
import { z } from "zod";
import { findConfigPath, loadConfigWithFingerprint, type LoadedGuardConfig } from "./config/loader.js";
import { createSessionKey } from "./decision/deidentify.js";
import { EnvQueryService } from "./env-queries.js";
import { createFailClosedHooks, createHooks } from "./opencode-hooks.js";
import { createV1EnvTools } from "./opencode-env-tools.js";
import { createFailClosedV2Setup, createV2Setup } from "./opencode-v2.js";
import { createFailClosedTransparentGuard, createTransparentSessionGuard } from "./opencode-transparent.js";
import type { GuardConfig } from "./types.js";

type V2Plugin = PluginNamespace.Plugin;
type V2PluginContext = PluginNamespace.Context;

// deidentify is v2-only and valid only in redact mode; an invalid combination
// makes the parse throw, and every entry path already fails closed on that.
// transparent is the v2-only reversible pseudonymization mode (issue #22):
// it owns its own bounded session service and transport hooks, so combining
// it with the second (deidentify) protection pipeline or the v1/v2 env query
// tools is rejected here — every entry path fails closed on the parse error.
const PluginOptionsSchema = z
  .object({
    mode: z.enum(["block", "redact", "transparent"]).default("block"),
    configPath: z.string().min(1).optional(),
    deidentify: z.boolean().default(false),
    /** Opt-in readonly env query tools over `settings.env_files`. Default off. */
    envQueries: z.boolean().default(false),
  })
  .refine((options) => !options.deidentify || options.mode === "redact", {
    message: "deidentify requires mode 'redact'",
  })
  .refine((options) => options.mode !== "transparent" || !options.envQueries, {
    message: "envQueries is not supported in mode 'transparent'",
  })
  .default({});

type PluginOptions = z.infer<typeof PluginOptionsSchema>;

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

/** Whether the raw plugin options request transparent mode (even if invalid). */
function rawModeIsTransparent(options: unknown): boolean {
  return (
    typeof options === "object" &&
    options !== null &&
    (options as { mode?: unknown }).mode === "transparent"
  );
}

const v2Setup = async (ctx: V2PluginContext): Promise<PluginNamespace.Cleanup | void> => {
  try {
    const options: PluginOptions = PluginOptionsSchema.parse(ctx.options);
    const loaded = loadConfigWithFingerprint(options.configPath, ctx.location.directory);
    const config = withEncodingDetection(loaded.config);
    if (options.mode === "transparent") {
      // Transparent pseudonymization arms its own bounded session service,
      // transport hooks, and disposal; deidentify/envQueries combos were
      // already rejected at the option schema. The guard's dispose is returned
      // so the host can clean up registrations and mappings on unload.
      const guard = createTransparentSessionGuard(config);
      await guard.setup(ctx);
      return guard.dispose;
    }
    const deidentify = options.deidentify ? { sessionKey: createSessionKey() } : undefined;
    const envQueries = createEnvQueryService(options, ctx.location.directory, loaded);
    await createV2Setup(config, options.mode, deidentify, envQueries)(ctx);
  } catch {
    // Fail closed. In transparent mode the fallback must cover the transport
    // routes (http/ws/aisdk) too, not only the redact-mode hooks — otherwise a
    // failed initialization would leave those routes unprotected. The raw
    // option is inspected because a schema/refine failure leaves `options`
    // unset. The fallback's dispose is returned for host-triggered cleanup.
    if (rawModeIsTransparent(ctx.options)) {
      const guard = createFailClosedTransparentGuard();
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
    const options: PluginOptions = PluginOptionsSchema.parse(rawOptions);
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
const sensitiveGuardPlugin = {
  id: "sensitive-guard",
  setup: v2Setup,
  server: v1Server,
} satisfies PluginModule & V2Plugin;

export default sensitiveGuardPlugin;
