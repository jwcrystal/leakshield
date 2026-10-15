import type { Hooks } from "@opencode-ai/plugin";
import type { Plugin as PluginNamespace } from "@opencode/plugin";
import type {
  EnvCompareOutcome,
  EnvInspectOutcome,
  EnvQueryFailure,
  EnvQueryService,
} from "./env-queries.js";
import { MAX_FILE_ID_LENGTH, MAX_KEY_NAME_LENGTH } from "./env-queries.js";

/**
 * Agent tool surface for the opt-in readonly env queries (plugin option
 * `envQueries`, default false). Two bindings share this payload layer:
 *
 * - OpenCode v1: `Hooks["tool"]` built with the SDK's `tool()` helper
 *   (`import("@opencode-ai/plugin/tool")`, loaded dynamically so v2 hosts
 *   never depend on the v1 SDK package). Arg schemas use `tool.schema`
 *   (the SDK's zod 4), which satisfies the SDK's `ZodRawShape` constraint
 *   without any unsafe cast from this repo's zod 3.
 * - OpenCode v2: tools registered through `ctx.tool.transform(editor =>
 *   editor.add(...))` with literal JSON Schemas and runtime validation in
 *   `execute` (v2 passes raw unknown input).
 *
 * Every payload is fixed and sanitized: statuses, coarse shapes, equality,
 * opaque file ids, and key names only. Values, lengths, previews, paths, and
 * exception text never appear; failures map to fixed messages below.
 */

type V2PluginContext = PluginNamespace.Context;

const FAILURE_MESSAGES: Record<EnvQueryFailure["code"], string> = {
  disabled: "Env queries are disabled because the guard configuration changed. Restart OpenCode.",
  unknown_file_id: "Unknown file id. File ids are session-local and issued by guard_env_list.",
  invalid_arguments: "Invalid arguments.",
};

const INTERNAL_ERROR = "Env query failed.";

type ToolPayload = Record<string, unknown>;

function safePayload(run: () => ToolPayload): ToolPayload {
  try {
    return run();
  } catch {
    return { error: INTERNAL_ERROR };
  }
}

function onFailure(failure: EnvQueryFailure): ToolPayload {
  return { error: FAILURE_MESSAGES[failure.code] };
}

const LIST_DESCRIPTION =
  "List the env files enabled for readonly querying and their key names. " +
  "Returns one opaque session-local file id per enabled file plus its key names — never values, lengths, or previews. " +
  "File ids are only valid in this session. Unreadable files are reported with fixed reason codes.";

const INSPECT_DESCRIPTION =
  "Inspect one key in an enabled env file without revealing its value. " +
  "Returns status missing | empty | nonempty and, when nonempty, a coarse lexical shape: boolean_like | number_like | multiline_text | text. " +
  "A shape is a lexical hint only, never a claim that the value is a valid boolean or number.";

const COMPARE_DESCRIPTION =
  "Compare the values of two keys in enabled env files (same file or cross-file) without revealing them. " +
  "Returns equal | different | unavailable. Both operands must be existing keys of enabled files; missing keys or unreadable files are unavailable. " +
  "Raw values are never returned.";

function listPayload(service: EnvQueryService, sessionID: string): ToolPayload {
  const result = service.listFiles(sessionID);
  return result.ok ? { files: result.files } : onFailure(result);
}

function inspectPayload(service: EnvQueryService, sessionID: string, fileId: string, key: string): ToolPayload {
  const result = service.inspectKey(sessionID, fileId, key);
  return result.ok ? inspectOutcomePayload(result) : onFailure(result);
}

function inspectOutcomePayload(outcome: EnvInspectOutcome): ToolPayload {
  switch (outcome.status) {
    case "unavailable":
      return { status: "unavailable", reason: outcome.reason };
    case "nonempty":
      return { status: "nonempty", shape: outcome.shape };
    default:
      return { status: outcome.status };
  }
}

function comparePayload(
  service: EnvQueryService,
  sessionID: string,
  left: { fileId: string; key: string },
  right: { fileId: string; key: string },
): ToolPayload {
  const result = service.compareKeys(sessionID, left, right);
  if (!result.ok) return onFailure(result);
  const outcome: EnvCompareOutcome = result;
  return outcome.result === "unavailable"
    ? { result: "unavailable", ...(outcome.reason ? { reason: outcome.reason } : {}) }
    : { result: outcome.result };
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStringField(input: unknown, field: string, maxLength: number): string | undefined {
  if (!isRecordLike(input)) return undefined;
  const value = input[field];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return undefined;
  return value;
}

/** Runtime validation for v2, where tool input arrives as unknown. */
function readInspectArgs(input: unknown): { file_id: string; key: string } | undefined {
  const file_id = readStringField(input, "file_id", MAX_FILE_ID_LENGTH);
  const key = readStringField(input, "key", MAX_KEY_NAME_LENGTH);
  return file_id && key ? { file_id, key } : undefined;
}

function readCompareArgs(
  input: unknown,
): { left_file_id: string; left_key: string; right_file_id: string; right_key: string } | undefined {
  const left_file_id = readStringField(input, "left_file_id", MAX_FILE_ID_LENGTH);
  const left_key = readStringField(input, "left_key", MAX_KEY_NAME_LENGTH);
  const right_file_id = readStringField(input, "right_file_id", MAX_FILE_ID_LENGTH);
  const right_key = readStringField(input, "right_key", MAX_KEY_NAME_LENGTH);
  return left_file_id && left_key && right_file_id && right_key
    ? { left_file_id, left_key, right_file_id, right_key }
    : undefined;
}

// ─── OpenCode v1 ─────────────────────────────────────────────────────────────

/** Builds the v1 tool map for `Hooks["tool"]` when `envQueries` is enabled. */
export async function createV1EnvTools(service: EnvQueryService): Promise<NonNullable<Hooks["tool"]>> {
  // Runtime dependency on the v1 SDK's tool helper; loaded dynamically so a
  // v2 host never needs the v1 SDK package. A v1 host always provides it.
  const { tool } = await import("@opencode-ai/plugin/tool");
  const z = tool.schema;

  const guardEnvList = tool({
    description: LIST_DESCRIPTION,
    args: {},
    async execute(_args, context) {
      return {
        title: "guard_env_list",
        output: JSON.stringify(safePayload(() => listPayload(service, context.sessionID))),
      };
    },
  });

  const guardEnvInspect = tool({
    description: INSPECT_DESCRIPTION,
    args: {
      file_id: z
        .string()
        .min(1)
        .max(MAX_FILE_ID_LENGTH)
        .describe("Session-local file id issued by guard_env_list."),
      key: z
        .string()
        .min(1)
        .max(MAX_KEY_NAME_LENGTH)
        .describe("Key name as listed by guard_env_list."),
    },
    async execute(args, context) {
      return {
        title: "guard_env_inspect",
        output: JSON.stringify(
          safePayload(() => inspectPayload(service, context.sessionID, args.file_id, args.key)),
        ),
      };
    },
  });

  const guardEnvCompare = tool({
    description: COMPARE_DESCRIPTION,
    args: {
      left_file_id: z
        .string()
        .min(1)
        .max(MAX_FILE_ID_LENGTH)
        .describe("Session-local file id of the left operand."),
      left_key: z
        .string()
        .min(1)
        .max(MAX_KEY_NAME_LENGTH)
        .describe("Key name of the left operand."),
      right_file_id: z
        .string()
        .min(1)
        .max(MAX_FILE_ID_LENGTH)
        .describe("Session-local file id of the right operand."),
      right_key: z
        .string()
        .min(1)
        .max(MAX_KEY_NAME_LENGTH)
        .describe("Key name of the right operand."),
    },
    async execute(args, context) {
      return {
        title: "guard_env_compare",
        output: JSON.stringify(
          safePayload(() =>
            comparePayload(
              service,
              context.sessionID,
              { fileId: args.left_file_id, key: args.left_key },
              { fileId: args.right_file_id, key: args.right_key },
            ),
          ),
        ),
      };
    },
  });

  return {
    guard_env_list: guardEnvList,
    guard_env_inspect: guardEnvInspect,
    guard_env_compare: guardEnvCompare,
  };
}

// ─── OpenCode v2 ─────────────────────────────────────────────────────────────

/**
 * Registers the env query tools on an OpenCode v2 plugin context via
 * `ctx.tool.transform(editor => editor.add(...))`. Tool inputs are literal
 * JSON Schemas; `execute` validates the raw input at runtime.
 */
export async function registerV2EnvTools(ctx: V2PluginContext, service: EnvQueryService): Promise<void> {
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "guard_env_list",
      description: LIST_DESCRIPTION,
      input: { type: "object", properties: {}, required: [], additionalProperties: false },
      output: { type: "object" },
      async execute(_input, context) {
        const payload = safePayload(() => listPayload(service, context.sessionID));
        return { output: payload, content: JSON.stringify(payload) };
      },
    });

    editor.add({
      name: "guard_env_inspect",
      description: INSPECT_DESCRIPTION,
      input: {
        type: "object",
        properties: {
          file_id: {
            type: "string",
            maxLength: MAX_FILE_ID_LENGTH,
            description: "Session-local file id issued by guard_env_list.",
          },
          key: {
            type: "string",
            maxLength: MAX_KEY_NAME_LENGTH,
            description: "Key name as listed by guard_env_list.",
          },
        },
        required: ["file_id", "key"],
        additionalProperties: false,
      },
      output: { type: "object" },
      async execute(input, context) {
        const args = readInspectArgs(input);
        const payload = safePayload(() =>
          args
            ? inspectPayload(service, context.sessionID, args.file_id, args.key)
            : onFailure({ ok: false, code: "invalid_arguments" }),
        );
        return { output: payload, content: JSON.stringify(payload) };
      },
    });

    editor.add({
      name: "guard_env_compare",
      description: COMPARE_DESCRIPTION,
      input: {
        type: "object",
        properties: {
          left_file_id: {
            type: "string",
            maxLength: MAX_FILE_ID_LENGTH,
            description: "Session-local file id of the left operand.",
          },
          left_key: {
            type: "string",
            maxLength: MAX_KEY_NAME_LENGTH,
            description: "Key name of the left operand.",
          },
          right_file_id: {
            type: "string",
            maxLength: MAX_FILE_ID_LENGTH,
            description: "Session-local file id of the right operand.",
          },
          right_key: {
            type: "string",
            maxLength: MAX_KEY_NAME_LENGTH,
            description: "Key name of the right operand.",
          },
        },
        required: ["left_file_id", "left_key", "right_file_id", "right_key"],
        additionalProperties: false,
      },
      output: { type: "object" },
      async execute(input, context) {
        const args = readCompareArgs(input);
        const payload = safePayload(() =>
          args
            ? comparePayload(
                service,
                context.sessionID,
                { fileId: args.left_file_id, key: args.left_key },
                { fileId: args.right_file_id, key: args.right_key },
              )
            : onFailure({ ok: false, code: "invalid_arguments" }),
        );
        return { output: payload, content: JSON.stringify(payload) };
      },
    });
  });
}
