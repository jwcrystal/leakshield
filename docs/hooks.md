# Agent hooks: design and mask/restore coverage
[← README](../README.md)

> This page is a reference for host hook APIs, not a LeakShield coverage claim. Actual coverage is declared in the [host capability matrix](host-capabilities.md) and on each adapter page.
> Scope: OpenCode, the pi coding agent and Claude Code.
> Verified versions: OpenCode plugin API 1.17.x / 2.0.19, pi 1.6.0 (earendil-works), Claude Code 2.1.330; last checked 2026-11-24.
> This page describes each host's hook or extension API and which interception points can mask content or restore a placeholder. The last section maps them to what LeakShield uses today. Hook APIs change between versions, so re-verify after a host upgrade.

## First, the interception points masking needs

The three hosts do not expose the same kind of hook, but their capabilities compare along one set of positions:

| Point | Direction | Typical content |
|---|---|---|
| User input | mask | prompt, pasted content, attachments |
| History / system | mask | messages, system prompt, tool definitions |
| Model request payload | mask | provider-specific JSON, headers, WS frames |
| Model output (streaming) | restore | SSE deltas, WS frames, final message |
| Display | restore | assistant text, rendered tool results |
| Tool boundary | both | restore arguments, mask results |
| Background requests | mask | compaction, title, summary, subagent |

The rule: **masking belongs at a single choke point (the wire); restoration can only happen at a local sink (before tool execution, or on screen).** A hook-only design is a compromise for hosts that offer no wire hook.

## Claude Code: external process hooks

### Design

A hook is a process (or HTTP endpoint) outside the host, declared in settings. The shape is three levels: `event -> matcher group -> handler`. Multiple hooks for the same event run in parallel. A handler has one of five `type` values: `command`, `http`, `mcp_tool`, `prompt`, `agent`.

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash|Read|Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "/path/to/leakshield-hook restore-args",
        "timeout": 10,
        "onFailure": "block"
      }]
    }]
  }
}
```

### API protocol

- Input: the event JSON arrives on stdin. Common fields are `session_id`, `transcript_path`, `cwd`, `permission_mode` and `hook_event_name`, plus event fields such as `tool_name`, `tool_input` and `tool_response`.
- Output: exit 0 with JSON on stdout, or exit 2 to block (on events that support blocking; stderr is shown to Claude).
- Common JSON fields: `continue`, `stopReason`, `systemMessage`. Event-specific control goes inside `hookSpecificOutput`, which must carry `hookEventName`.
- Failure is fail-open by default: a command that times out or crashes lets the action proceed. Fail-closed requires `onFailure: "block"` (v2.1.295+). A timed-out `UserPromptSubmit` hook also has its output discarded while the prompt still reaches Claude.

### Hooks that can mask or restore

| Event | Mutable field | What it can do | Limits |
|---|---|---|---|
| `PreToolUse` | `hookSpecificOutput.updatedInput` | **Restore** placeholders in tool arguments | Replaces the whole input object, so unchanged fields must be included; permission rules are re-evaluated; auto mode may deny a call whose input a hook changed |
| `PermissionRequest` | `decision.updatedInput` (allow only) | Restore arguments on the permission-approval path | Allow only; deny/ask rules are re-evaluated after the change |
| `PostToolUse` | `hookSpecificOutput.updatedToolOutput` | **Mask** a tool result before Claude sees it | The value must match that tool's output shape (Bash, for example, is `{stdout,stderr,interrupted,isImage}`), so walk every string field recursively rather than replacing the object with a string; an `async: true` hook cannot rewrite a result |
| `PostToolUseFailure` | `additionalContext` only | Add an explanation | The error string itself still reaches the model, so it **cannot be masked** |
| `UserPromptSubmit` | `additionalContext` only | Add policy text, block a prompt | **Cannot replace the prompt**, so user input cannot be masked here |
| `MessageDisplay` | `displayContent` | **Restore** assistant text on screen | Display only: the transcript and what the model sees keep the original; verbose mode shows the original; runs once per batch of lines with a 10-second default timeout |
| `PreCompact` | stdout as summary instructions | Guide compaction | Cannot rewrite the content being summarized; only block or add instructions |
| `SessionStart` / `UserPromptExpansion` | `additionalContext` | Add context | Cannot rewrite existing messages |

**The important gap**: Claude Code has **no hook at the model request or response layer**. `PreModelSwitch` / `PostModelSwitch` only govern model selection, not the payload. Masking the prompt, system prompt or assistant body therefore requires an `ANTHROPIC_BASE_URL` proxy (or a gateway), and Bedrock/Vertex bypass the base URL entirely.

**Consequence**: hook-only mode on Claude Code can restore tool arguments, mask tool results and restore displayed text, but cannot mask user input or model output. LeakShield currently uses the proxy and leaves `surfaces.toolArgs` as `unknown` (#91); `updatedInput` and `updatedToolOutput` now make that row feasible, at the cost of preserving each tool's output shape and handling auto mode's re-review.

## OpenCode: an in-process plugin, two API generations

### v1 plugin (`@opencode-ai/plugin`)

> LeakShield supports v2 only; the v1 section is here to explain how the API evolved.

```ts
export const LeakShield: Plugin = async () => ({
  "chat.message": async (_in, out) => { /* mask out.message / out.parts */ },
  "tool.execute.before": async (_in, out) => { out.args = restore(out.args); },
  "tool.execute.after": async (_in, out) => { out.output = mask(out.output); },
  "experimental.text.complete": async (_in, out) => { out.text = restore(out.text); },
});
```

Hooks receive `(input, output)` and mutate `output`; throwing inside a hook aborts the operation, which is how LeakShield fails closed. This generation has **no raw transport hook**, so it can only change the high-level fields the host exposes.

| Hook | Mutable | Use |
|---|---|---|
| `chat.message` | `output.message`, `output.parts` | Mask user input and attachments |
| `experimental.chat.messages.transform` | `output.messages` | Mask conversation history |
| `experimental.chat.system.transform` | `output.system[]` | Mask the system prompt |
| `tool.definition` | `description`, `parameters` | Mask a tool's schema and description |
| `tool.execute.before` | `output.args` | **Restore** tool arguments |
| `tool.execute.after` | `output.output`, `title`, `metadata` | **Mask** a tool result |
| `experimental.text.complete` | `output.text` | **Restore** final assistant text |
| `experimental.session.compacting` | `prompt`, `context` | Guide compaction, not rewrite the summary |
| `chat.params` / `chat.headers` / `permission.ask` / `shell.env` | parameters / headers / permission / environment | Not a content interception point |

Limits: high-level hooks cover only the fields they expose, not provider-specific payload (cache markers, unusual content blocks, non-chat requests), and `experimental.*` carries no stability guarantee.

### v2 plugin (`@opencode/plugin`)

```ts
export default {
  setup: async (ctx) => {
    await ctx.session.hook("http.request", (e) => { e.request = maskRequest(e.request); });
    await ctx.session.hook("http.response", (e) => { e.response = restoreResponse(e.response); });
    await ctx.tool.hook("execute.before", (e) => { e.input = restore(e.input); });
  },
};
```

`ctx.session.hook(name, fn)` returns a disposable registration. The available names:

- Content: `prompt`, `context`, `compaction`, `generate`, `title`
- Transport: `http.request`, `http.response`, `experimental.ws.handshake` / `send` / `receive`, `model.request` (baseURL / headers), `retry`
- Tool: `ctx.tool.hook("execute.before" / "execute.after")`
- SDK: `ctx.aisdk.hook("sdk" / "language")`

OpenCode is the only one of the three whose hook API **hands you a replaceable `Request` / `Response` and WS frame**, making it effectively an in-process proxy and a complete mask/restore choke point. LeakShield's OpenCode adapter uses this set: content hooks mask, `http.request` / `http.response` mask and restore the wire, the WS hooks cover the Responses family, and `tool.execute.before` restores arguments.

## pi (earendil-works/pi, verified here at 1.6.0): in-process extension

### Design

An extension is `export default function (pi: ExtensionAPI)` that subscribes with `pi.on(event, handler)`. Mutation semantics vary by event: some are **in-place** (`event.input`, `event.headers`), others **return a replacement** (`before_provider_request`'s payload, `message_end`'s message, `tool_result`'s patch, `input`'s transform). The API also has `pi.registerTool()`, `pi.registerProvider()` and `pi.registerCommand()`.

```ts
export default function (pi: ExtensionAPI) {
  pi.on("input", (event) => ({ action: "transform", text: mask(event.text) }));
  pi.on("before_provider_request", (event) => maskPayload(event.payload));
  pi.on("tool_call", (event) => { event.input = restore(event.input); });
  pi.on("tool_result", (event) => ({ content: maskContent(event.content) }));
  pi.on("message_end", (event) => ({ message: restoreMessage(event.message) }));
}
```

### Hooks that can mask or restore

| Event | Semantics | Use | Limits |
|---|---|---|---|
| `input` | return `{action:"transform"}` | Mask user input | Fires **before** skill/template expansion, so content injected by expansion does not pass through this hook |
| `context` | return `{messages}`, system excluded | Mask history | Before each LLM call |
| `context_with_system` | return the full messages, system included | Mask the whole transcript / prompt | Must keep a system message at index 0 |
| `before_provider_request` | return a new payload | **Mask the whole provider request** | If a provider sends only an increment (Codex WS, Anthropic threads), only the new part is covered |
| `before_provider_headers` | mutate `event.headers` in place | Authentication / routing | No body access |
| `after_provider_response` | status / headers only | Observe | **Cannot change the body**; fires before the stream is consumed |
| `provider_stream_event` | read-only | Observe | Explicitly not modifiable |
| `message_end` | return `{message}` | **Restore** the finalized assistant message | `message_update` can only observe, so the screen shows placeholders until the message ends |
| `tool_call` | mutate `event.input`, may block | **Restore** tool arguments | No schema re-validation after the change |
| `tool_result` | return a patch (`content` / `details` / ...) | **Mask** a tool result | Replacing `content` without `structuredContent` drops the structured content |
| `session_before_compact` / `session_before_tree` | `{cancel:true}` only | Refuse a summary that cannot be protected | Cannot rewrite the summary |
| `pi.registerProvider(name, {streamSimple})` | own the wire | Full mask / restore | Equivalent to writing your own transport |
| wrapping `globalThis.fetch` | not a hook, but available to an extension | Full two-way control, streaming included | Must load before other extensions |

pi's hooks come close to complete: `before_provider_request` masks the request, `message_end` restores the final message, and `tool_call` / `tool_result` cover the tool boundary. **Restoring mid-stream** and **covering every provider path** still require a fetch wrapper or a custom provider, which is why LeakShield wraps fetch rather than relying on hooks alone.

## Cross-host comparison

| Capability | Claude Code | OpenCode v2 | pi 1.6 |
|---|---|---|---|
| Mask user input | none (block or add context only) | `prompt` / `chat.message` | `input` transform (before skill expansion) |
| Mask history / system | none | `context` / `messages.transform` | `context` / `context_with_system` |
| Mask request payload | none (proxy required) | `http.request` | `before_provider_request` / custom provider |
| Restore streamed output | none (`MessageDisplay` changes display only) | `http.response` / `text.complete` | fetch wrapper; `message_end` is final-only |
| Restore displayed text | `MessageDisplay.displayContent` (display only) | `experimental.text.complete` | `message_end` (final only) |
| Restore tool arguments | `PreToolUse.updatedInput` | `tool.execute.before` | `tool_call` |
| Mask tool results | `PostToolUse.updatedToolOutput` | `tool.execute.after` | `tool_result` |
| Mask tool errors | `additionalContext` only | unknown (`execute.after` coverage of failed calls is unverified) | `tool_result` (`isError`) |
| Background / compaction | `PreCompact` can only guide | `compaction` / `title` / `generate` | the same fetch, or `before_provider_request` |
| Transport layer | no hook, proxy required | `http.*` / `ws.*` / `aisdk` | fetch / provider |

## What this means for LeakShield

1. **OpenCode already has wire hooks**, so hook mode can approach proxy coverage; with `wireProtection: false` only the high-level content hooks remain, and non-fetch transports escape.
2. **pi's hooks can mask the request and restore the final message, but not restore mid-stream.** Keeping the fetch wrapper is the complete option; `tool_call` then only restores local arguments.
3. **Claude Code's hooks cannot replace the proxy**: `UserPromptSubmit` cannot rewrite the prompt, there is no request/response hook, and `MessageDisplay` changes display only. Their value is the **local sink restoration** a proxy cannot reach (tool arguments), **display restoration**, and fail-closed behaviour through `onFailure: "block"`.
4. Shared traps:
   - A streaming split can cut a placeholder in half; per-delta restoration needs buffering or cross-chunk state.
   - Hook order and load position matter (pi's fetch wrapper, OpenCode plugin load order).
   - Claude Code hooks fail open by default; a masker must block explicitly.
   - Hooks themselves see plaintext (`tool_input`, raw fetch, plugin args), so a hook process must not log content and must not be treated as the only trust boundary.

**In one line**: Claude Code hooks are external governance events suited to approval and the tool boundary; OpenCode plugins are in-process interceptors, and v2 reaches the transport; pi extensions are events with mutable fields, strong on requests but dependent on fetch or a provider for response streaming. For complete mask/restore coverage, all three still anchor at the transport layer, with hooks restoring locally and refusing when they cannot.

## Sources

- Claude Code: [Hooks reference](https://code.claude.com/docs/en/hooks) (2.1.330 locally)
- OpenCode: `node_modules/@opencode-ai/plugin/dist/index.d.ts` (v1 `Hooks`), `node_modules/@opencode/plugin/dist/promise/session.d.ts` and `tool.d.ts` (v2)
- pi: `@earendil-works/pi-coding-agent/docs/extensions.md` and `custom-provider.md` (1.6.0)
- LeakShield mapping: `docs/host-capabilities.md`, `src/adapters/opencode/transparent.ts`, `src/adapters/pi/extension.ts`, `src/adapters/claude-code/proxy.ts`

## Related pages

- [Host capability matrix](host-capabilities.md): per-host coverage declarations and residuals
- [Claude Code (local proxy)](claude-code.md)
- [pi adapter](pi.md)
- [Transparent mode](plugin/transparent-mode.md)
- [Wire protection](plugin/wire-protection.md)
