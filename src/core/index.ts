/**
 * Experimental host-neutral LeakShield core entrypoint.
 *
 * This subpath is an incremental packaging boundary, not a separate npm
 * package. Tool restoration requires an explicit HostToolPolicy; without one, token-bearing tool calls are refused.
 *
 * Do not import OpenCode or Claude Code adapters from this module.
 */
export {
  createGuardCore,
  requireSessionID,
  INITIALIZATION_ERROR,
  NO_REASON_HINT,
  PROTECT_FAILED_ERROR,
  ATTRIBUTION_ERROR,
  UNSUPPORTED_ROUTE_ERROR,
  type GuardCore,
  type GuardPersistenceOptions,
  type HostToolPolicy,
  type RecordLike,
} from "./session-guard.js";
