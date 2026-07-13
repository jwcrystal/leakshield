import type { Plugin } from "@opencode-ai/plugin";
import { z } from "zod";
import { loadConfig } from "./config/loader.js";
import { createFailClosedHooks, createHooks } from "./opencode-hooks.js";
import type { GuardConfig } from "./types.js";

const PluginOptionsSchema = z.object({
  mode: z.enum(["block", "redact"]).default("block"),
  configPath: z.string().min(1).optional(),
}).default({});

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

const sensitiveGuardPlugin = (async (_input, rawOptions) => {
  try {
    const options: PluginOptions = PluginOptionsSchema.parse(rawOptions);
    const config = withEncodingDetection(loadConfig(options.configPath));
    return createHooks(config, options.mode);
  } catch {
    return createFailClosedHooks();
  }
}) satisfies Plugin;

export default sensitiveGuardPlugin;
