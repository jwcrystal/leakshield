# Sensitive-content continuity in OpenCode — draft spec

Status: Approved for the email de-identification trial. Phase 0 evidence and all
pre-coding security decisions recorded 2026-09-29 (see "Decision record"). Date: 2026-09-29.

## Problem Statement

When an OpenCode agent encounters sensitive text in a prompt, tool result, document, or replayed context, sensitive-guard can block it. This protects the model boundary but repeated blocks interrupt ordinary work. Current irreversible redaction can preserve some surrounding text, yet uses the same marker for different values of one type; an agent cannot tell whether two email occurrences belong to the same person. The user wants fewer interruptions without silently sending secrets to a model, losing the existing CLI/CI/Web UI value, or turning the product into an OpenCode-only plugin.

## Solution

First establish that the existing OpenCode v2 protection works in a real session. Then, subject to explicit approval, trial **de-identify** for one opted-in rule: replace repeated email values with opaque, stable, non-reversible placeholders. The agent can associate records without seeing the addresses. Keep `block` as default; HIGH credentials and any content that cannot be safely transformed remain blocked. **Pseudonymize** (reversible mapping and restoration) is not part of this trial. CLI/CI/Web UI continue their present scan and redact behavior.

The two scenarios below are illustrative hypotheses, not observed user incidents:

- A local CSV or tool result repeats one customer email across records alongside a second customer's email. The agent must group records by customer, not send or use either address.
- A configuration or log result mixes routine information with an API key, possibly alongside an opted-in email. The key must never become model-visible merely because the email is eligible for de-identification.

## User Stories

1. As an OpenCode user, I want repeated MEDIUM email findings to retain an equal-value relationship when I opt into de-identification, so that an agent can group records without seeing raw addresses.
2. As an OpenCode user, I want two different addresses to receive different placeholders, so that the agent does not mistakenly merge records.
3. As an OpenCode user, I want the same address to remain recognizable across prompt text, tool output, and replay within the agreed stability scope, so that the agent does not lose context between steps.
4. As an OpenCode user, I want the default to remain `block`, so that installing the feature does not silently relax protection.
5. As an OpenCode user, I want opt-in restricted to the selected finding rule, so that other findings keep their existing disposition.
6. As an OpenCode user, I want an API key in mixed output to remain protected even when an email is opted in, so that convenience for one rule does not expose another.
7. As an OpenCode user, I want ambiguous, truncated, encoded, unsupported, or unverifiable material blocked, so that partial scanning cannot be mistaken for safety.
8. As an OpenCode user, I want scanner or plugin setup failures to prevent model-bound plaintext when protection is expected, so that errors do not become bypasses.
9. As an OpenCode user, I want the agent to continue using sanitized context where it can safely do so, so that protection interrupts fewer routine investigations.
10. As an OpenCode user, I want placeholders to be data rather than a way to retrieve the original value, so that a copied placeholder cannot be used as a credential.
11. As an OpenCode user, I want to know whether original text persists in local session data or logs, so that I can assess privacy separately from model egress.
12. As a CLI/CI user, I want existing exit codes, JSON fields, and redaction output unchanged, so that automation keeps working.
13. As a local Web UI user, I want existing scan and preview behavior unchanged, so that this OpenCode-only trial does not alter my workflow.
14. As a maintainer, I want a real-v2-session regression test for the model-bound boundary, so that hook-mock tests cannot create false confidence.
15. As a maintainer, I want observed failures and interactions with other plugins documented, so that deployment claims match actual coverage.

## Implementation Decisions

- Use the project vocabulary in the domain glossary: **redact** is irreversible same-type replacement, **de-identify** is a stable replacement with no retained reverse mapping, and **pseudonymize** requires a separately held reverse mapping. Neither implies legal anonymization.
- Reuse the shared detector and the existing OpenCode protection path; add an OpenCode-only, per-rule opt-in disposition. Do not redesign the entire scanner/decision/transports layering or change the generic scan interface.
- Trial scope is the MEDIUM email rule only, with `block` as the default for all installs. **Confirmed 2026-09-29** (user approval); it is not authorization to process every type of PII.
- Stability scope is one live session across prompt admission, tool output, and model-request history. **Confirmed 2026-09-29: per-session key, no cross-restart stability.** Placeholders must be opaque and distinct from current redaction markers; stability does not imply a claim of legal anonymization.
- Non-opted-in findings retain protection. If a mixed-content unit cannot be proved safe in its entirety, block that unit. Never let a HIGH credential pass because an email in the same unit was opted in.
- The new disposition requires an independent safety check: the existing redaction verifier exempts findings inside its own marker shape and must not be treated as a generic de-identification proof.
- No reverse mapping, vault, automatic restore before tool execution, credential handling exception, or mapping file is part of this feature. Copying a valid reversible token would permit replay even if it were signed; that is one reason pseudonymize needs a separate design.
- No existing CLI/CI/Web UI output, HTTP, or exit-code contract changes. Revisit CLI only on evidence of a concrete need.
- A registered fail-closed hook is not the same as a guarantee that the plugin loaded. Scope deployment guarantees separately; do not claim protection in an environment where the plugin may be absent or not registered.

## Testing Decisions

- **Primary/highest seam, confirmed:** observe provider-bound behavior from a real OpenCode v2 session using synthetic canaries. Assert externally visible behavior (no raw canary in outgoing model requests; safe relationship-preserving placeholders where opted in), not private hook registration details. Record OpenCode/plugin versions and how the request was observed. This one seam should cover the complete user-visible path; do not add a new production seam solely for testing.
- Before feature implementation, verify five baseline dimensions: (1) prompt admission and primary, compaction, generate, title, tool-continuation requests; (2) what prompt, context, result, and tool-argument data the session stores; (3) where synthetic canaries appear in logs; (4) invalid config, registration/setup failure, and plugin absence as distinct cases; (5) whether later plugins can reintroduce content. An observed model leak or fail-open bypass blocks rollout. Local persistence is separately recorded and must receive an explicit risk decision.
- At the existing lower-level test seam, cover same-address equality, different-address inequality, mixed MEDIUM/HIGH output, truncation, missing spans, encoded/overlapping findings, unsupported content, verification failure, and default block. Prior art: existing scanner, ingress, redaction-verifier, and v2 fake-hook tests. Preserve these tests but do not substitute them for real-session proof.
- Repeat the real-session check after the trial: synthetic email A twice, B once → A receives one stable placeholder, B a different placeholder, and neither raw address reaches the model; a mixed API key never reaches the model. Inspect local persistence independently.
- Do not use production secrets or customer data in tests or reports. Keep any captured evidence redacted, including failure traces.

## Out of Scope

- Reversible pseudonymization, token vault, local restoration, use of real values in tools, and persistence of mappings.
- Expansion to HIGH credentials or arbitrary detectors, broad DLP, or guarantees of legal anonymization.
- CLI/CI/Web UI behavior changes and scanner redesign.
- Claiming protection when plugin installation/loading is not enforced by the deployment.

## Further Notes

- OpenCode v2 request hooks change outgoing calls, not persisted history; actual persistence and log behavior of this plugin still need measurement. Source: https://opencode.ai/v2/docs/build/plugins.
- **Decision record (2026-09-29, user approval in implementation session):**
  1. Email-only no-restore trial — **accepted** (MEDIUM `PII_EMAIL` only, per-rule opt-in via OpenCode plugin options; default stays `block`; no vault/restore).
  2. Local plaintext persistence — **accepted and documented**. OpenCode v2 itself persists session text in a local plaintext SQLite DB (`opencode.db`) regardless of the plugin (evidence: C4a/C6 in docs/evidence/2026-09-29-opencode-v2-boundary.md). The trial adds no new persistence: no mapping files, per-session in-memory key only.
  3. Restart stability — **per-session only**: placeholders are stable within one live session and change after restart. Implemented as per-sessionID derived keys — HMAC-SHA256 of a master key generated at plugin init with each session's ID — so placeholders from different sessions in the same server process are unlinkable; the master key is never persisted.
- Phase 0 (issue #19) evidence: docs/evidence/2026-09-29-opencode-v2-boundary.md — GO. No model-bound leak on any exercised path; fail-closed verified; plugin ordering did not reintroduce content. Gaps recorded there (real-session compaction unobserved; attachments policy unit-tested only).
- The GitHub tracker and `ready-for-agent` label are configured. #19 is resolved by the evidence report; #20 is unblocked by this decision record.
- Work is tracked in [#19 — real-session boundary verification](https://github.com/jwcrystal/sensitive-guard/issues/19) and [#20 — email de-identification trial](https://github.com/jwcrystal/sensitive-guard/issues/20). #20 has a native GitHub dependency on #19 and remains `needs-info` until the additional human security decisions are recorded.
