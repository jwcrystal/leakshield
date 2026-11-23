/**
 * OpenCode's declared coverage, printed by `leakshield --doctor`.
 *
 * The HTTP and WebSocket rows hold only in transparent mode with wire
 * protection on; hook-first installs register no outbound hooks and report
 * PARTIAL for install-level reasons instead. Non-fetch transports are not
 * audited yet, so the host is capped at PARTIAL until a probe closes that row.
 */
import type { HostCapabilities } from "../../types/capabilities.js";

export const OPENCODE_CAPABILITIES: HostCapabilities = {
  host: "opencode",
  verifiedVersion: "2.2.5",
  interception: "in-process-host-hook",
  transports: {
    http: {
      state: "protected",
      mechanism: "core.onHttpRequest over the host's http.request hook (transparent mode, wire protection on)",
      evidence: "tests/opencode-transparent.test.ts",
      note: "Hook-first (wireProtection: false) registers no outbound hook: later-added content can leave unmasked and the doctor reports PARTIAL.",
    },
    websocket: {
      state: "protected",
      mechanism: "core.onWsHandshake / onWsSend over experimental.ws.* (Responses family, wire protection on)",
      evidence: "tests/opencode-transparent-ws.test.ts",
      note: "Responses-family flat response.create frames only; other dialects are not adapted.",
    },
    nonFetch: {
      state: "unknown",
      mechanism: "no probe yet for Bedrock, Vertex or SDK-internal transports",
      note: "Unaudited (#110). The OpenCode verdict stays PARTIAL until a probe records what these transports carry.",
    },
  },
  surfaces: {
    toolArgs: {
      state: "protected",
      mechanism: "the tool gate restores known safe arguments and refuses unsafe mappings",
      evidence: "tests/opencode-tool-policy.test.ts",
    },
    replyDisplay: {
      state: "protected",
      mechanism: "core.onHttpResponse / onWsReceive, attributed to the masked request",
      evidence: "tests/opencode-transparent-recovery.test.ts",
    },
    background: {
      state: "protected",
      mechanism: "core.protectRequestKind on the context, compaction, generate and title payload hooks",
      evidence: "tests/opencode-transparent.test.ts",
    },
  },
  credentials: "in-process",
  persistence: "opt-in",
  residuals: [
    "transports.http: hook-first installs (wireProtection: false) register no outbound HTTP hook; /alpha/generate is untouched there and refused with wire protection on.",
    "surfaces.toolArgs: a tool holding a placeholder can send it; curl and http restore inside an argument by design.",
  ],
};
