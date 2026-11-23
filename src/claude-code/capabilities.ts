/**
 * Claude Code's declared coverage, printed by `leakshield --doctor`.
 *
 * The proxy routes by endpoint, so every Messages request that reaches
 * ANTHROPIC_BASE_URL is masked regardless of why Claude Code sent it. Traffic
 * that never reaches the base URL (Bedrock, Vertex, Foundry, cloud sessions,
 * WebFetch's domain check) has no interception point: that is `outside`, and
 * the doctor warns about it. Tool-argument restoration does not exist yet, and
 * background requests have not been probed separately, so both stay `unknown`.
 */
import type { HostCapabilities } from "../types/capabilities.js";

export const CLAUDE_CODE_CAPABILITIES: HostCapabilities = {
  host: "claude-code",
  verifiedVersion: "2.1.321",
  interception: "loopback-proxy",
  transports: {
    http: {
      state: "protected",
      mechanism: "core.onHttpRequest / onHttpResponse on POST /v1/messages and /v1/messages/count_tokens",
      evidence: "tests/claude-code-proxy.test.ts",
      note: "Anthropic Messages only. A body on another route is blocked, not forwarded.",
    },
    websocket: {
      state: "not-present",
      mechanism: "no WS endpoint at the base URL; the proxy answers only HTTP routes",
      evidence: "docs/evidence/2026-11-21-claude-code-proxy.md",
      note: "The recorded run reached the upstream with POST /v1/messages and HEAD /api/hello only.",
    },
    nonFetch: {
      state: "outside",
      mechanism: "none: Bedrock, Vertex and Foundry, and Claude Code cloud sessions, do not use ANTHROPIC_BASE_URL",
      note: "The host offers no hook on these paths. The doctor warns when a provider or host-managed setting is enabled.",
    },
  },
  surfaces: {
    toolArgs: {
      state: "unknown",
      mechanism: "no tool gate yet: tool_use input keeps placeholders, and a tool receives the placeholder",
      note: "Restoration at tool execution through Claude Code hooks is issue #91.",
    },
    replyDisplay: {
      state: "protected",
      mechanism: "core.onHttpResponse restores assistant text in JSON and SSE replies, including a split placeholder",
      evidence: "tests/claude-code-proxy.test.ts",
    },
    background: {
      state: "unknown",
      mechanism: "compaction and summaries travel on /v1/messages, the same route the proxy masks",
      note: "No separate probe has been run (#111), so the row is not claimed as protected.",
    },
  },
  credentials: "separated",
  persistence: "none",
  residuals: [
    "transports.nonFetch: Bedrock, Vertex, Foundry and Claude Code cloud sessions bypass the base URL entirely.",
    "transports.http: WebFetch's domain check sends the hostname, without the path, straight to api.anthropic.com; set skipWebFetchPreflight to turn it off.",
    "surfaces.replyDisplay: after a proxy restart, assistant history is masked under new placeholders and old ones can no longer be restored.",
  ],
};
