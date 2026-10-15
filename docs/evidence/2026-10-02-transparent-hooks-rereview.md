# Transparent hooks: review of user-applied repairs

## Disposition

Specified oracle: openai/gpt-6.1-sol#high; session ses_f04cb8eafffek7BGOpdDXCm42v. User requested read-only review after applying repairs using cmd/DS V4.1 Flash; no additional fixer or implementation authorized by this review.

- Issue 22: **NEEDS REPAIR**; confirmed boundary, lifecycle and streaming defects remain.
- Issue 20: admission placeholder corruption fixed, but **replay still NEEDS REPAIR**.
- Shared-scanner exceptions passed bounded safety checks; oracle found no default-policy weakening.
- Runtime remains NO-GO. No isolated plugin-load approval or full issue-22 completion.

## Remaining confirmed findings

### 1. HIGH: transport metadata/numeric/structural coverage

Locations: src/opencode-transparent-http.ts:222–228,267–278.

Synthetic raw credential remains in x-context header and prompt query parameter. Custom-rule secret 12345678 remains in numeric metadata.pin despite independent scanner detection. Owned-token schema property key also passes unchanged.

Minimum correction: inspect decoded non-auth transport metadata, reject sensitive numeric values and token-bearing structural identifiers without altering protocol names/types. Explicit legitimate authentication headers must remain intact. Add each exact regression and token-key/schema cases.

### 2. HIGH: failed request commits mappings and consumes session capacity

Locations: src/opencode-transparent-http.ts:259–278; src/opencode-transparent.ts:279–280,445–448.

Protection commits mappings before later validation rejects a request. Oracle reproduced 128 distinct sessions with an email followed by unsupported image content; every request failed, then a fresh valid session failed capacity. Failed sessions were not tracked for disposal.

Minimum correction: validate the entire draft before issuance and publish protection atomically; account for every committed session. Add rejection/capacity rollback and disposal tests. Do not hide committed state merely by changing session tracking after rejection.

### 3. HIGH: SSE complete-event/aggregate bounds incomplete

Location: src/opencode-transparent-http.ts:639–669.

Pending buffer cap excludes accumulated eventLines. Twenty-four 64-KiB comment lines plus blank line produced a 1,572,937-byte event despite a 1,048,576-byte cap. Unterminated event accumulation and aggregate channel state remain unbounded.

Minimum correction: charge complete-event and aggregate held/output bytes before accumulation; bound channels collectively. Test small explicit bounds with multiline comments, unterminated events, many channels and unread consumers.

### 4. MEDIUM: per-choice terminal ordering

Location: src/opencode-transparent-http.ts:600–626.

Pending token, finish_reason stop, then token remainder is accepted; terminal indication precedes restored content.

Minimum correction: reject a terminal choice with unresolved token and enforce terminal state per choice. Test pending/terminal/remainder and interleaved choices.

### 5. MEDIUM: reserved token placement outside supported fields

Location: src/opencode-transparent-http.ts:425–435.

Supported JSON envelopes bypass unsupported-token policy: tokens in message.refusal or metadata next to choices:[] pass literally.

Minimum correction: reject reserved tokens outside explicitly allowed display/tool-argument locations. Retain intentional tokenized tool arguments; do not restore the entire protocol tree.

### 6. MEDIUM: legacy issued-placeholder exceptions do not survive replay

Location: src/decision/deidentify.ts:138–139,149–157.

Exceptions apply only to current issuance. Actual prompt-to-context legacy replay corrupts Bob placeholder for both previously prescribed deterministic keys. SHA256 of synthetic oracle-deidentify-204 reproduces [SG-EMAIL-[REDACTED_PII_PHONE_TW]0958a6].

Minimum correction: retain bounded session-owned issued-placeholder validation across hooks; never exempt arbitrary marker-shaped input. Add actual prompt-to-context replay for both fixed keys, session isolation, unknown lookalikes, neighbor/crossing/encoded findings and lifecycle bounds.

## Closed earlier findings

Unsupported routes/dialects/bodyless requests; body strings and tool descriptions; structural identifier renaming; object-key tool refusal; partial SSE prefix restoration; multiline SSE parsing; ordinary pull backpressure; initialization transport refusal; returned host cleanup.

Transport metadata/numeric coverage, unsupported token placement, aggregate streaming bounds, finish ordering, failed-session cleanup and legacy replay remain open. Twelve bounded deterministic legacy assertions passed for admission, unissued lookalikes, neighboring/crossing secrets, encoded residuals and ignore-directive resistance.

## Independent checks actually run

- Focused eight files: tests/opencode-transparent.test.ts, tests/opencode-entry.test.ts, tests/opencode-v2.test.ts, tests/scanner.test.ts, tests/redaction.test.ts, tests/redaction-verifier.test.ts, tests/deidentify.test.ts, tests/pseudonymization.test.ts: **245/245**.
- Typecheck: **PASS**.
- npm test -- --exclude tests/web.test.ts: **477/477**, 23 files. Unmodified full suite not executed by oracle because web tests launch an HTTP server.
- Bounded in-memory Node/tsx diagnostics only. Initial Bun launcher failed; corrected launcher without source edits.

Fourteen file hashes unchanged before/after; manifest SHA256 d97acd9a2be883abf95a130e759d6c89ae9a45c48f170584b5717d73f452a09e. HEAD b47ed0a and git status unchanged. User work preserved. No source edits, staging/commits, installs, provider/network/runtime execution or global config changes.

## Next gate

Repair confirmed cases with targeted regressions and independently review again before isolated loading. Typed token-bearing tools remain deliberately refused; task continuity is not implemented. Exclusive targeting, authentication/config provenance and externally enforced containment still unproven. This report records diagnoses, not authorization to modify or launch runtime.

## Classification correction after contract/fixture reassessment

Designated oracle rechecked source, spec and bounded public-hook diagnostics in session ses_f04bd46d2ffe0JgJwnk47y4Io6. Earlier blanket classification of all six rows as confirmed production bugs was too broad. This section supersedes the corresponding severity/scope assertions above; do not use the earlier rows alone to authorize changes.

1. Transport/numeric/schema coverage is mixed policy and logic. Arbitrary header/query protection boundaries are not yet established; legitimate authentication must not be altered. Finite JSON numbers are explicitly preserved by accepted core and existing tests. Default scanner does not detect 12345678; only the custom rule does. Decide these policies before changing behavior. Owned token as schema property key still bypasses the existing structural-token refusal gate: that narrower case is a logic defect. Withdraw the whole-row HIGH disclosure characterization.
2. Failed-request mapping capacity is a confirmed adapter logic defect, not failed atomicity inside core API operations. With valid safe context before each session's rejected HTTP request, 128 refused requests consume capacity and the next sensitive context fails. In this normal sequence sessions are tracked, so the previous blanket untracked-session claim does not apply. Validate the complete adapter operation before committing protection and test capacity after refusal.
3. SSE eventLines accumulation is a confirmed logic defect: public response hook accepts a 1,572,913-byte comment block and unterminated multiline events grow across chunks beyond pending-buffer cap. However channel state already has a finite 256-channel times 1-Mi-character bound, and ordinary pull backpressure exists. Withdraw claims that these are wholly unbounded. Whether aggregate cap is acceptable is separate policy; fix complete-event accounting and test it.
4. Content after same-choice finish_reason stop is an invalid Chat Completions fixture. Accepting this malformed stream is not evidence of regression on supported valid streams. DONE/EOF already validate pending tokens. Decide whether finish-time/per-choice terminal validation is required before imposing a production fix. Withdraw prior supported-stream bug characterization.
5. A fully valid Chat Completions response containing a reserved token in message.refusal violates implemented unsupported-token-placement policy: confirmed logic defect, not original-secret disclosure. The choices-empty/metadata example does not establish a UI regression and is withdrawn as that evidence. Add narrow refusal/placement check while preserving the intentional tool-argument token exception; do not restore the whole tree.
6. Legacy replay corruption is a confirmed issued-marker recognition logic defect. Valid sessionID, derived key and queue delivery reproduce intact admission then same-session context redaction with both deterministic keys. The phone detector is behaving according to its rule; do not disable it or weaken assertions. September 29 spec promises prompt/replay stability. Existing admission tests miss this replay boundary.

Summary: definite fixes are request-adapter capacity atomicity, complete SSE event bounds, reserved-token schema/response-placement gates and legacy issued-marker replay recognition. Header/query/numeric coverage, aggregate buffer policy and stricter malformed-stream terminal validation require policy decisions, not automatic source fixes. Green tests can lack these assertions without being incorrect tests.

No source changes, suite reruns or runtime approvals in this reassessment. Current reviewed source hash prefixes H=7e45388c9987, G=a572dd1e77ac, D=dcbd3fb18e03 (H/G transparent HTTP/session modules, D deidentify). Sources unchanged during review. Prior aggregate manifest does not establish per-file historical identity; historical unsaved random failure remains unknown.
