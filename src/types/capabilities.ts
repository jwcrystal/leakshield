/**
 * Host capability declaration.
 *
 * Every host adapter declares, for each model egress and each local surface,
 * whether LeakShield protects it, refuses it, proves it does not exist, cannot
 * reach it, or has not audited it yet. The doctor prints the same declaration;
 * `docs/host-capabilities.md` explains the states and why they are shared.
 *
 * `assertCapabilities` is meant to run in tests, not at runtime: it checks that
 * evidence paths exist in a source checkout, which a published package does not
 * carry.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type CapabilityState = "protected" | "refused" | "not-present" | "outside" | "unknown";

export interface Capability {
  state: CapabilityState;
  /** The core handler this egress reaches, or where the request is refused. */
  mechanism: string;
  /** Required for protected and not-present; expected for refused. A repo-relative path. */
  evidence?: string;
  /** Residual risk or coverage limit; only what is true. */
  note?: string;
}

export interface HostCapabilities {
  /** "opencode" | "claude-code" | "pi" */
  host: string;
  /** The host version the rows were verified against. */
  verifiedVersion: string;
  interception: "in-process-fetch" | "in-process-host-hook" | "loopback-proxy" | "preload";
  transports: {
    /** Model HTTP: the three wire families, or the proxy's route. */
    http: Capability;
    websocket: Capability;
    /** smithy / gRPC / node:http / an SDK's built-in transport. */
    nonFetch: Capability;
  };
  surfaces: {
    /** The local tool execution boundary. */
    toolArgs: Capability;
    /** Assistant text restoration. */
    replyDisplay: Capability;
    /** Compaction / branch summary / title. */
    background: Capability;
  };
  credentials: "in-process" | "separated";
  persistence: "opt-in" | "none";
  /**
   * Load order, a disabled extension, an unsupported provider, …
   * Each entry starts with the row it qualifies, `<section>.<field>: `, so an
   * `outside` row can be traced to its residual by invariant 4.
   */
  residuals: string[];
}

export const CAPABILITY_ROWS = [
  "transports.http",
  "transports.websocket",
  "transports.nonFetch",
  "surfaces.toolArgs",
  "surfaces.replyDisplay",
  "surfaces.background",
] as const;

export type CapabilityRow = (typeof CAPABILITY_ROWS)[number];

export const CAPABILITY_ROW_TITLES: Readonly<Record<CapabilityRow, string>> = {
  "transports.http": "HTTP",
  "transports.websocket": "WebSocket",
  "transports.nonFetch": "non-fetch",
  "surfaces.toolArgs": "tool args",
  "surfaces.replyDisplay": "reply",
  "surfaces.background": "background",
};

export function capabilityAt(capabilities: HostCapabilities, row: CapabilityRow): Capability {
  const [section, field] = row.split(".") as ["transports" | "surfaces", string];
  return capabilities[section][field as keyof HostCapabilities[typeof section]] as Capability;
}

export interface CapabilityVerdict {
  verdict: "PROTECTED" | "PARTIAL";
  unknown: CapabilityRow[];
  outside: CapabilityRow[];
}

/**
 * `unknown` and `outside` rows cap the host at PARTIAL. A host can still be
 * PARTIAL for install-level reasons (hook-first mode, load order); this only
 * answers what the declaration itself allows.
 */
export function capabilityVerdict(capabilities: HostCapabilities): CapabilityVerdict {
  const unknown = CAPABILITY_ROWS.filter((row) => capabilityAt(capabilities, row).state === "unknown");
  const outside = CAPABILITY_ROWS.filter((row) => capabilityAt(capabilities, row).state === "outside");
  return {
    verdict: unknown.length > 0 || outside.length > 0 ? "PARTIAL" : "PROTECTED",
    unknown,
    outside,
  };
}

export class CapabilityInvariantError extends Error {
  constructor(host: string, message: string) {
    super(`${host}: ${message}`);
    this.name = "CapabilityInvariantError";
  }
}

export interface CapabilityAudit {
  /** Repository root that evidence paths are resolved against. */
  root?: string;
  /** Injectable for tests that declare synthetic evidence. */
  fileExists?(filePath: string): boolean;
}

/** Where `refused` evidence may point: a runtime test or an end-to-end record. */
const RUNTIME_EVIDENCE = /^(tests\/|scripts\/e2e\/|docs\/evidence\/)/;

export function assertCapabilities(
  capabilities: HostCapabilities,
  audit: CapabilityAudit = {},
): void {
  const host = capabilities.host;
  const root = audit.root ?? fileURLToPath(new URL("../../", import.meta.url));
  const fileExists = audit.fileExists ?? ((filePath: string) => fs.existsSync(path.resolve(root, filePath)));
  const fail = (message: string): never => {
    throw new CapabilityInvariantError(host, message);
  };

  if (host.length === 0) fail("host is empty");
  if (capabilities.verifiedVersion.length === 0) fail("verifiedVersion is empty");
  if (capabilities.credentials !== "in-process" && capabilities.credentials !== "separated") {
    fail(`credentials must be declared explicitly (got ${String(capabilities.credentials)})`);
  }
  if (capabilities.persistence !== "opt-in" && capabilities.persistence !== "none") {
    fail(`persistence must be declared explicitly (got ${String(capabilities.persistence)})`);
  }

  for (const row of CAPABILITY_ROWS) {
    const capability = capabilityAt(capabilities, row);
    const state = capability.state;
    if (!["protected", "refused", "not-present", "outside", "unknown"].includes(state)) {
      fail(`${row} has an unknown state ${String(state)}`);
    }
    if (capability.mechanism.length === 0) fail(`${row} has no mechanism`);

    if (state === "protected" || state === "not-present") {
      if (capability.evidence === undefined) fail(`${row} is ${state} without an evidence path`);
      else if (!fileExists(capability.evidence)) fail(`${row} evidence does not exist: ${capability.evidence}`);
    }

    if (state === "refused") {
      const evidence = capability.evidence;
      if (evidence === undefined) fail(`${row} is refused without a runtime test or evidence`);
      else if (!fileExists(evidence)) fail(`${row} evidence does not exist: ${evidence}`);
      else if (!RUNTIME_EVIDENCE.test(evidence)) {
        fail(`${row} is refused but ${evidence} is not a runtime test or an e2e record`);
      }
    }

    if (state === "outside") {
      if (capability.note === undefined || capability.note.length === 0) {
        fail(`${row} is outside without a note explaining the residual`);
      }
      if (!capabilities.residuals.some((entry) => entry.startsWith(`${row}: `))) {
        fail(`${row} is outside but has no matching entry in residuals`);
      }
    }

    if (state === "unknown" && !/#\d+/.test(capability.note ?? "")) {
      fail(`${row} is unknown without a tracking issue in its note`);
    }
  }
}
