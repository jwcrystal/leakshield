import type { Hooks } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import {
  protectText,
  protectUnknownStrings,
  type IngressMode,
} from "./decision/ingress.js";
import type { GuardConfig } from "./types.js";

const INITIALIZATION_ERROR =
  "Sensitive Guard initialization failed. Model request blocked before content was sent.";

function blockedAttachment(part: Part): Part {
  return {
    id: part.id,
    sessionID: part.sessionID,
    messageID: part.messageID,
    type: "text",
    text: "[Sensitive Guard blocked an attachment. Attachments are not forwarded because their content cannot be safely scanned.]",
    synthetic: true,
  };
}

function protectParts(parts: readonly Part[], config: GuardConfig, mode: IngressMode): Part[] {
  return parts.map((part) => {
    if (part.type === "file") return blockedAttachment(part);
    if (part.type === "text") {
      const protectedText = protectText(part.text, config, { mode, context: "message text" });
      return { ...part, text: protectedText.text };
    }
    if (part.type === "reasoning") {
      const protectedText = protectText(part.text, config, { mode, context: "reasoning text" });
      return { ...part, text: protectedText.text };
    }
    if (part.type === "tool") {
      return {
        ...part,
        state: protectUnknownStrings(part.state, config, { mode, context: "tool history" }) as typeof part.state,
      };
    }
    if (part.type === "subtask") {
      const protectedPrompt = protectText(part.prompt, config, { mode, context: "subtask prompt" });
      const protectedDescription = protectText(part.description, config, { mode, context: "subtask description" });
      return { ...part, prompt: protectedPrompt.text, description: protectedDescription.text };
    }
    if (part.type === "retry") {
      return {
        ...part,
        error: protectUnknownStrings(part.error, config, { mode, context: "retry error" }) as typeof part.error,
      };
    }
    return part;
  });
}

export function createHooks(config: GuardConfig, mode: IngressMode): Hooks {
  return {
    "chat.message": async (_input, output) => {
      output.parts.splice(0, output.parts.length, ...protectParts(output.parts, config, mode));
    },
    "tool.execute.after": async (_input, output) => {
      const protectedTitle = protectText(output.title, config, { mode, context: "tool title" });
      const protectedOutput = protectText(output.output, config, { mode, context: "tool output" });
      output.title = protectedTitle.text;
      output.output = protectedOutput.text;
      output.metadata = protectUnknownStrings(output.metadata, config, { mode, context: "tool metadata" });
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      for (const message of output.messages) {
        message.parts.splice(0, message.parts.length, ...protectParts(message.parts, config, mode));
      }
    },
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.splice(
        0,
        output.system.length,
        ...output.system.map((text) => protectText(text, config, { mode, context: "system prompt" }).text),
      );
    },
    "tool.definition": async (_input, output) => {
      output.description = protectText(output.description, config, { mode, context: "tool description" }).text;
      output.parameters = protectUnknownStrings(output.parameters, config, { mode, context: "tool parameters" });
    },
  };
}

export function createFailClosedHooks(): Hooks {
  const blockRequest = async (): Promise<never> => {
    throw new Error(INITIALIZATION_ERROR);
  };

  return {
    "chat.message": blockRequest,
    "tool.execute.after": blockRequest,
    "experimental.chat.messages.transform": blockRequest,
    "experimental.chat.system.transform": blockRequest,
    "tool.definition": blockRequest,
  };
}
