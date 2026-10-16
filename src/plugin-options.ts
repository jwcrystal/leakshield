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
    /**
     * Attachment policy for transparent mode. "block" (default) omits
     * media/file parts — a notice replaces them, binary never crosses the
     * boundary, and the conversation survives. "allow" sends attachments
     * through unscanned with a visible notice part: an explicit,
     * configuration-level decision by the user to vouch for their content.
     * (DLP-standard action names: block / allow.)
     */
    attachments: z.enum(["block", "allow"]).default("block"),
    /** Transparent mode only. False is hook-only: no outbound HTTP/WS/SDK
     * admission, metadata inspection, final body scan, or provider transform.
     * Content/tool hooks remain, with optional best-effort ingress restoration
     * for successfully prepared session/kind/model scopes. Unknown replies
     * stay literal. Omission preserves the full wire-protection layer. */
    wireProtection: z.boolean().optional(),
    /**
     * W2 (2026-10-07): opt-in encrypted mapping persistence for transparent
     * mode. Default off — with persistence disabled every existing behavior
     * and guarantee is unchanged (memory-only, process-lifetime mappings).
     * Enabled: mappings persist encrypted (per-entry AES-256-GCM) in a
     * SQLite store and rehydrate after restarts. Key custody resolves down
     * the ladder OS keychain → explicit keyfile → memory-only degrade;
     * conversations are never blocked by a missing key.
     */
    persistence: z
      .object({
        enabled: z.boolean().default(false),
        /** Session TTL in days; 0 = never expire (manual forget only). */
        ttlDays: z.number().int().min(0).max(3650).default(7),
        /** Store path. Default: ~/.local/share/leakshield/SGP.db */
        path: z.string().min(1).optional(),
        /** Opt-in weaker fallback when no OS keychain is available. */
        keyFile: z.boolean().default(false),
        /** Overrides the default keyfile location. */
        keyfilePath: z.string().min(1).optional(),
      })
      .default({}),
  })
  .refine((options) => !options.deidentify || options.mode === "redact", {
    message: "deidentify requires mode 'redact'",
  })
  .refine((options) => options.mode !== "transparent" || !options.envQueries, {
    message: "envQueries is not supported in mode 'transparent'",
  })
  .refine((options) => options.attachments === "block" || options.mode === "transparent", {
    message: 'attachments "allow" requires mode "transparent"',
  })
  .refine((options) => options.wireProtection === undefined || options.mode === "transparent", {
    message: 'wireProtection requires mode "transparent"',
  })
  .refine((options) => !options.persistence.enabled || options.mode === "transparent", {
    message: 'persistence requires mode "transparent"',
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
