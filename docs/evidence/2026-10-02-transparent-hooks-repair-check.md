# Transparent hooks: second user-repair check

Designated oracle: openai/gpt-6.1-sol#high, session ses_f049a01bbffejeUK7XfIUZmLyW. Read-only review and offline diagnostics; no source edits, staging/commits, installs, network or runtime. Classification follows the corrected policy/fixture distinctions, not earlier blanket defect claims.

## Verdict and snapshot limitation

- Issue 22 offline integration slice: corrections required for remaining confirmed cases below.
- Issue 20: ordinary same-session replay accepted; capacity/eviction behavior still requires correction.
- Review is NOT acceptance of the current entire checkout: src/opencode-transparent.ts changed externally during review from hash prefix f96bff2b625df80c to 35b7af39e20a5d97 (474 to 549 lines). The newer session guard was not retested. Other nine checked file hashes remained unchanged.
- No full issue-22, task continuity or isolated-load approval. Typed token-bearing tool behavior, exclusive targeting, auth/config provenance and containment still unproven.

## Closed cases

Safe context followed by 128 unsupported image requests no longer consumes capacity; fresh sensitive context succeeds. Owned schema keys, nested enum/tool-name tokens and valid message.refusal tokens are refused. Actual tool argument placeholders are retained. ASCII unterminated SSE accumulation rejects before output and cancels upstream. Legacy prompt/context replay succeeds for both fixed keys with actual session identity/derived keys/queue delivery; cross-session marker ownership is not exempted.

Shared scanner exceptions passed neighbor, crossing, marker-lookalike, encoded and truncation checks. No weakening of default scanner policy observed. Legacy block/redact/V1/env regressions passed. Do not revive withdrawn header/query or invalid terminal-stream findings without their now-defined policy.

## Remaining findings

### HIGH: arguments post-mask rejection still consumes capacity

src/opencode-transparent-http.ts:386,407–409. Valid serialized arguments with numeric pin 10912345678 match the default phone detector. String masking makes serialized arguments invalid JSON; validation refuses only after core protection commits. Public diagnostic capacity.after-arguments-postmask-rejection: 128 refused sessions exhaust capacity and a fresh sensitive context fails.

Minimum correction: parse arguments first, produce a safely serializable validated structure and complete protection as one operation before committing. Preserve numeric-policy refusal and core transaction guarantees; do not weaken detector or merely hide tracking.

### Conditional MEDIUM: SSE cap uses UTF-16 units, not bytes

src/opencode-transparent-http.ts:731–734,758–759. Eight 64-Ki-character UTF-8 chunks allow an event of 1,572,903 bytes under a stated 1-Mi-byte interpretation. ASCII bound is fixed. Source measures string length and appends before checking.

Choose explicit units: if contract is 1 MiB, account UTF-8 bytes before accumulation; if character cap is intended, document that choice and bounded byte implication. Existing channel/pull state is finite, not universally unbounded. Do not classify this policy ambiguity as unconditional disclosure.

### MEDIUM: reserved-placement exemptions too broad

src/opencode-transparent-http.ts:166–173,495. Placement traversal ignores object keys and exempts any subtree named arguments. A valid choice with token-bearing metadata key, or metadata.arguments string, does not reject.

Minimum correction: inspect keys and restrict exemptions to actual protocol tool-call argument string paths. Preserve intentionally tokenized tool arguments; avoid whole-response restoration.

### MEDIUM: legacy registry saturation/eviction corrupts replay

src/decision/deidentify.ts:172–174 and src/opencode-v2.ts:267–269. At 4096 issued-marker entries new markers are still produced without retained ownership. At 256 sessions eviction loses ownership. Later replay partially phone-redacts tokens; deterministic examples include reach [SG-EMAIL-f1292[REDACTED_PII_PHONE_TW]4] now and reach [SG-EMAIL-4[REDACTED_PII_PHONE_TW]8d6c9] now.

Minimum correction: fail statically on new issuance beyond capacity; after ownership loss reject unknown reserved markers, not partial rewrites or blanket marker exemptions. Preserve detector/lookalike safety and test saturated/evicted sessions.

## Checks performed once

- Focused nine files: transparent, entry, V2, deidentify, scanner, verifier, pseudonymization, redaction, ingress: 270 passed.
- Typecheck: pass.
- npm test -- --exclude tests/web.test.ts: 488 passed, 23 files. Full suite including HTTP-server web tests not executed in read-only/no-runtime review.
- Three batches of bounded in-memory Node/tsx diagnostics: 17 cases, 9 successful assertions, 6 expected product assertions failed, 2 fixture preparation cases did not produce the intended scanner match. No random suite retry loop.

Stable hash prefixes: HTTP 090e182b1fc4a33b; deidentify 0633c1ecc1540b05; V2 8d91515dea53fdca; engine ae7d8690ff3150fd; verifier a9caf1e58742e7ce; entry fcd6fc69ecfcd037; transparent test ab7818aa1c0e8939; V2 test c322210a240b0d2f; entry test 115f0c360c4cef51.

Next review should use a frozen source snapshot without parallel edits. No implementation or runtime authorization is implied by this report.
