/**
 * pi extension: the in-process LeakShield boundary.
 *
 * Loaded by pi from an extension path (`-e <path>` or `settings.extensions`),
 * it wraps `globalThis.fetch` before any provider client is built, so every
 * model request on the three supported wire APIs is masked by the shared core
 * and assistant text is restored in the reply. Tool arguments are restored at
 * `tool_call`, and unknown tools are refused instead of receiving placeholders.
 *
 * There is no launcher: pi keeps its own provider configuration and credential.
 * Load order matters, because an extension loaded earlier can hold the raw
 * fetch; the doctor reports when LeakShield is not first.
 */
import { loadConfig } from "../../config/loader.js";
import type { GuardConfig } from "../../types.js";
import { createPiGuard, PROTECT_FAILED, type PiGuard, type PiGuardModel } from "./guard.js";
import { piPersistenceOptions } from "./persistence.js";

const GUARD_KEY = Symbol.for("leakshield.pi.guard");

export const PI_EXTENSION_ID = "leakshield-pi";
export const UNPROTECTED_NOTICE =
  "LeakShield blocked this run: provider requests for the selected model cannot be protected in-process.";

export interface PiSessionManager {
  getSessionId(): string;
}

export interface PiContext {
  sessionManager: PiSessionManager;
  model?: PiGuardModel;
  ui?: { notify(message: string, level?: string): void };
}

export interface PiToolCallEvent {
  toolName: string;
  toolCallId?: string;
  input: unknown;
}

export interface PiModelSelectEvent {
  model: PiGuardModel;
}

type Handler = (event: never, ctx: PiContext) => unknown;

/** The subset of pi's ExtensionAPI this adapter registers. */
export interface PiExtensionApi {
  on(event: string, handler: Handler): void;
}

function guardConfig(): GuardConfig {
  const config = loadConfig(process.env.LEAKSHIELD_CONFIG, process.cwd());
  return { ...config, settings: { ...config.settings, encoding_detection: true } };
}

function notice(ctx: PiContext | undefined, message: string): void {
  if (ctx?.ui) ctx.ui.notify(message, "error");
  else console.error(`[${PI_EXTENSION_ID}] ${message}`);
}

function refusalText(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("LeakShield ")) return error.message;
  return PROTECT_FAILED;
}

function installGuard(): PiGuard {
  const existing = (globalThis as Record<symbol, unknown>)[GUARD_KEY] as PiGuard | undefined;
  if (existing !== undefined) return existing;
  const guard = createPiGuard({ config: guardConfig(), persistence: piPersistenceOptions(process.env) });
  guard.install();
  Object.defineProperty(globalThis, GUARD_KEY, { value: guard, configurable: true });
  return guard;
}

export default function leakshieldPiExtension(pi: PiExtensionApi): void {
  const guard = installGuard();
  let refusal: string | null = guard.refusal;
  let announced: string | null = null;

  const announce = (ctx: PiContext | undefined, reason: string): void => {
    if (announced === reason) return;
    announced = reason;
    notice(ctx, reason);
  };

  const applyModel = (model: PiGuardModel | undefined, ctx: PiContext | undefined): void => {
    guard.setModel(model ?? null);
    refusal = guard.refusal;
    if (refusal === null) announced = null;
    else announce(ctx, refusal);
  };

  pi.on("session_start", (_event, ctx) => {
    guard.setSession(ctx.sessionManager.getSessionId());
    applyModel(ctx.model, ctx);
  });

  pi.on("model_select", (event, ctx) => {
    applyModel((event as PiModelSelectEvent).model, ctx);
  });

  // The model is re-read at each run so a switch that skipped `model_select`
  // cannot leave the guard bound to a previous provider.
  pi.on("before_agent_start", (_event, ctx) => {
    applyModel(ctx.model, ctx);
  });

  const cancelIfRefused = (ctx: PiContext | undefined): { cancel: true } | undefined => {
    if (refusal === null) return undefined;
    announce(ctx, refusal);
    return { cancel: true };
  };

  pi.on("input", (_event, ctx) => {
    // Re-read the model here too: this is the last hook before a run starts,
    // and `before_agent_start` cannot cancel one. Extension-authored input is
    // refused as well, because it can start a request on an API the guard
    // cannot see.
    applyModel(ctx.model, ctx);
    if (refusal === null) return { action: "continue" };
    announce(ctx, refusal);
    return { action: "handled" };
  });

  // Manual compaction and /tree summarization invoke the model without an
  // input or before_agent_start event, so they need their own refusal gate.
  pi.on("session_before_compact", (_event, ctx) => cancelIfRefused(ctx));
  pi.on("session_before_tree", (_event, ctx) => cancelIfRefused(ctx));

  pi.on("tool_call", (event, _ctx) => {
    const toolEvent = event as unknown as PiToolCallEvent;
    if (refusal !== null) return { block: true, reason: refusal, terminate: true };
    try {
      const restored = guard.restoreTool(toolEvent.toolName, toolEvent.input);
      if (restored !== toolEvent.input) toolEvent.input = restored;
    } catch (error) {
      return { block: true, reason: refusalText(error), terminate: true };
    }
    return undefined;
  });
}
