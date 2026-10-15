# Issue 22 transparent hooks: independent review

## Disposition

Designated oracle: openai/gpt-6.1-sol#high. Result: **NEEDS REPAIR; no isolated-load approval**. This report records the oracle's read-only source review and bounded synthetic diagnostics, not a production/runtime test. Existing block/redact/V1/env defaults remain unchanged by the entry diff. Offline core acceptance is separate from this rejected integration slice.

Parent verification before review: focused hooks/entry 55/55, typecheck pass, full suite 469/470 with one legacy failure. Oracle did not rerun suites. No runtime, provider/network calls, source writes, installs or staging/commits were performed by this review. Initial Bun preload and missing-file lookup diagnostics failed before successful checks; preserve that history.

## Confirmed hooks defects and bounded repair requirements

| Severity | Location at review | Finding | Required correction and regression |
| --- | --- | --- | --- |
| HIGH | src/opencode-transparent-http.ts:80–100,200–208; src/opencode-transparent.ts:249–307 | Unsupported transport passes through. No model.request gate; Anthropic-shaped /v1/messages body retains raw top-level system/tool descriptions. Custom sensitive headers and bodyless query content pass. Owned tokens in text/plain responses pass unchanged. | Verified routing gate; strict supported dialect/content-field validation; explicit unsupported-response policy. Reproduce all examples while preserving legitimate authentication headers. |
| HIGH | src/opencode-transparent.ts:200–213 | Whole-tree protection changes protocol structure: message IDs, tool names, schema property names and enum values can be rewritten. | Atomic content-aware projection; preserve structural identifiers and reject unsafe structural content rather than silently rename. Test sensitive-looking IDs/names/schema constraints and supported content protection. |
| HIGH | src/opencode-transparent.ts:103–111,240–243 | Tool token refusal examines values but misses object keys. Token-keyed arguments escape the refusal gate. | Inspect keys and values; test nested owned and foreign reserved prefixes in keys. |
| HIGH | src/opencode-transparent-http.ts:329–334 | SSE token split after prefix characters 1, 3 or 5 emits literal token; split after 6 restores. | Retain suffix matching every partial reserved prefix; test all prefix split points and interleaved choices. |
| HIGH | src/opencode-transparent-http.ts:81,216,360–450; src/opencode-transparent.ts:183–185 | JSON buffers before limit checks; SSE eagerly drains into an unbounded downstream queue; channel count and failed-session IDs unbounded. Oracle observed sixteen upstream chunks consumed without downstream reads. | Capped body reads, pull-based backpressure and aggregate/channel/session limits. Test small limits, unread consumers and failed sessions. |
| MEDIUM | src/opencode-transparent-http.ts:380–394 | Valid multiline SSE data events are rejected. | Parse complete events and join data lines; test multiline JSON, framing and cancellation. |
| HIGH/MEDIUM | src/opencode.ts:80–99 | Transparent initialization fallback omits HTTP/WS/AISDK refusals; successful setup discards guard cleanup. Installed plugin.d.ts:54–57 permits returned cleanup. | Comprehensive transparent fail-closed fallback and return guard.dispose; test initialization failure and host-triggered cleanup. |

Existing safeguards observed: atomic four-kind snapshots, exact-session core, private request correlation, JSON display-only restoration, tool argument placeholders preserved, native Request reconstruction and explicit WS/AISDK refusals. Their presence does not close the defects above.

## Legacy email test: deterministic diagnosis

Failing assertion: tests/opencode-v2.test.ts:239, test starting at :220, `replaces repeated emails with one stable per-session placeholder at prompt admission`.

Oracle reproduced via the public createV2Setup API using a synthetic 32-byte key: thirty zero bytes followed by bytes 02 and 01. No mocks needed. Synthetic bob placeholder contains digits 0933589727, matching the Taiwan phone detector at src/rules/builtin.ts:130. Final verification/redaction at src/decision/deidentify.ts:145 redacts inside the generated token:

`Email [SG-EMAIL-7a7021cc0a7cb579] twice: [SG-EMAIL-7a7021cc0a7cb579] and [SG-EMAIL-9315e[REDACTED_PII_PHONE_TW]9] once.`

Three SG-EMAIL prefixes and two Alice tokens remain, but the Bob token no longer matches the expected sixteen-hex-character grammar. Filtering the recognized placeholders consequently yields an empty array instead of one Bob token.

This is a confirmed legacy defect, not a demonstrated transparent-default regression. The original failed run's random key was not captured, so its exact historical cause is unproven. The older offline-core 57/58 failure remains separately unidentified.

Proposed separately scoped legacy correction: protect only validated issued-placeholder spans during final verification, while retaining neighbor and crossing-sensitive detection. Add this fixed-key regression; do not weaken the assertion, disable phone detection or exempt arbitrary marker-shaped strings. This report does not authorize or implement that correction.

## Remaining functional and runtime gates

No pinned typed tool adapters exist. Currently token-bearing calls are refused, so even repaired refusal does not provide issue-22 transparent task continuity. Safe typed adapters and shell semantics remain unresolved.

Before isolated plugin loading, establish exclusive targeting, configuration/credential provenance, no fallback to shared or real provider service and independently enforced containment. Standalone/server flags alone are not proof. Do not run the old restoration probe or blind authentication discovery. No global config changes, runtime approval, release readiness or complete issue-22 delivery follows from this report.

## Next action

Produce a bounded recovery plan for hooks defects and separately approve the legacy correction, implement regressions first, then focused/typecheck/full offline verification and independent review. Do not substitute repeated green random runs for the deterministic legacy reproduction. No source corrections have been made by this report.

## Delayed original oracle report — corroborating evidence

The original designated oracle session ses_… subsequently completed. Its earlier absence was an unavailable result, not evidence of a completed review. The report independently confirms corrections required and runtime NO-GO, with no edits, suite reruns, network or runtime launches. One in-memory diagnostic syntax error was corrected without source changes.

Additional confirmed details:

- Final-wire protection misses tools/descriptions/schema keys, metadata, user and arbitrary message fields. A synthetic request retained seven raw credential occurrences and its original identity. A /responses URL was accepted solely because its body contained messages; bodyless requests skip validation. Validate route/dialect and cover or refuse sensitive fields without renaming structural identifiers.
- A split token prefix [SG followed by its remainder escapes restoration/unknown-token validation. Retain the longest suffix matching any partial reserved prefix, including unknown/expired token cases.
- Eager SSE start consumed twenty upstream chunks without downstream reads. Consumer-driven pull, aggregate/channel limits are required. A pending token followed by finish_reason stop was emitted before later restored content; finish ordering must refuse or resolve pending state before terminal emission.
- Tool object-key bypass and discarded host cleanup remain confirmed. Session IDs retained before validation also bypass mapping/session accounting.

Independent legacy reproduction: a 32-byte key computed as SHA256 of the synthetic string oracle-deidentify-204. The actual legacy prompt hook changes Bob placeholder [SG-EMAIL-09469432970958a6] into [SG-EMAIL-[REDACTED_PII_PHONE_TW]0958a6], reproducing assertion 239:64 (expected one filtered placeholder, received zero). This corroborates the same phone-detector/issued-placeholder corruption mechanism with a second deterministic key. No new-test crypto/environment mock or default-mode regression was found. Neither reproduction establishes the exact unsaved historical random key.

Reports agree on separate legacy correction and bounded hooks repair, preserving the accepted pseudonymization core. No pinned builtin tool schema or permission-ordering proof was found; registry declarations alone are insufficient. No change to implementation, acceptance, runtime authorization or global configuration follows from the delayed report.
