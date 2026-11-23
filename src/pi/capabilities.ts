/**
 * pi's declared coverage, printed by `leakshield --doctor`.
 *
 * The extension wraps `globalThis.fetch`, so every wire format that pi sends
 * through fetch is masked by the same guard, including compaction, retries and
 * titles. Providers whose API does not use fetch are refused before the run;
 * Codex's WebSocket transport is one of them.
 */
import type { HostCapabilities } from "../types/capabilities.js";

export const PI_CAPABILITIES: HostCapabilities = {
  host: "pi",
  verifiedVersion: "1.6.0",
  interception: "in-process-fetch",
  transports: {
    http: {
      state: "protected",
      mechanism: "the guard's fetch wrapper masks openai-completions, openai-responses and anthropic-messages bodies",
      evidence: "tests/pi-guard.test.ts",
    },
    websocket: {
      state: "refused",
      mechanism: "the model check refuses openai-codex-responses before any request is dispatched",
      evidence: "tests/pi-guard.test.ts",
      note: "Codex is the host's WebSocket transport; OpenCode has a frame adapter, pi refuses it.",
    },
    nonFetch: {
      state: "refused",
      mechanism: "an API outside the three fetch formats (Bedrock converse-stream, google-generative-ai, …) refuses the run",
      evidence: "scripts/e2e/run-pi-compaction-refusal.mjs",
      note: "A model switch to such an API cancels the run; a non-fetch request that escaped notice would not be cancellable.",
    },
  },
  surfaces: {
    toolArgs: {
      state: "protected",
      mechanism: "the tool gate restores known safe arguments per tool and refuses unknown tools",
      evidence: "tests/pi-tool-policy.test.ts",
    },
    replyDisplay: {
      state: "protected",
      mechanism: "the fetch wrapper restores placeholders in JSON and SSE replies attributed to a masked request",
      evidence: "tests/pi-extension.test.ts",
    },
    background: {
      state: "protected",
      mechanism: "the same fetch wrapper covers compaction, retries and titles",
      evidence: "docs/evidence/2026-11-23-pi-fetch-gap-audit.md",
    },
  },
  credentials: "in-process",
  persistence: "opt-in",
  residuals: [
    "transports.http: an extension loaded before LeakShield can keep the raw fetch and reach the provider unmasked; pi's own requests stay guarded.",
    "transports.http: a run without the extension, or with --no-extensions, is not protected at all.",
    "surfaces.toolArgs: shell restoration covers a literal argument; pipelines, chaining, expansions and a tokenized redirect target refuse the call.",
  ],
};
