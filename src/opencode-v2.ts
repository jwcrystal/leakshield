import { createHmac } from "node:crypto";
import type { Plugin as PluginNamespace } from "@opencode/plugin";
import {
  ContentHashCache,
  protectUnknownStrings,
  type IngressMode,
  type TextProtector,
} from "./decision/ingress.js";
import { deidentifyText } from "./decision/deidentify.js";
import type { EnvQueryService } from "./env-queries.js";
import { registerV2EnvTools } from "./opencode-env-tools.js";
import type { GuardConfig } from "./types.js";

type V2Plugin = PluginNamespace.Plugin;
type PluginContext = PluginNamespace.Context;

const INITIALIZATION_ERROR =
  "Sensitive Guard initialization failed. Model request blocked before content was sent.";

const BLOCKED_ATTACHMENT_NOTICE =
  "[Sensitive Guard blocked an attachment. Attachments are not forwarded because their content cannot be safely scanned.]";

/**
 * Structural views of the OpenCode v2 message schema. The scanner intentionally
 * duck-types parts so unknown or future part variants pass through untouched,
 * mirroring the V1 plugin behavior.
 */
type RecordLike = { [key: string]: unknown };

function isRecordLike(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null;
}

function protectString(
  text: unknown,
  config: GuardConfig,
  mode: IngressMode,
  context: string,
  protector: TextProtector,
): unknown {
  if (typeof text !== "string") return text;
  return protector(text, config, { mode, context }).text;
}

function protectToolResultValue(
  value: unknown,
  config: GuardConfig,
  mode: IngressMode,
  protector: TextProtector,
): unknown {
  if (!isRecordLike(value)) return value;
  if (value.type === "content" && Array.isArray(value.value)) {
    return {
      ...value,
      value: value.value.map((item) =>
        isRecordLike(item) && item.type === "text"
          ? { ...item, text: protectString(item.text, config, mode, "tool output", protector) }
          : item,
      ),
    };
  }
  return {
    ...value,
    value: protectUnknownStrings(value.value, config, { mode, context: "tool result" }, protector),
  };
}

function protectContentPart(
  part: unknown,
  config: GuardConfig,
  mode: IngressMode,
  protector: TextProtector,
): unknown {
  if (!isRecordLike(part)) return part;
  switch (part.type) {
    case "text":
      return { ...part, text: protectString(part.text, config, mode, "message text", protector) };
    case "reasoning":
      // Encrypted-only reasoning is opaque provider state and is left intact.
      return { ...part, text: protectString(part.text, config, mode, "reasoning text", protector) };
    case "media":
      return { type: "text", text: BLOCKED_ATTACHMENT_NOTICE };
    case "tool-call":
      return {
        ...part,
        input: protectUnknownStrings(part.input, config, { mode, context: "tool call input" }, protector),
      };
    case "tool-result":
      return {
        ...part,
        result: protectToolResultValue(part.result, config, mode, protector),
      };
    default:
      return part;
  }
}

function protectContentParts(
  parts: readonly unknown[],
  config: GuardConfig,
  mode: IngressMode,
  protector: TextProtector,
): unknown[] {
  return parts.map((part) => protectContentPart(part, config, mode, protector));
}

function protectRequestEvent(
  event: RecordLike,
  config: GuardConfig,
  mode: IngressMode,
  protector: TextProtector,
): void {
  if (Array.isArray(event.system)) {
    for (const part of event.system) {
      if (isRecordLike(part) && part.type === "text") {
        part.text = protectString(part.text, config, mode, "system prompt", protector);
      }
    }
  }
  if (Array.isArray(event.messages)) {
    for (const message of event.messages) {
      if (!isRecordLike(message)) continue;
      const parts = message.content;
      if (Array.isArray(parts)) {
        message.content = protectContentParts(parts, config, mode, protector);
      }
    }
  }
  if (isRecordLike(event.tools)) {
    for (const tool of Object.values(event.tools)) {
      if (!isRecordLike(tool)) continue;
      tool.description = protectString(tool.description, config, mode, "tool description", protector);
      tool.input = protectUnknownStrings(tool.input, config, { mode, context: "tool parameters" }, protector);
    }
  }
}

function protectPromptEvent(
  event: RecordLike,
  config: GuardConfig,
  mode: IngressMode,
  protector: TextProtector,
): void {
  const prompt = event.prompt;
  if (!isRecordLike(prompt)) return;
  prompt.text = protectString(prompt.text, config, mode, "message text", protector);
  if (Array.isArray(prompt.files) && prompt.files.length > 0) {
    prompt.files = [];
    const text = typeof prompt.text === "string" ? prompt.text : "";
    prompt.text = text ? `${text}\n\n${BLOCKED_ATTACHMENT_NOTICE}` : BLOCKED_ATTACHMENT_NOTICE;
  }
}

function protectToolAfterEvent(
  event: RecordLike,
  config: GuardConfig,
  mode: IngressMode,
  protector: TextProtector,
): void {
  if (event.status !== "completed") return;
  const result = event.result;
  if (!isRecordLike(result)) return;
  const next: RecordLike = { ...result };
  if (typeof result.content === "string") {
    next.content = protector(result.content, config, { mode, context: "tool output" }).text;
  } else if (Array.isArray(result.content)) {
    next.content = result.content.map((item) =>
      isRecordLike(item) && item.type === "text"
        ? { ...item, text: protectString(item.text, config, mode, "tool output", protector) }
        : item,
    );
  }
  next.output = protectUnknownStrings(result.output, config, { mode, context: "tool output" }, protector);
  next.metadata = protectUnknownStrings(result.metadata, config, { mode, context: "tool metadata" }, protector);
  event.result = next;
}

async function registerProtectionHooks(
  ctx: PluginContext,
  config: GuardConfig,
  mode: IngressMode,
  protectorForEvent: (event: unknown) => TextProtector,
): Promise<void> {
  await ctx.session.hook("prompt", (event) => {
    protectPromptEvent(event as unknown as RecordLike, config, mode, protectorForEvent(event));
  });
  const onRequest = (event: unknown) => {
    protectRequestEvent(event as RecordLike, config, mode, protectorForEvent(event));
  };
  await ctx.session.hook("context", onRequest);
  await ctx.session.hook("compaction", onRequest);
  await ctx.session.hook("generate", onRequest);
  await ctx.session.hook("title", onRequest);
  await ctx.tool.hook("execute.after", (event) => {
    protectToolAfterEvent(event as unknown as RecordLike, config, mode, protectorForEvent(event));
  });
}

async function registerFailClosedHooks(ctx: PluginContext): Promise<void> {
  const blockRequest = async (): Promise<never> => {
    throw new Error(INITIALIZATION_ERROR);
  };
  await ctx.session.hook("prompt", blockRequest);
  await ctx.session.hook("context", blockRequest);
  await ctx.session.hook("compaction", blockRequest);
  await ctx.session.hook("generate", blockRequest);
  await ctx.session.hook("title", blockRequest);
  await ctx.tool.hook("execute.after", blockRequest);
}

export interface DeidentifyOptions {
  /**
   * Master key, one per plugin setup (= one OpenCode server process); held in
   * memory only. Per-session placeholder keys are derived from it via
   * HMAC-SHA256 so placeholders from different sessions cannot be linked.
   */
  sessionKey: Buffer;
}

const PLACEHOLDER_SESSION_LIMIT = 256;
const PLACEHOLDER_CAPACITY_ERROR =
  "Sensitive Guard de-identification session capacity reached; existing placeholders remain valid. Continue in an active session.";

type PlaceholderSessionState = { key: Buffer; placeholders: Set<string> };

/** Creates the OpenCode v2 `setup(ctx)` implementation for the given configuration. */
export function createV2Setup(
  config: GuardConfig,
  mode: IngressMode,
  deidentify?: DeidentifyOptions,
  /** When set, the readonly env query tools are registered (opt-in `envQueries`). */
  envQueries?: EnvQueryService,
): V2Plugin["setup"] {
  const cache = new ContentHashCache();
  const masterKey = deidentify?.sessionKey;

  const placeholderSessions = new Map<string, PlaceholderSessionState>();
  const placeholderStateFor = (
    event: unknown,
  ): { sessionID: string; state: PlaceholderSessionState; retained: boolean } | undefined => {
    if (!masterKey) return undefined;
    const sessionID =
      isRecordLike(event) && typeof event.sessionID === "string" ? event.sessionID : "";
    const retained = placeholderSessions.get(sessionID);
    return {
      sessionID,
      state:
        retained ?? {
          key: sessionID
            ? createHmac("sha256", masterKey).update(`session:${sessionID}`).digest()
            : masterKey,
          placeholders: new Set(),
        },
      retained: retained !== undefined,
    };
  };
  const carriesOwnedPlaceholder = (text: string, placeholders: Set<string>): boolean => {
    for (const placeholder of placeholders) {
      if (text.includes(placeholder)) return true;
    }
    return false;
  };

  // The plain protector: history cache composition — redact results stay
  // uncached and block decisions are final (fail-closed); only allow decisions
  // reuse the cache. The cache is shared across sessions, which is safe: it
  // stores only allow/block decisions, never text or placeholders.
  const baseProtector: TextProtector = (text, currentConfig, options) =>
    cache.protect(text, currentConfig, options);

  // Per-event protector: when de-identify is enabled, bind the session key
  // carried by this event into the protector before walking it. deidentifyText
  // keeps the same cache composition (allow → cache, block/redact → final and
  // uncached), so the cache's decision always agrees with the direct
  // computation.
  const protectorForEvent = (event: unknown): TextProtector => {
    if (!deidentify) return baseProtector;
    const session = placeholderStateFor(event);
    if (!session) return baseProtector;
    return (text, currentConfig, options) => {
      const result = deidentifyText(
        text,
        currentConfig,
        session.state.key,
        options,
        session.state.placeholders,
      );
      if (!session.retained && session.state.placeholders.size > 0) {
        if (placeholderSessions.size >= PLACEHOLDER_SESSION_LIMIT) {
          throw new Error(PLACEHOLDER_CAPACITY_ERROR);
        }
        placeholderSessions.set(session.sessionID, session.state);
        session.retained = true;
      }
      if (result.action !== "allow") return result;
      return carriesOwnedPlaceholder(text, session.state.placeholders)
        ? result
        : cache.protect(text, currentConfig, options);
    };
  };

  return async (ctx) => {
    await registerProtectionHooks(ctx, config, mode, protectorForEvent);
    if (envQueries) {
      await registerV2EnvTools(ctx, envQueries);
    }
  };
}

/** Creates a fail-closed OpenCode v2 `setup(ctx)` that blocks every protected operation. */
export function createFailClosedV2Setup(): V2Plugin["setup"] {
  return registerFailClosedHooks;
}
