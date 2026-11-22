/**
 * Experimental host-neutral LeakShield core entrypoint.
 *
 * This subpath is an incremental packaging boundary, not a separate npm
 * package. Tool restoration needs a host-supplied `HostToolPolicy`; without
 * one, every tool call that carries a placeholder is refused.
 *
 * Do not import OpenCode or Claude Code adapters from this module.
 */
export {
  createGuardCore,
  requireSessionID,
  INITIALIZATION_ERROR,
  PROTECT_FAILED_ERROR,
  ATTRIBUTION_ERROR,
  UNSUPPORTED_ROUTE_ERROR,
  type GuardCore,
  type GuardPersistenceOptions,
  type HostToolPolicy,
  type RecordLike,
} from "./session-guard.js";
