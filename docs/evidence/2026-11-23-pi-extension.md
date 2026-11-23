# pi 1.6.0: in-process extension adapter

Date: 2026-11-23. Related: #98, PR #100. Supersedes
[2026-11-23-pi-adapter.md](2026-11-23-pi-adapter.md): the loopback proxy, the
managed launcher and credential brokering were removed from this branch. The
transport audit behind that decision is
[2026-11-23-pi-fetch-gap-audit.md](2026-11-23-pi-fetch-gap-audit.md).

## Design

pi builds provider clients per request and resolves `options.fetch ?? globalThis.fetch`
at that point, including compaction and branch summaries. The extension wraps
`globalThis.fetch` before any client exists, sends the three supported wire
routes through `createGuardCore`, and restores assistant text in the reply.
Tool arguments are restored at `tool_call`; unknown and MCP tools refuse
placeholders. There is no launcher, so pi keeps its own provider config,
credential and session directory.

## Setup

- `@earendil-works/pi-coding-agent@1.6.0`, Node 24.22.3, `--ignore-scripts`.
- Temporary agent directory whose `settings.json` lists
  `/…/dist/pi/extension.js` first in `extensions`, with a stub provider in
  `models.json` (loopback, `openai-completions` unless stated).
- `LEAKSHIELD_CONFIG` points at a guard config whose `nda_keywords` hold the
  synthetic values. Persistence is on with a temporary store
  (`LEAKSHIELD_PI_PERSIST*`), so the resumed run is a second process that loads
  the persisted mappings.
- The stub records every request body and echoes the first placeholder it sees,
  so a restored reply proves the display path.
- Scripts: `scripts/e2e/run-pi-wire.mjs` and
  `scripts/e2e/run-pi-extension.mjs` (require `npm run build`).

## Results

### Wire formats

Real pi process, print mode, one prompt per format:

| api | stub requests | original at stub | placeholder in request | restored in stdout |
|---|---|---|---|---|
| `openai-completions` | 1 | no | yes | yes |
| `anthropic-messages` | 1 | no | yes | yes |
| `openai-responses` | 1 | no | yes | yes |

### Tools, session and resume

The stub plays read → write → edit → bash, then a final text reply; a second run
uses `--continue`:

```text
ok   first run exits 0
ok   scripted tool sequence ran
ok   provider never received an original value
ok   every provider request carried placeholders
ok   tool results were masked before the next request
ok   write and edit used the restored values
ok   pi persisted a session in the user's session directory
ok   the encrypted mapping store was written
ok   the mapping store holds no plaintext value
ok   saved tool-call arguments contain placeholders
ok   resumed run exits 0
ok   resumed run sent a new masked request
ok   resumed session history stays masked
ok   resumed session loaded prior history
```

### Refusal of unguarded background operations

Real pi, a conversation on the stub model, then `set_model` to a
`bedrock-converse-stream` model and RPC `compact`:

```text
ok   conversation used the fetch-guarded model
ok   provider never received the canary
ok   model switch to the Bedrock API succeeded
ok   manual compaction was refused (Compaction cancelled)
ok   compaction sent no request
ok   a prompt after the switch did not reach the provider
```

### Background requests

Automatic compaction was run against real pi with a small context window: three
provider requests, all masked, `compaction_end` succeeded. Branch
summarization calls the same `completeSummarization()` path and was not
triggered at runtime (`/tree` has no RPC command). See the gap audit.

### Build and tests

- `npx vitest run`: 68 files, 1,823 tests pass.
- `npx tsc --noEmit`, `npm run build`, `npm pack --dry-run`.

## What this does not prove

- Branch summarization, Bedrock, Codex WebSocket and Google at runtime; the
  first is the same transport, the rest are refused by model/API check.
- Interactive TUI rendering (print mode and RPC only).
- A real provider credential: every run used the loopback stub.
- Windows.
