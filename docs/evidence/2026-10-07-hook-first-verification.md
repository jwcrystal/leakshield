# Hook-first configuration and verification

## Accepted design

The user selected hook-first after source investigation and independent review established that literal hooks-only cannot restore native model responses with the current OpenCode v2.0.24 plugin API. This supersedes the earlier unconditional final-wire-protection preference, without permitting silent loss of protection for existing configurations.

`mode: "transparent"` now accepts optional boolean `wireProtection`:

| Configuration | Final HTTP body | Shared protections |
| --- | --- | --- |
| Omitted | Existing validation and remasking retained | Content hooks, route/metadata admission, response attribution/restoration, tool gate |
| `true` | Validation and remasking enabled | Same |
| `false` | Body not read, validated, or changed | Same, but content added after content hooks is outside masking coverage |

The option is invalid outside transparent mode. Invalid values fail closed. New transparent-install documentation explicitly selects `false`; the general plugin default remains block mode. The new configuration example is `config/opencode.hook-first.example.json`. No existing user config was migrated or edited.

## Required HTTP participation

This is not wire-independent or literal hooks-only. An HTTP request admission hook preserves exact final `Request` identity, checks supported HTTP(S) route shape and transport metadata, and records session/kind attribution. The response hook refuses uncorrelated or mismatched responses and retains supported JSON/SSE restoration. WS/AI SDK refusal hooks, native OpenAI HTTP preference, tool gates, initialization fallback, and disposal remain.

Supported response dialects remain Chat Completions, Anthropic Messages, and OpenAI Responses. Unknown routes are refused before dispatch. Hook-first deliberately does not validate the final body dialect of an admitted URL. Provider-generated fields, late-hook text, or late-added attachments can be transmitted unmasked. Attachment policy still runs at content hooks, but `block` does not claim to inspect late-added wire attachments when `wireProtection` is false.

## Native-response feasibility evidence

Host source pin: `e7a34f09bfd9134dfade5a8ddb843f7030bc9a69` (OpenCode v2.0.24).

- `packages/plugin/src/effect/session.ts:138–150`: no decoded native-response rewrite hook.
- `packages/plugin/src/promise/event.ts:1–3`: subscription, not a synchronous pre-publication transform.
- `packages/plugin/src/promise/aisdk.ts:5–17`: language-model replacement is SDK-specific, not native OpenAI coverage.
- `packages/core/src/session/runner/step.ts:104–116`: native events go directly to the publisher.
- `packages/core/src/session/runner/publish-llm-event.ts:401–432`: text/reasoning feeds event publication.

Independent read-only reviewer confirmed the boundary before implementation. Handoff: `.scratch/handoff-20261007-1038.md`.

## Implementation

- `src/plugin-options.ts`: optional transparent-only boolean with legacy omission semantics.
- `src/opencode.ts`: forwards explicit choice; omission resolves to the existing stronger behavior.
- `src/opencode-transparent.ts`: selects final remasking or admission-only while retaining the common attribution/response/tool lifecycle.
- `src/opencode-transparent-http.ts`: admission-only helper checks route and metadata without consuming or replacing the request.
- `src/doctor.ts`: shows effective wire choice and reports hook-first as `PARTIAL`, with explicit weaker coverage.
- `README.md` and new configuration example: mode-specific contract, migration behavior, attachment boundaries and known restart limitation.

## Verification performed

- Focused pre-implementation tests were red: 12 failures established missing option validation, legacy-vs-explicit selection, passthrough identity/body behavior and doctor coverage. An unsupported Chat Completions `reasoning_content` assertion was excluded from this feature's claims; OpenAI Responses reasoning summaries are independently tested instead.
- Full post-implementation suite: **31 files / 705 tests passed**.
- `npx tsc --noEmit`, `npm run build`, and `git diff --check` passed; ignored `dist/` rebuilt.
- Configuration example parses and validates through the compiled option schema.
- Added synthetic gates cover explicit true/false/omission setup; content masking; unchanged admitted bodies and Request identity; concurrent-session/kind mismatch refusal; replaced-request refusal; retry attribution; split-token SSE; OpenAI Responses assistant/reasoning-summary restoration; route/metadata refusal before attribution; HTTP(S) admission; WS/SDK refusal; attachment policies at content hooks; malformed-option fallback; and accurate doctor reporting.

## Persisted-tool-input counterexample retained

A regression test demonstrates the current limit: provider tool-call arguments remain tokenized in the restored wire response, local execution receives originals, and a fresh guard after disposal can re-mask original source text but cannot recover the old argument token. A write invocation containing that old token refuses. Hook-first does not fix or hide this limitation; no persistent mapping storage was introduced.

## Not verified or performed

- No current-session activation, global registration edit, shared-service restart, real provider request, or image upload.
- No native host end-to-end run of this new option; hook behavior tested offline with host-shaped mocks.
- No claim of complete reasoning-field coverage across providers or complete token-free history/restart recovery.
- Broader Unicode warning refusals remain unresolved and can still block content hooks in either protection level.
- Changes remain uncommitted; unrelated existing changes retained.

## Post-implementation independent review

A read-only reviewer found no new actionable findings in the bounded diff. It confirmed legacy omission semantics, admission-only behavior for explicit false, and preservation of request attribution, response restoration, tool gates, unsupported-route refusal, initialization fallback and disposal. The reviewer inspected code/tests/evidence but did not independently rerun the reported gates or perform native-host end-to-end verification.
