import type { Hooks } from "@opencode-ai/plugin";

const INITIALIZATION_ERROR =
  "LeakShield initialization failed, so the request was blocked before anything was sent.";

/** Hooks that reject every model request. `message` names the reason shown to
 * the user; the default is the generic initialization failure. */
export function createFailClosedHooks(message: string = INITIALIZATION_ERROR): Hooks {
  const blockRequest = async (): Promise<never> => {
    throw new Error(message);
  };

  return {
    "chat.message": blockRequest,
    "tool.execute.after": blockRequest,
    "experimental.chat.messages.transform": blockRequest,
    "experimental.chat.system.transform": blockRequest,
    "tool.definition": blockRequest,
  };
}
