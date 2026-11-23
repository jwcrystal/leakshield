/**
 * pi extension surface for LeakShield.
 *
 * Loaded by pi from an explicit extension path (`--pi-install` registers it in
 * pi's settings). It never masks provider traffic itself: the managed launcher
 * points pi at the loopback provider boundary, which owns masking and the
 * session mapping. The extension supplies the pi session identity, restores
 * placeholders at the local tool boundary, and restores display text.
 *
 * Unmanaged: when the launcher environment is absent the extension fails
 * closed. It refuses user input and every tool call, because an installed
 * extension that silently protected nothing would be worse than a loud stop.
 */
import { PSEUDONYM_TOKEN_PREFIX_V2 } from "../decision/pseudonymization.js";

export const PI_LAUNCH_URL_ENV = "LEAKSHIELD_PI_URL";
export const PI_LAUNCH_TOKEN_ENV = "LEAKSHIELD_PI_TOKEN";
export const PI_SESSION_HEADER = "x-leakshield-session";

const CONTROL_DISPLAY = "/control/display";
const CONTROL_TOOL = "/control/tool";
const CONTROL_TIMEOUT_MS = 5000;
const MAX_DISPLAY_TOKENS = 512;
const TOKEN_PATTERN = new RegExp(`${PSEUDONYM_TOKEN_PREFIX_V2.replace(/[[\]]/g, "\\$&")}[^\\]]+\\]`, "g");
const UNMANAGED_REASON =
  "LeakShield is installed but not active. Start pi through `leakshield pi` so provider requests are protected, or remove the extension.";

export interface PiSessionManager {
  getSessionId(): string;
  getEntries(): unknown;
}

export interface PiContext {
  sessionManager: PiSessionManager;
  hasUI?: boolean;
  ui?: { notify(message: string, level?: string): void };
}

export interface PiToolCallEvent {
  toolName: string;
  toolCallId?: string;
  input: unknown;
}

export interface PiMessageLike {
  role?: unknown;
  content?: unknown;
}

interface PiInputEvent {
  source?: unknown;
  text?: unknown;
}

interface PiHeaderEvent {
  headers: Record<string, string | null>;
}

type Handler = (event: never, ctx: PiContext) => unknown;

/** The subset of pi's ExtensionAPI this adapter registers. */
export interface PiExtensionApi {
  on(event: string, handler: Handler): void;
  registerMarkdownTransformer(
    transform: (markdown: string) => string,
    options?: { messageTypes?: string[] },
  ): void;
}

interface ExtensionConfig {
  origin: URL;
  token: string;
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

/** Returns null when the managed launcher did not provide a usable endpoint. */
export function readExtensionConfig(env: Readonly<Record<string, string | undefined>>): ExtensionConfig | null {
  const rawUrl = env[PI_LAUNCH_URL_ENV];
  const token = env[PI_LAUNCH_TOKEN_ENV];
  if (typeof rawUrl !== "string" || typeof token !== "string") return null;
  if (!/^[A-Za-z0-9._-]{16,}$/.test(token)) return null;
  let origin: URL;
  try {
    origin = new URL(rawUrl);
  } catch {
    return null;
  }
  if (origin.protocol !== "http:" || !isLoopback(origin.hostname)) return null;
  if (origin.search !== "" || origin.hash !== "") return null;
  return { origin, token };
}

function textOf(message: PiMessageLike): string {
  if (!Array.isArray(message.content)) return "";
  let text = "";
  for (const part of message.content) {
    if (part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text") {
      const value = (part as { text?: unknown }).text;
      if (typeof value === "string") text += value;
    }
  }
  return text;
}

export default function leakshieldPiExtension(pi: PiExtensionApi): void {
  const config = readExtensionConfig(process.env);

  if (config === null) {
    let announced = false;
    const announce = (ctx?: PiContext): void => {
      if (announced) return;
      announced = true;
      if (ctx?.ui) ctx.ui.notify(UNMANAGED_REASON, "error");
      else console.error(`[leakshield] ${UNMANAGED_REASON}`);
    };
    pi.on("session_start", (_event, ctx) => announce(ctx));
    pi.on("input", (event, ctx) => {
      const source = (event as PiInputEvent).source;
      if (source === "extension") return { action: "continue" };
      announce(ctx);
      return { action: "handled" };
    });
    pi.on("tool_call", () => {
      announce();
      return { block: true, reason: UNMANAGED_REASON, terminate: true };
    });
    return;
  }

  const { origin, token } = config;
  const display = new Map<string, string>();

  const call = async (path: string, body: unknown, sessionID: string): Promise<unknown> => {
    const response = await fetch(new URL(path, origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        [PI_SESSION_HEADER]: sessionID,
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`LeakShield control refused ${path}`);
    return response.json();
  };

  const remember = async (text: string, ctx: PiContext): Promise<void> => {
    if (display.size >= MAX_DISPLAY_TOKENS) return;
    const pending: string[] = [];
    for (const token of new Set(text.match(TOKEN_PATTERN) ?? [])) {
      if (display.has(token) || pending.length >= MAX_DISPLAY_TOKENS - display.size) continue;
      pending.push(token);
    }
    if (pending.length === 0) return;
    try {
      const result = (await call(CONTROL_DISPLAY, { tokens: pending }, ctx.sessionManager.getSessionId())) as {
        texts?: unknown;
      };
      const texts = result.texts;
      if (!Array.isArray(texts)) return;
      pending.forEach((token, index) => {
        const restored = texts[index];
        if (typeof restored === "string" && restored !== token) display.set(token, restored);
      });
    } catch {
      // Display is cosmetic; a placeholder that stays literal is safe.
    }
  };

  pi.registerMarkdownTransformer(
    (markdown) => markdown.replace(TOKEN_PATTERN, (token) => display.get(token) ?? token),
    { messageTypes: ["assistant", "assistant-thinking"] },
  );

  pi.on("session_start", async (_event, ctx) => {
    display.clear();
    await remember(JSON.stringify(ctx.sessionManager.getEntries()), ctx);
  });

  pi.on("before_provider_headers", (event, ctx) => {
    // The proxy refuses a provider request without this header. Never catch a
    // failure here: letting pi continue would leave the request unbound.
    (event as unknown as PiHeaderEvent).headers[PI_SESSION_HEADER] = ctx.sessionManager.getSessionId();
  });

  pi.on("message_end", async (event, ctx) => {
    const message = (event as { message?: PiMessageLike }).message;
    if (message === undefined || message.role !== "assistant") return;
    await remember(textOf(message), ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    const toolEvent = event as unknown as PiToolCallEvent;
    try {
      const restored = (await call(
        CONTROL_TOOL,
        { tool: toolEvent.toolName, input: toolEvent.input },
        ctx.sessionManager.getSessionId(),
      )) as { input?: unknown };
      if (restored.input === undefined) throw new Error("control response lost the tool input");
      if (toolEvent.input !== null && typeof toolEvent.input === "object" && restored.input !== null && typeof restored.input === "object") {
        Object.assign(toolEvent.input, restored.input);
      } else {
        toolEvent.input = restored.input;
      }
    } catch {
      return { block: true, reason: "LeakShield refused this tool call: placeholder restoration did not complete." };
    }
    return undefined;
  });

  pi.on("session_shutdown", () => {
    display.clear();
  });
}
