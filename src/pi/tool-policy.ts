/**
 * pi-specific tool classification for the shared guard core.
 *
 * The core restores placeholders only inside the host's local execution
 * boundary; it needs to know which fields are shell command text, which are
 * code, and which tools may keep a literal placeholder when a mapping is
 * missing. pi's built-ins use flat JSON inputs, so the key-based rules from
 * `core/tool-restore-policy.ts` cover them.
 *
 * Unknown and MCP tools never restore and never degrade: a placeholder there
 * could reach a remote service, so the call is refused instead.
 */
import type { HostToolPolicy, RecordLike } from "../core/session-guard.js";
import { containsTokenPrefix } from "../decision/pseudonymization.js";
import {
  isShellTool,
  isShellKey,
  isCodeKey,
  keyPolicy,
} from "../core/tool-restore-policy.js";

/** pi 1.6.0 built-in tools whose inputs execute a command. */
const PI_SHELL_TOOLS = new Set(["bash", "powershell"]);

/** The built-ins whose input shapes this adapter understands. */
const PI_KNOWN_TOOLS = new Set(["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"]);

export const PI_UNKNOWN_TOOL_ERROR =
  "LeakShield blocked this tool call because the tool is not a known pi built-in and its arguments contain a placeholder. The tool did not run.";

function carriesPlaceholder(value: unknown, depth: number): boolean {
  if (depth > 32) return true;
  if (typeof value === "string") return containsTokenPrefix(value);
  if (value === null || typeof value !== "object") return false;
  const seen = new Set<object>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth }];
  while (stack.length > 0) {
    const item = stack.pop() as { value: unknown; depth: number };
    if (item.depth > 32) return true;
    if (typeof item.value === "string") {
      if (containsTokenPrefix(item.value)) return true;
      continue;
    }
    if (item.value === null || typeof item.value !== "object") continue;
    if (seen.has(item.value)) continue;
    seen.add(item.value);
    if (Array.isArray(item.value)) {
      for (const entry of item.value) stack.push({ value: entry, depth: item.depth + 1 });
      continue;
    }
    for (const [key, entry] of Object.entries(item.value)) {
      if (containsTokenPrefix(key)) return true;
      stack.push({ value: entry, depth: item.depth + 1 });
    }
  }
  return false;
}

/**
 * Unknown and extension tools cannot be classified, so a placeholder must not
 * reach them: their arguments may be forwarded to a remote service that never
 * saw the pseudonymized session. Known pi built-ins go through the core.
 * This deliberately overrides ADR-0001 for the pi host; see ADR-0006.
 */
export function assertPiToolBoundary(rawTool: string, input: unknown): void {
  if (PI_KNOWN_TOOLS.has(rawTool.toLowerCase())) return;
  if (carriesPlaceholder(input, 0)) throw new Error(PI_UNKNOWN_TOOL_ERROR);
}

/**
 * pi 1.6.0 built-ins whose arguments only read or search local state. A
 * literal placeholder there matches nothing; it cannot write, delete, or
 * transmit. Everything else must refuse an incomplete restoration.
 */
const PI_READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

export const piToolPolicy: HostToolPolicy = {
  isCodeModeCall: (_event: RecordLike): boolean => false,
  isShellTool(rawTool: string): boolean {
    return PI_SHELL_TOOLS.has(rawTool.toLowerCase()) || isShellTool(rawTool);
  },
  classifyField: keyPolicy,
  allowsDegradedRestore(rawTool, input): boolean {
    if (!PI_READ_ONLY_TOOLS.has(rawTool.toLowerCase())) return false;
    return !(
      input !== null &&
      typeof input === "object" &&
      Object.keys(input).some((key) => isShellKey(key) || isCodeKey(key))
    );
  },
};
