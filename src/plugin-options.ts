/**
 * Plugin options schema — the single source of truth shared by the plugin
 * entry (src/opencode.ts, which keeps a default-only export surface for the
 * host loaders) and the install doctor (src/doctor.ts).
 */

import { z } from "zod";

// deidentify is v2-only and valid only in redact mode; an invalid combination
// makes the parse throw, and every entry path already fails closed on that.
// transparent is the v2-only reversible pseudonymization mode (issue #22):
// it owns its own bounded session service and transport hooks, so combining
// it with the second (deidentify) protection pipeline or the v1/v2 env query
// tools is rejected here — every entry path fails closed on the parse error.
export const PluginOptionsSchema = z
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

export type PluginOptions = z.infer<typeof PluginOptionsSchema>;

/** Validated plugin options for external consumers (doctor, tests). Never
 * throws; returns the combined zod/refine error message on failure. */
export type PluginOptionsValidation =
  | { ok: true; options: PluginOptions }
  | { ok: false; error: string };

export function validatePluginOptions(input: unknown): PluginOptionsValidation {
  const parsed = PluginOptionsSchema.safeParse(input ?? {});
  if (parsed.success) return { ok: true, options: parsed.data };
  return {
    ok: false,
    error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "),
  };
}
