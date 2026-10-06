# Agent Transparent Pseudonymization — OpenCode V2

Status: Specification approved for publication; implementation and runtime capabilities are not yet verified.

## Revision Log

### 2026-10-06 (owner-approved)

1. **Attachments policy (`block` / `allow`).** Transparent mode has a configurable `attachments` policy with DLP-standard action names. `"block"` (the default) replaces unsupported media/file parts with an omission-notice text part and never crosses the boundary with the binary; `"allow"` (valid only with `mode: "transparent"`) sends attachments through unscanned with a visible notice part and is an explicit configuration-level decision that the operator vouches for their content. The 2026-10-05 revision's "binary content still never crosses the boundary" applies to `"block"`; non-part-slot attachment shapes still fail closed under both policies.
2. **New-install default and implicit-default migration deferred behind a gate.** User stories 1–3 are not delivered yet; the shipped default remains `block` and no migration mechanism exists. Transparent mode becomes the new-install default only after (a) real-provider end-to-end acceptance passes and (b) owner re-review; until that gate, README and `--doctor` continue to present `block` as the default.
3. **Optional local NER deferred to a follow-up issue.** User stories 28–31 are not delivered in this release: no local NER ships, `--doctor` does not report NER availability, and the bilingual NER evaluation is not a release gate for this release.
4. **Detector and workspace-coverage corrections (match the shipped implementation).** Identity coverage is regex-format only — the Traditional Chinese ID rule is not checksum-validated — and no financial format is enabled by default. Workspace secret-file support is a manual `settings.env_files` allowlist (at most 16 files, 1 MiB each, minimum value length 8, symlink containment, restart required after configuration changes); constrained automatic `.env` discovery is not implemented and is no longer claimed for this release.

### 2026-10-06b (owner-approved)

1. **Refusal reclassified: fail closed on leak risk, not on parse uncertainty.**
   - Reserved-marker-shaped content that cannot be resolved (orphaned, foreign, expired, bare-prefix, or split) is never by itself grounds to refuse a provider-bound request or to block history replay. In model-bound conversation/history and assistant display text it stays literal and the surrounding text is still scanned. In structural identifiers, transport metadata, and numeric positions it is preserved unchanged, visible via the conversation surface (literal token, tool diagnostics) plus a content-free WARN line in the host log — no side files; `--doctor` does not promise degradation-history queries.
   - A provider-bound request is refused only when detected sensitive originals would cross the boundary in a position that cannot be masked, renamed, or preserved without disclosure. History replay never refuses for unresolvable placeholders.
   - Every remaining refusal carries an actionable, content-free message naming the cause (detector/rule, position kind) and the remedy. Known-unsupported routes (WebSocket, `aisdk`, unrecognized dialects) are surfaced pre-flight by `status`/`--doctor` rather than first hit mid-conversation, and degradation notices never enter provider-bound bodies.
   - Tool-side restoration becomes best-effort on the same principle: an unresolved or unsafe placeholder no longer blocks the invocation by default. The affected argument keeps the literal placeholder, the local caller receives an actionable diagnostic naming the rule/type and the recovery step, and the degradation surfaces in-band and as a content-free host-log WARN line. Tool-side execution has no refusal conditions under this policy — the sensitive-original boundary is the provider boundary, and local writes or outbound transmission of restored originals are the intended behavior of restoration. (This revises the same-day earlier consensus of standalone-or-refuse tool restoration.)
   - Overlapping or colliding detector findings are resolved best-effort instead of failing the request: the longest span wins, ties take the earlier finding, and the non-overlap invariant is preserved.
   - This item supersedes: failure-contract bullet 1 (request-stop) to the extent it covered token-type content; failure-contract bullet 2 (tool refusal for unresolved mappings); and the Testing Decisions assertions at spec:156 ("no notice-substituted continuation") and spec:157 ("tool was not executed") for unresolved tool mappings.
2. **Numeric and detector false-positive governance.** Telephone detection becomes opt-in (off in the default profile; the missed-phone trade-off is documented in the profile — no context-guard mechanism). The numeric-field scan is retained but bounded to content positions instead of every numeric value. A default-rule false-positive audit is added to scope: per-rule hit rates on clean, non-dev corpora, with overly broad keyword rules (NDA_KEYWORD-style) narrowed by domain constraints or demoted. Evidence: replay masked 236/237 messages — after refusals are narrowed, over-masking becomes the dominant experience cost.
3. **Deterministic, key-custodied reversible tokens (direction; not scheduled — trigger-gated).** The in-memory session-scoped mapping would be replaced by a deterministic reversible transformation whose key is held in the OS keychain; tokens become stable across restarts and sessions, restoration becomes decryption. This supersedes US7 (per-session mapping isolation), US8 (process-memory-only mappings), the single-process framing of US9, and the Out of Scope entry on persistent reverse mappings; key custody replaces session isolation as the protection boundary and key disclosure — re-identification of all history — becomes the documented central risk. Implementation is triggered only if resumed sessions showing literal placeholders become a real-world annoyance: none of the three reference projects ship persistent keys or cross-restart restoration (their resume behavior is worse — silent pass-through, thrown errors, or literal markers), so item 1's visible degradation is already best-in-class. Placeholders issued before this change are orphaned and governed by item 1.
4. **Default profile (tiering proposal withdrawn).** The deferred default-flip gate stands, simplified: new installations default to transparent pseudonymization once the refusal-policy revision (P1) lands and the C-matrix is green. The real-provider E2E gate is removed — dogfooding has already caught what scripted E2E would not, and the audience before npm publish is the owner; a post-P1 live pass is a self-check note, not a gate. One-way masking is a degraded/fallback profile (keychain unavailable, conservative contexts), not the default — single-way display of placeholders contradicts the zero-friction experience goal. This item records the withdrawal; US1 is unchanged.
5. **Layering posture.** Session hooks provide best-effort early protection and user-facing notices; the provider wire layer remains the enforcement and evidence boundary. Supported-route refusals (WebSocket, `aisdk` routes, unknown/mixed dialects) are unchanged — they are leak-risk refusals, not parse-uncertainty refusals.

## Problem Statement

Sensitive Guard protects model-bound content today, but blocking or irreversible replacement can interrupt an agent's work. Users need the agent to distinguish sensitive records, use original values in permitted local tools, and present readable results without routinely sending detected sensitive values to an LLM provider.

The approved email de-identification trial deliberately retained no reverse mapping and kept block as the default. It is not sufficient for this workflow and must not be retroactively described as reversible.

The target user is one person running OpenCode locally, potentially with multiple sessions, using either the OpenCode TUI or OpenChamber. The primary goal is continued normal work after installation, not a new sandbox or a separate authorization system for every use of an original value.

## Solution

Introduce transparent **pseudonymization** for the OpenCode V2 plugin: replace detected sensitive values with stable opaque placeholders before supported model requests, retain session-scoped reverse mappings in memory, and automatically restore known placeholders for tool execution and supported local presentation paths.

Users continue to read original values and use ordinary OpenCode tool permissions. Local history, logs, exports, and generated files may contain originals; the product does not promise that plaintext never reaches disk. Each subsequent model request must be protected again regardless of what the local history contains.

The detector policy is layered. Common credentials, known secrets, and supported structured PII are enabled by default. Broad, ambiguous categories are not indiscriminately replaced. Local NER is optional and requires separate model provisioning; its declared Chinese and English capabilities must be independently evaluated.

New installations should use transparent mode by default. Existing explicit block/redact settings remain effective, and existing implicit defaults require an explicit migration path rather than a silent change to credential restoration.

## User Stories

1. As an OpenCode user, I want new plugin installations to use transparent protection by default, so that normal agent work does not require configuring each sensitive operation. *(Deferred: see the 2026-10-06 revision item 2.)*
2. As an existing user, I want my explicitly chosen block or redact behavior preserved, so that an upgrade does not silently weaken my chosen policy.
3. As an existing user with an implicit default, I want a clear migration notice and choice, so that credential restoration is not enabled without my awareness.
4. As a user, I want detected sensitive values replaced before model requests, so that the provider does not need the original values to perform the task.
5. As an analyst, I want repeated values represented consistently within a session, so that the agent can group and compare records.
6. As an analyst, I want different original values to remain distinguishable, so that unrelated records are not merged.
7. As a user, I want reverse mappings isolated by session, so that another session cannot restore my placeholders.
8. As a user, I want mappings retained only in process memory, so that this feature does not introduce a persistent reverse-mapping database.
9. As a user running a long task, I want live mappings retained without a short fixed TTL, so that a continuing task does not unexpectedly lose its values.
10. As a user, I want bounded mapping storage with a clear capacity failure, so that memory does not grow indefinitely or silently lose live mappings.
11. As a user, I want mapping loss reported when an operation requires an unresolved placeholder, so that a placeholder is not used as a real email, credential, or other value.
12. As a user, I want only the affected tool operation stopped when restoration fails, so that unrelated work can continue.
13. As a user, I want actionable recovery guidance after restart or clearing, so that I can reread the source and refresh the affected task context.
14. As a user, I want known placeholders restored automatically in tool inputs, so that permitted commands receive the values needed to work.
15. As a user, I want existing OpenCode tool permissions to remain authoritative, so that I do not encounter an additional approval prompt for every original-value use.
16. As a developer, I want restored values to preserve their exact content and argument semantics, so that quoting or normalization does not change a command's meaning.
17. As a user, I want assistant responses displayed with originals automatically in the TUI, so that results are readable without manually expanding placeholders.
18. As an OpenChamber user, I want the same readable responses, so that using a different client does not break the workflow.
19. As a user, I want tool results to be readable locally while their later replay is protected, so that local presentation does not leak values through the next model request.
20. As a user, I want titles, compaction, auxiliary generation, and history replay protected as well as the main turn, so that less-visible requests do not bypass protection.
21. As a user, I want supported streaming responses covered, so that the protection does not work only for non-streaming calls.
22. As a user, I want credentials and known secrets protected by default, so that API keys and tokens are not excluded merely because another SDK defaults secret detection off.
23. As a user, I want common supported structured PII protected by default, so that email, telephone, and validated financial or identity formats receive useful coverage. *(Amended: see the 2026-10-06 revision item 4.)*
24. As a developer, I want public URLs, ordinary dates, and program symbols to remain useful unless a relevant detector or explicit rule identifies sensitive content, so that protection does not unnecessarily degrade coding tasks.
25. As a user, I want secret values inside a URL protected even when generic URL detection is disabled, so that the URL policy is not a credential bypass.
26. As a user, I want constrained automatic discovery of supported workspace secret files, so that known-value protection does not require manually listing every ordinary .env file. *(Amended: see the 2026-10-06 revision item 4.)*
27. As a user, I want explicit sensitive values and custom patterns supported, so that project-specific identifiers can be protected without universal NER.
28. As a user, I want local NER available as an optional capability, so that I can add contextual PII detection when its resource cost is acceptable. *(Deferred: see the 2026-10-06 revision item 3.)*
29. As a Chinese and English user, I want Traditional Chinese, Simplified Chinese, English, and mixed-text NER evaluated, so that a type name or locale hint is not mistaken for reliable language coverage.
30. As a user, I want model download requirements and detector availability reported clearly, so that missing NER does not silently masquerade as full contextual PII protection.
31. As a user, I want detector processing to avoid sending original text to a remote inference service by default, so that privacy detection does not create another disclosure path.
32. As a maintainer, I want established CLI, CI, Web, redact, block, and de-identification behavior preserved, so that this agent feature does not cause unrelated regressions.
33. As a maintainer, I want acceptance checked at the actual provider boundary and in the real clients, so that hook registration alone is not treated as proof of correctness.
34. As a user, I want the limitations stated plainly, so that I do not mistake provider-context protection for prevention of tool-based exfiltration or legal anonymization.

## Implementation Decisions

### Scope and trust boundary

- Target OpenCode V2 and both the OpenCode TUI and OpenChamber for the first release. Do not infer V1 support from an existing compatibility entrypoint; preserve its established behavior and document support separately.
- Cover both PII and credentials in transparent mode. The local reporting workflow is an acceptance example, not an exclusive allowlist of supported tools.
- Protect detected values in supported provider-bound requests. This is not a claim that every sensitive value can be detected.
- Accept local originals in chat history, outputs, files, and logs. Memory-only mappings do not imply plaintext never reaches disk.
- Retain existing OpenCode tool permissions. Do not introduce per-export approval, tool/argument/destination authorization policies, or a mandatory manual reveal UI.
- Do not promise control over arbitrary tool network egress, direct access to source files/environment variables, or malicious local clients. A permitted tool may use or transmit originals.

### Modes, migration, and compatibility

- Add transparent pseudonymization as a distinct mode rather than silently changing the semantics of irreversible redact or de-identify.
- Keep the existing email de-identification trial irreversible; it remains a separate feature and historical specification.
- Make transparent mode the new-install default. Preserve explicit legacy policies. Distinguish existing implicit-default installations before changing their behavior; define and test a practical migration mechanism before releasing the new default. *(Deferred: see the 2026-10-06 revision item 2.)*
- If reliable new-versus-existing-install detection cannot be established, require explicit adoption for ambiguous installations. Do not silently treat every omitted mode as consent to credential restoration.
- Keep agent detector defaults separate from global scanner defaults so that CLI, CI, and Web behavior is unchanged.

### Hooks and capability gates

- Use OpenCode lifecycle hooks to protect assembled model requests, restore tool inputs before execution, and restore responses/tool results along proven local delivery paths.
- Manage mapping lifetime explicitly. Hook registration does not establish session-end detection, durable resume, eviction safety, or response persistence semantics.
- Verify the installed runtime and plugin API, event ordering, supported response transports, and mutation semantics before choosing concrete restoration hooks.
- A provider HTTP-response hook is not a generic client-display hook. Do not claim it restores assistant text for both UIs solely because it exists.
- Provider HTTP streaming and WebSocket transport are distinct. Enumerate and prove supported routes; do not enable an unprotected route under a blanket model-boundary guarantee.
- Prefer one server-side integration for both clients if runtime evidence supports it. Client adaptation is permitted if necessary for automatic presentation, but strict display-only isolation is not required. Avoid unrelated client changes.
- Every supported provider-bound request must be protected, including tool-driven continuations, restored local history, title, compaction, and auxiliary generation. Reuse the current strict boundary behavior for scan truncation, encoded content, and unscannable input rather than forwarding unchecked content. **2026-10-05 revision (owner-approved)**: unsupported attachments are no longer a hard refusal in transparent mode — media/file parts are replaced with an omission-notice text part (strip-and-notify, the mainstream DLP action); binary content still never crosses the boundary, and non-part-slot attachment shapes still fail closed. *(Amended by the 2026-10-06 revision item 1: the never-crosses rule applies to the default `block` policy; `allow` is scan-free by explicit configuration.)*
- In-text ignore directives must not disable model-boundary protection. Verify the actual request after interaction with other plugins; plugin ordering is part of the compatibility evidence.

### Mapping and restoration

- Maintain a bidirectional mapping in memory, scoped to the actual OpenCode session identity. Do not add SQLite or another persistent mapping store in this release.
- Use stable opaque placeholders for repeated values in a live session and keep distinct originals distinguishable. Preserve exact originals for restoration; do not inherit normalization that can destroy distinctions merely because it was acceptable in the irreversible email trial.
- Restore only registered placeholders from the requesting session. Do not infer an original from a placeholder's spelling or from another session's mapping.
- Reuse issued-placeholder recognition for unresolved-token detection. A foreign or expired placeholder requiring restoration must not be accepted as a real value.
- In ordinary model-bound conversation/history text and assistant display text, unknown or malformed reserved-marker strings are literal content, not restoration requests. Continue scanning their surrounding text for sensitive content; do not grant marker ownership. Keep structural identifiers, transport metadata, and tool arguments that require restoration strict.
- Cover supported nested tool inputs and key/value structures without silently creating key collisions or changing types.
- Preserve shell and tool argument semantics. Naive substitution inside shell syntax is not accepted as proof of safe restoration; define a supported restoration strategy, test quotes/newlines/metacharacters, and stop the affected operation when correct restoration cannot be guaranteed. This is input integrity, not a new destination-approval system.
- Retain active mappings without a short fixed TTL. Use explicit clearing/session disposal where supported and process shutdown as known lifetime boundaries. Treat archival, idleness, and actual task completion as different states; do not infer safe clearing from a transient idle event.
- Set documented per-session and aggregate memory limits. Do not silently evict live mappings. At capacity, fail closed for affected new content while preserving usable existing mappings and unrelated work.
- Restart, explicit clear, or reclamation invalidates the affected memory mappings. Block only tool operations requiring unresolved values and provide recovery guidance. Rereading a source does not guarantee the old placeholder becomes valid again; refresh affected references/context rather than guessing.
- Initialization, scanning, and mapping errors must not forward affected originals to the provider as a fallback. Do not log reverse-map contents for diagnostics.

### Failure contract agreed with issue #21

- When transparent mode cannot safely protect required model input, stop that affected model request before dispatch. Do not replace the required input with a blocked-content notice and continue reasoning with incomplete data. Successfully pseudonymized sensitive content is not a failure.
- When a tool requires an unresolved mapping or restoration cannot preserve its input semantics, refuse that affected tool invocation before execution and without its side effects. Preserve the session and unaffected live mappings; unrelated operations may continue.
- Recovery from mapping loss is manual in this release. Tell the user to provide or reread the source and refresh affected references/arguments. Do not automatically reread sources, reconstruct missing originals, or assume a newly issued placeholder validates an old one.
- A later invocation may proceed only when its current parameters can be fully and correctly restored. Identical unresolved invocations remain refused. Do not create a plugin recovery/retry loop, drop required data to make a retry succeed, or claim to control all agent-level retries.
- Errors identify the safe rule/type identifiers, failure boundary, and actionable recovery steps without originals, finding previews, reverse-map contents, or sensitive dynamic identifiers. Use a generic safe category if no rule applies; this restriction is for guard-generated diagnostics, not a promise that all local logs are plaintext-free.
- Preserve normal notify behavior for existing explicit block mode and its established initialization fail-closed behavior. A general notify/abort blockPolicy remains a separate design task in issue #21 and is not a release prerequisite or added configuration burden for issue #22.
- Stopping one request or invocation is not a guarantee that the entire task/session has terminated. Prove refusal, error propagation, and subsequent behavior with runtime tests. Hook exceptions, provider retry controls, or session interruption APIs are implementation candidates, not evidence of complete agent retry control.

### Detector policy and dependencies

- Default-enable common credential formats, known secrets, email, telephone, and validated supported financial/identity formats. Publish concrete format and region coverage rather than claiming every national identifier is covered. *(Amended by the 2026-10-06 revision item 4.)*
- Prioritize Taiwanese identity/telephone fixtures and common international formats; separately document supported regions. Language coverage is not the same as identifier-region coverage.
- Do not indiscriminately enable generic URL, IP-address, date, organization, or place detection. Explicit sensitive values/custom rules may still protect such content, and credentials embedded inside URLs remain protected.
- Distinguish a contextual date of birth from an ordinary date. An organization's NER label alone does not establish whether its name is confidential.
- Add constrained workspace .env discovery and explicit known values using existing exact-value mechanisms. Define supported filenames, bounded discovery/loading, excluded dependency/generated directories, symlink containment, refresh/invalidation behavior, and short-value handling. Do not scan arbitrary files outside the approved workspace scope. *(Amended by the 2026-10-06 revision item 4.)*
- Reuse current detectors where suitable. Evaluate independently usable Rehydra recognizer/NER capabilities before adding a dependency; do not install a second overlapping OpenCode plugin or commit to the entire SDK without checking its boundaries.
- Review dependency licensing, maintenance, runtime compatibility, resource use, and whether detector APIs can be used without an unwanted parallel mapping pipeline. If unsuitable, evaluate another detector/model rather than automatically building a new NER engine.
- Enable credential detection explicitly if a reused SDK makes it opt-in. Our defaults are product decisions, not the dependency's defaults.
- Make NER optional, using local inference by default. Explain model download, startup, disk, RAM, and inference costs. Model weights need not be committed into the application package.
- Require tested Traditional Chinese, Simplified Chinese, English, and mixed-language coverage for the optional NER capability. Do not claim Chinese names/addresses are automatically covered in the default regex/exact-value profile.
- Report disabled, missing, failed, or unavailable NER accurately. Do not silently present fallback regex coverage as full contextual PII protection. Define a visible degraded-mode policy before release.
- Calibrate category-specific thresholds using evaluation data rather than copying example confidence scores. Overlapping detections must preserve restoration integrity and must not hide credentials under a lower-risk category.

## Testing Decisions

- Test externally observable behavior, not private map layouts, exact helper names, or the mere presence of a registered hook. Stable relationships, restoration outcomes, request contents, and failure behavior are the relevant assertions.
- Use the existing mock-provider boundary E2E harness as the principal seam. It already runs real OpenCode against a capture provider and tests admission, tool replay, ordering, auxiliary requests, and resume. Extend it rather than building a new product test API.
- Keep unit tests for strict ingress protection, mapping behavior, configuration, and detector quality. They complement rather than replace the real provider/client evidence.

### End-to-end acceptance

- Place synthetic canaries in a prompt, a source file, an approved tool response, nested object keys/values, and configured known-secret sources. Capture every supported provider request and assert that the expected originals are absent and appropriate stable placeholders are present.
- Verify the mock provider can return placeholders that a real tool receives as the exact originals. Cover PII and synthetic credentials; never use production secrets in evidence artifacts.
- Verify a local report and an existing-credential task with a local mock service complete using originals. Cover controlled secret-file generation as an additional tool-input/output scenario without external publication.
- Exercise shell quoting, whitespace, newline, Unicode, and metacharacter values. Assert intended arguments and effects, and assert safe refusal when restoration would change syntax or cannot be supported.
- Verify assistant and tool-result presentation in actual OpenCode TUI and OpenChamber clients. Provider capture alone does not prove UI restoration; document tested versions and collect client-specific evidence.
- After restored local presentation/history, continue the conversation and assert that originals remain absent from subsequent provider requests, including title, compaction, auxiliary calls, and resumed-history requests.
- Exercise supported streaming paths and explicitly account for any unsupported transports. A non-streaming success is not evidence for streaming or WebSocket safety.
- Exercise both plugin orderings with a canary-injecting companion plugin. Verify actual request contents or record and enforce a compatibility limitation; do not assume hook order provides complete protection.
- Test same-session resume while mappings are alive and restart resume after mappings are lost as different scenarios. Restart must not produce guessed or literal-placeholder tool actions.
- Keep the no-plugin expected-leak case as evidence of the deployment boundary, not a product failure.
- For unprotectable required input, assert that the affected provider call is not dispatched and that no notice-substituted continuation is used in its place. Attribute captures to the failed operation: unrelated title/auxiliary calls are not evidence that the failed call was dispatched.
- For unresolved or unsafe tool restoration, assert that the tool was not executed, its side effects are absent, the error is actionable and contains no synthetic original or preview, and unrelated valid operations remain usable.
- After mapping loss, assert that the plugin does not automatically read sources or retry restoration. A repeated unresolved call must still have no side effects; a manually refreshed invocation with valid current references may execute normally. Observe any runtime agent retries explicitly without claiming that the plugin terminates the whole session.

### Mapping and configuration acceptance

- Verify repeat stability, different-value distinction, exact restoration, session isolation, forged/foreign/expired placeholders, clearing, restart loss, and bounded capacity behavior.
- Verify existing mappings are not silently evicted at a limit and unrelated operations remain possible after an affected restoration failure.
- Verify model-boundary failures never fall back to raw originals, including unsupported input, scan limits, ignored directives, encoded canaries, and invalid initialization/options.
- Verify nested tool inputs and key collision handling, and ensure diagnostics do not dump originals or map contents.
- Verify default new-install behavior, explicit legacy-policy preservation, implicit-default migration, optional NER availability reporting, and unchanged non-agent defaults.
- Preserve existing block/redact/de-identification regression tests. Do not impose a plaintext-free local-history requirement on transparent mode.
- Keep existing block notify regression cases separate from transparent-mode request refusal. Verify established initialization fail-closed behavior and safe failure diagnostics without adding a generic blockPolicy option.

### Detector and NER acceptance

- Build category- and region-labelled fixtures with positive and negative examples. Report precision and recall separately by type and, for NER, by language; one aggregate score is insufficient.
- Include Traditional Chinese, Simplified Chinese, English, mixed-language text, names/addresses in prose and structured records, and ordinary coding contexts.
- Include public documentation URLs, IP literals, release dates, function names, package names, and public organization names as negative/control fixtures for the selected default policy.
- Test short/common known values, overlapping findings, configured URL secrets, .env changes, symlink escapes, excluded directories, loading limits, and exact-value refresh behavior.
- Define dataset-specific release thresholds before implementation sign-off. Require zero original-canary occurrences in the covered provider-boundary scenarios; do not extrapolate that result into universal detection completeness.
- Measure startup, warm/cold inference latency, peak memory, and model provisioning for the candidate local NER on documented hardware. Do not treat published SDK example timings as our measured performance.
- Verify NER processing itself does not transmit fixture text to a remote inference service under the default local configuration.

## Out of Scope

- Persistent or encrypted reverse-mapping databases, cross-restart restoration guarantees, and sharing mappings between users or sessions.
- A separate original-value authorization system, per-export approval, destination-aware tool policies, network egress enforcement, or a complete execution sandbox.
- Guarantees that local chat history, logs, caches, clipboard content, screenshots, or generated files never contain originals.
- Mandatory click-to-reveal presentation, strict separation between UI projections and canonical persisted history, or a new standalone reveal dashboard.
- Changing CLI, CI, or Web scanner defaults; replacing or rebranding the approved irreversible email trial.
- Automatic new-feature support for OpenCode V1, other agent runtimes, shared multi-user services, all languages, or every jurisdiction's identifiers.
- A bespoke NER training pipeline, guaranteed legal anonymization, complete secret detection, or prevention of all tool-based disclosure.
- Automatic source rereading/reconstruction after mapping loss, a plugin-owned recovery retry loop, and the general blockPolicy design deferred to issue #21.
- Unrelated refactoring and overwriting existing uncommitted work.

## Further Notes

- This specification supersedes earlier conversational proposals for mandatory per-operation approval and strict plaintext-free history. Those stronger policies may be considered separately, but are not prerequisites for transparent mode.
- The failure-contract discussion for issue #21 is settled for transparent mode: refuse affected requests/tools, provide safe diagnostics, and require manual mapping recovery. The remaining generic blockPolicy design stays open; do not close issue #21 or treat it as a blocker requiring a new policy option for this release.
- Preserve the domain distinction: **redact** is irreversible replacement, **de-identify** retains stable relationships without a reverse map, and **pseudonymize** retains a reverse map. None establishes legal anonymization.
- Recommended delivery order: (1) runtime/hook and dependency feasibility gates, (2) complete transparent flow using existing detectors, (3) expanded structured/known-value detection, (4) optional local NER and its bilingual evaluation. This is implementation sequencing, not permission to declare the complete scope delivered after the first slice.
- Before release, settle concrete mapping limits, configuration schema, migration mechanics, .env discovery boundaries, NER model selection, quality thresholds, and the supported runtime/transport matrix. These are bounded implementation gates, not claims of already-established APIs or results.
- A ready-for-agent label means the implementation objective and its gates are specified. It does not mean the hooks, dependency suitability, bilingual quality, or dual-client behavior have already passed verification.
- Reference implementations inform mechanisms, not proof of our safety or compatibility: official Rehydra, the EightDoor integration, and the inspected Vibeguard plugin use in-memory mappings in the examined revisions. Rehydra SDK SQLite support does not imply the plugin persists mappings.
- Reference documentation: [Rehydra PII types](https://docs.rehydra.ai/concepts/pii-types), [OpenCode plugin](https://docs.rehydra.ai/guides/opencode-plugin), [NER detection](https://docs.rehydra.ai/guides/ner-detection), [OpenCode V2 plugins](https://opencode.ai/v2/docs/build/plugins).
