import type { Plugin as PluginNamespace } from "@opencode/plugin";
import type { PluginModule } from "@opencode-ai/plugin";
import { z } from "zod";
import { loadConfig } from "./config/loader.js";
import { createSessionKey } from "./decision/deidentify.js";
import { createFailClosedHooks, createHooks } from "./opencode-hooks.js";
import { createFailClosedV2Setup, createV2Setup } from "./opencode-v2.js";
import type { GuardConfig } from "./types.js";

type V2Plugin = PluginNamespace.Plugin;
type V2PluginContext = PluginNamespace.Context;

// deidentify is v2-only and valid only in redact mode; an invalid combination
// makes the parse throw, and every entry path already fails closed on that.
const PluginOptionsSchema = z
  .object({
    mode: z.enum(["block", "redact"]).default("block"),
    configPath: z.string().min(1).optional(),
    deidentify: z.boolean().default(false),
  })
  .refine((options) => !options.deidentify || options.mode === "redact", {
    message: "deidentify requires mode 'redact'",
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

function getWorkspaceRoot(input: unknown): string {
  if (typeof input !== "object" || input === null) return process.cwd();
  const context = input as { worktree?: unknown; directory?: unknown };
  if (typeof context.worktree === "string") return context.worktree;
  if (typeof context.directory === "string") return context.directory;
  return process.cwd();
}

const v2Setup = async (ctx: V2PluginContext): Promise<void> => {
  try {
    const options: PluginOptions = PluginOptionsSchema.parse(ctx.options);
    const config = withEncodingDetection(loadConfig(options.configPath, ctx.location.directory));
    const deidentify = options.deidentify ? { sessionKey: createSessionKey() } : undefined;
    await createV2Setup(config, options.mode, deidentify)(ctx);
  } catch {
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
    const config = withEncodingDetection(loadConfig(options.configPath, getWorkspaceRoot(input)));
    return createHooks(config, options.mode);
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
