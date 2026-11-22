/** OpenCode-specific tool classification for the shared guard core.
 * Keep host tool names and degradation allowlists out of session-guard.ts.
 * Restoration itself remains transactional and fail-closed in the core.
 */
import { types } from "node:util";
import type { HostToolPolicy, RecordLike } from "./core/session-guard.js";
import {
  isShellTool,
  isShellKey,
  isCodeKey,
  keyPolicy,
  READ_ONLY_TOOLS,
} from "./core/tool-restore-policy.js";

/** OpenCode v2.2.5 Code Mode tool, with input {code: string}. */
const CODE_MODE_TOOL = "execute";

export const opencodeToolPolicy: HostToolPolicy = {
  isCodeModeCall(event: RecordLike): boolean {
    if (event.tool !== CODE_MODE_TOOL || event.input === null || typeof event.input !== "object" || types.isProxy(event.input)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(event.input, "code");
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string";
  },
  isShellTool,
  classifyField: keyPolicy,
  allowsDegradedRestore(tool, input): boolean {
    return READ_ONLY_TOOLS.has(tool) && !isShellTool(tool) &&
      !(input !== null && typeof input === "object" &&
        Object.keys(input).some((key) => isShellKey(key) || isCodeKey(key)));
  },
};
