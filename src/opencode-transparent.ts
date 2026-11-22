/**
 * OpenCode v2 transparent pseudonymization session guard (issue #22).
 *
 * One guard owns exactly ONE pseudonymizer service (bounded per setup, no
 * session fallback, no TTL, no eviction) and its own hook registrations and
 * disposal. Protection model:
 *
 * - The four model-request kinds (`context`, `compaction`, `generate`,
 *   `title`) protect an atomic snapshot (system, messages, options, tools
 *   schema) with `protectJson` and publish it back only after the whole
 *   transaction succeeds — never piecewise in place, never partial.
 * - Wire protection registers outbound HTTP/WS and SDK admission hooks.
 *   Explicit false is hook-only: none of those outbound hooks is registered.
 *   Inbound HTTP/WS restoration is best-effort in both modes; hook-only uses
 *   the host's session/kind/model and successful content preparation, not an
 *   outgoing transport registration, to select the local mapping.
 * - Native Responses-family WebSocket routes restore display frames; the same
 *   wireProtection switch controls outbound admission and masking. Unknown
 *   inbound protocols stay literal. SDKs honoring injected HTTP fetch reuse
 *   the wire-protected HTTP hooks; hook-only makes no transport guarantee.
 * - `tool:execute.before` restores registered tokens in tool arguments so local
 *   tools run with the real values (the model never sees them). Restoration is
 *   deep over the argument tree and keeps keys/types. Shell-like tools accept
 *   complete literal argument words in a single simple command; POSIX quoting
 *   and one static trailing output redirect are supported. Expansion, control
 *   syntax, unsafe quote-breaking originals and tokenized redirect targets
 *   refuse the affected call. Token-free calls pass through unchanged.
 *
 * Deliberately NOT registered in transparent mode: `session:prompt` (prompt
 * admission and local persistence keep originals by design — protection is at
 * the model boundary), `session:model.request` (routing/headers only; no
 * content is exposed there to scan), `tool:execute.after` (local tool results
 * stay original; their outbound replay is protected by the request kinds).
 *
 * The public V2 `session.deleted` event releases that session's memory and
 * response attribution. Idle/completed sessions retain mappings for resume;
 * there is no TTL or LRU eviction of live mappings. Disposal clears all RAM.
 */

import { types } from "node:util";
import type { Plugin as PluginNamespace } from "@opencode/plugin";
import {
  ATTRIBUTION_ERROR,
  createGuardCore,
  INITIALIZATION_ERROR,
  PROTECT_FAILED_ERROR,
  requireSessionID,
  UNSUPPORTED_ROUTE_ERROR,
  type GuardPersistenceOptions,
  type RecordLike,
} from "./core/session-guard.js";
import type { GuardConfig } from "./types.js";
import { createAISDKTransportAdmission } from "./opencode-transparent-aisdk.js";
import { opencodeToolPolicy } from "./opencode-tool-policy.js";

export type { GuardPersistenceOptions } from "./core/session-guard.js";

type V2Plugin = PluginNamespace.Plugin;
type PluginContext = PluginNamespace.Context;

export interface TransparentSessionGuard {
  /** OpenCode v2 `setup(ctx)` implementation. */
  readonly setup: V2Plugin["setup"];
  /**
   * Disposes every registration this setup made (reverse order) and clears
   * every session mapping the guard issued. Idempotent.
   */
  readonly dispose: () => Promise<void>;
}

/** Runs pending disposals (best effort, reverse order) without throwing. */
async function runDisposals(disposals: Array<() => Promise<void>>): Promise<void> {
  for (let i = disposals.length - 1; i >= 0; i--) {
    try {
      await disposals[i]();
    } catch {
      // Continue clearing remaining registrations.
    }
  }
  disposals.length = 0;
}

/**
 * Creates a fail-closed guard whose every hook refuses all operations. Exported
 * so the plugin entry can arm it for transparent mode when setup fails before
 * (or during) guard construction: a transparent fallback must cover the
 * transport routes (http/ws/aisdk) in wire mode. Hook-only failures refuse
 * content/tool dispatch without introducing new transport registrations.
 */
export function createFailClosedTransparentGuard(wireProtection = true): TransparentSessionGuard {
  const disposals: Array<() => Promise<void>> = [];
  const refuse = (): never => {
    throw new Error(INITIALIZATION_ERROR);
  };
  return {
    setup: async (ctx: PluginContext) => {
      try {
        const contentHooks = ["context", "compaction", "generate", "title"] as const;
        const wireHooks = [
          "http.request",
          "http.response",
          "experimental.ws.handshake",
          "experimental.ws.send",
          "experimental.ws.receive",
        ] as const;
        for (const name of [...contentHooks, ...(wireProtection ? wireHooks : [])]) {
          disposals.push((await ctx.session.hook(name, refuse)).dispose);
        }
        if (wireProtection) {
          disposals.push((await ctx.aisdk.hook("sdk", refuse)).dispose);
          disposals.push((await ctx.aisdk.hook("language", refuse)).dispose);
        }
        disposals.push((await ctx.tool.hook("execute.before", refuse)).dispose);
      } catch (error) {
        await runDisposals(disposals);
        throw error;
      }
    },
    dispose: () => runDisposals(disposals),
  };
}

/**
 * Creates the transparent session guard for one plugin setup (= one OpenCode
 * process): the host-independent core (`core/session-guard.ts`) plus this
 * layer's hook registrations and disposal.
 */
export function createTransparentSessionGuard(
  config: GuardConfig,
  attachmentsPolicy: "block" | "allow" = "block",
  wireProtection = true,
  persistence?: GuardPersistenceOptions,
): TransparentSessionGuard {
  const core = createGuardCore(config, attachmentsPolicy, wireProtection, persistence, {}, opencodeToolPolicy);
  if (core === null) return createFailClosedTransparentGuard(wireProtection);
  const disposals: Array<() => Promise<void>> = [];
  const aiSDK = createAISDKTransportAdmission(wireProtection);
  return {
    setup: async (ctx: PluginContext) => {
      try {
        for (const kind of ["context", "compaction", "generate", "title"] as const) {
          disposals.push(
            (
              await ctx.session.hook(kind, (event) => {
                core.protectRequestKind(event as unknown as RecordLike, kind === "context" ? "primary" : kind);
              })
            ).dispose,
          );
        }
        if (wireProtection) {
          disposals.push(
            (
              await ctx.session.hook("http.request", (event) => {
                return core.onHttpRequest(event as unknown as RecordLike);
              })
            ).dispose,
          );
        }
        try {
          disposals.push(
            (
              await ctx.session.hook("http.response", (event) => {
                return core.onHttpResponse(event as unknown as RecordLike);
              })
            ).dispose,
          );
        } catch (error) {
          if (wireProtection) throw error;
          core.noticeOnce("HTTP reply restoration hook unavailable; content and tool hooks remain active");
        }
        const socketHooks = wireProtection
          ? ["experimental.ws.handshake", "experimental.ws.send", "experimental.ws.receive"] as const
          : ["experimental.ws.receive"] as const;
        for (const name of socketHooks) {
          try {
            disposals.push(
              (
              await ctx.session.hook(name, async (input) => {
                const event = input as unknown as RecordLike;
                try {
                  const sessionID = requireSessionID(event);
                  core.assertTrackable(sessionID);
                  if (name === "experimental.ws.receive" && !core.hasSession(sessionID)) throw new Error(ATTRIBUTION_ERROR);
                  core.ensureSeeded(sessionID);
                  if (types.isProxy(event)) throw new Error(PROTECT_FAILED_ERROR);
                  if (name === "experimental.ws.handshake") core.webSocket.handshake(event);
                  else {
                    core.assertWritableDataProperty(event, "frame");
                    event.frame = name === "experimental.ws.send" ? await core.webSocket.send(event)
                      : wireProtection ? core.webSocket.receive(event) : core.webSocket.receiveOnly(event);
                  }
                  core.track(sessionID);
                  if (name === "experimental.ws.send") core.persistIfChanged(sessionID);
                } catch (error) {
                  if (name === "experimental.ws.receive") {
                    try {
                      const frame = core.webSocket.abandonResponse(event);
                      if (frame !== undefined) event.frame = frame;
                    } catch { /* Unwritable or invalid input stays untouched. */ }
                    core.noticeOnce("WS reply kept original after attribution or restoration failure; placeholders may remain literal");
                    return;
                  }
                  try { core.webSocket.reset(event); } catch { /* Invalid attribution has no lane to reset. */ }
                  // Adapter diagnostics are static. Do not surface native URL/
                  // Headers errors, which may embed a credential or raw value.
                  const message = error instanceof Error && error.message.startsWith("LeakShield ")
                    ? error.message : PROTECT_FAILED_ERROR;
                  throw new Error(`${message} [hook=${name}]`);
                }
              })
              ).dispose,
            );
          } catch (error) {
            if (wireProtection) throw error;
            core.noticeOnce("WS reply restoration hook unavailable; content and tool hooks remain active");
          }
        }
        for (const name of wireProtection ? ["sdk", "language"] as const : []) {
          disposals.push(
            (await ctx.aisdk.hook(name, (event) => {
              try { aiSDK.admit(event as unknown as RecordLike); }
              catch {
                throw new Error(`${UNSUPPORTED_ROUTE_ERROR} AI SDK providers must honor OpenCode's injected HTTP fetch. [hook=aisdk.${name}]`);
              }
            })).dispose,
          );
        }
        disposals.push(
          (
            await ctx.tool.hook("execute.before", (event) => {
              core.onToolBefore(event as unknown as RecordLike);
            })
          ).dispose,
        );
        // Public V2 events are an optional reclamation optimization: an absent
        // or failed stream retains mappings rather than evicting live state.
        // Subscribe only after all protection hooks have been armed.
        if (ctx.event?.subscribe) {
          const controller = new AbortController();
          disposals.push(async () => { controller.abort(); });
          void (async () => {
            try {
              for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
                if (controller.signal.aborted) break;
                if (event.type === "session.deleted") core.releaseSession(event.data.sessionID);
              }
              if (!controller.signal.aborted) core.noticeOnce("session lifecycle stream ended; mappings retained until unload");
            } catch {
              if (!controller.signal.aborted) core.noticeOnce("session lifecycle stream unavailable; mappings retained until unload");
            }
          })();
        }
      } catch (error) {
        // Registration failed partway: undo what was armed, then surface the
        // failure so the caller can fall back to its fail-closed setup.
        // R-round (F4.5): the store handle must not leak on this path.
        await runDisposals(disposals);
        core.closeResources();
        aiSDK.dispose();
        throw error;
      }
    },
    dispose: async () => {
      await runDisposals(disposals);
      aiSDK.dispose();
      core.dispose();
    },
  };
}
