# Vision tool-output refusal recovery

## Observed failure

- OpenCode v2.0.24 vision child sessions at 2026-10-07T02:15:08.329Z and 02:15:40.946Z failed with `Sensitive Guard transparent mode blocked a model request with an unsupported or unidentifiable body.`
- The stack reaches `dist/opencode-transparent-http.js:933`: `function_call_output.output` rejected because it is not a string.
- Read-only session API inspection confirmed `read` completed with text plus an `image/png` file part. This establishes that local reading succeeded; model interpretation did not.
- A later equivalent guard refusal was logged at 02:18:51.067Z. A separate main-session protection failure at 02:19:02.591Z remains outside this correction.

## Configuration pitfall

The supported option is `attachments`, plural. Offline validation confirms that `{mode: "transparent", attachment: "allow"}` silently ignores the unknown singular key and resolves `attachments: "block"`. Correct plural input resolves `attachments: "allow"`.

Allowing attachments is explicit permission to send attachment contents **unscanned**. It does not disable text masking or transport validation. No option schema or global configuration was changed in this correction.

## Source contract

Pinned OpenCode SHA `e7a34f09bfd9134dfade5a8ddb843f7030bc9a69`, `packages/ai/src/protocols/open-responses.ts`, defines `function_call_output.output` as a string or ordered content array. Its lowerer emits `input_text`, `input_image`, and `input_file` parts for tool results. Video exists in the host contract but remains outside the guard's admitted types.

## Correction

`src/opencode-transparent-http.ts` now accepts output arrays through the existing Responses content-part validator. Text continues through the atomic pseudonymization transaction; explicitly allowed images/files use the existing opaque-attachment substitution. Default block policy still refuses wire attachment arrays. Missing, malformed, and unknown output shapes remain refused.

`tests/opencode-transparent-responses.test.ts` adds coverage for text masking, image/file byte preservation, retry idempotence, default-block refusal without request mutation, and malformed-output refusal. Additional concurrently present test coverage was preserved, not overwritten.

## Verification

- Before correction: focused tool-output tests reproduced the unsupported-body error for both attachment and text-only arrays.
- After correction: Responses test file passed all 48 cases.
- Full suite: 30 files / 675 tests passed.
- Typecheck, build, and `git diff --check` passed. Ignored `dist/` rebuilt.

## Limits and current activation state

- The user removed the plugin. Inspection found no sensitive-guard registration in either global OpenCode config or OpenChamber's managed config at inspection time.
- No plugin was re-added, no shared service restarted, no provider request issued, and no image uploaded by this verification.
- Offline hook tests do not establish actual vision-provider completion or complete restart recovery.
- Broader Unicode history refusals remain documented in `.scratch/handoff-20261007-0220.md` and are not resolved by this HTTP correction.

## Opt-in boundary

Current recommendation: opt into the protected pipeline using `mode: "transparent"`; wire protection remains mandatory within that mode. Attachments are a separate explicit opt-in. Do not silently turn off wire protection to make unsupported requests pass. A weaker hooks-only mode, if desired, would need a separately labeled contract and approval; it was not implemented here.
