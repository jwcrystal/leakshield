# Mandatory Ingress Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make brokered MCP deployments the formal mandatory ingress gate, while preserving CLI as a supported operator interface and keeping Web outside the formal security claim.

**Architecture:** Keep one shared pipeline for detection, decision, redaction, and transport-safe shaping. MCP becomes the only claim-bearing broker path for brokered deployments, CLI remains a first-class local/scripted mode, and non-broker/demo surfaces are explicitly excluded from the security claim.

**Tech Stack:** TypeScript, Node.js, MCP SDK, Vitest, Zod

---

## File Structure

### Core runtime and policy files

- Modify: `src/transports/mcp.ts`
  - Make broker semantics explicit and consistent for `ALLOW`, `WARN`, `CONFIRM`.
- Modify: `src/transports/mcp-payload.ts`
  - Keep MCP payload assembly aligned with the shared decision/redaction contract.
- Modify: `src/transports/cli.ts`
  - Preserve scan/redact/dry-run operator flows while aligning wording and JSON output to the formal architecture.
- Modify: `src/transports/web.ts`
  - Keep demo behavior, but explicitly mark it as non-claim-bearing and scan-only.
- Modify: `src/decision/model.ts`
  - Resolve merge-conflict state and stabilize the single decision contract.
- Modify: `src/decision/redaction.ts`
  - Keep transport-safe shaping centralized and explicit.

### Tests

- Create: `tests/web.test.ts`
  - Lock down Web as a demo-only, scan-only surface.
- Create: `tests/claim-boundary.test.ts`
  - Lock down formal claim wording without importing bootstrap entrypoints.
- Modify: `tests/decision.test.ts`
  - Lock down the unified decision contract.
- Modify: `tests/mcp-payload.test.ts`
  - Lock down MCP-safe payload shaping.
- Modify: `tests/mcp.test.ts`
  - Verify broker semantics and no raw content leakage.
- Modify: `tests/cli.test.ts`
  - Verify CLI remains operator-mode and does not leak transport-unsafe fields.
- Modify: `tests/redaction.test.ts`
  - Verify canonical transport-safe shaping and deterministic redaction behavior.

### Documentation

- Modify: `README.md`
  - Document product mode positioning: brokered MCP claim, CLI operator mode, Web demo exclusion.

---

### Task 1: Establish MCP broker boundary and explicit override semantics

**Files:**
- Modify: `src/transports/mcp.ts`
- Modify: `src/transports/mcp-payload.ts`
- Modify: `tests/mcp.test.ts`
- Modify: `tests/mcp-payload.test.ts`

- [ ] **Step 1: Write the failing tests for broker stop/override behavior**

Add tests that assert:

```ts
expect(confirmWithoutOverride.isError).toBe(true)
expect(confirmWithoutOverride.content[0].text).toContain("CONFIRM")

expect(confirmWithOverride.isError).toBe(false)
expect(parsedWithOverride.decision).toBe("CONFIRM")
```

Define one explicit broker-layer override contract in `src/transports/mcp.ts` and use the same contract in tests and implementation.

Apply it consistently to MCP content-bearing tools:

- `scan_text`
- `scan_file`

Behavior:

- no explicit override + `CONFIRM` => stop with `isError: true`
- valid explicit override + `CONFIRM` => return normal payload with `isError` omitted/false

- [ ] **Step 2: Run the MCP-focused tests to verify current failure**

Run: `npm test -- --run tests/mcp.test.ts`

Expected: FAIL because override semantics are missing or incomplete.

- [ ] **Step 3: Implement the minimal broker contract in MCP**

Keep `src/transports/mcp.ts` aligned to this behavior:

```ts
if (decision.decision === "CONFIRM" && !hasExplicitOverride(args)) {
  return {
    isError: true,
    content: [
      { type: "text", text: confirmCard },
      { type: "text", text: JSON.stringify(payload, null, 2) },
    ],
  }
}

return {
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
}
```

And keep `src/transports/mcp-payload.ts` as MCP-specific assembly over the shared decision output.

- [ ] **Step 4: Run MCP tests to verify pass**

Run: `npm test -- --run tests/mcp.test.ts tests/mcp-payload.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/transports/mcp.ts src/transports/mcp-payload.ts tests/mcp.test.ts tests/mcp-payload.test.ts
git commit -m "feat: enforce broker override contract in mcp"
```

### Task 2: Resolve decision-model contract and merge-conflict state

**Files:**
- Modify: `src/decision/model.ts`
- Test: `tests/decision.test.ts`

- [ ] **Step 1: Write the failing test for the final decision contract**

Add/adjust tests so they assert this exact contract:

```ts
expect(toDecisionResult(safeScan, "hello", config)).toMatchObject({
  decision: "ALLOW",
  riskLevel: "LOW",
  findings: [],
})

expect(toDecisionResult(warnScan, "internal.example.com", config)).toMatchObject({
  decision: "WARN",
  riskLevel: "MEDIUM",
})

expect(toDecisionResult(confirmScan, "sk-proj-123", config)).toMatchObject({
  decision: "CONFIRM",
  recommendedAction: "BLOCK",
})
```

- [ ] **Step 2: Run the decision tests to verify current failure**

Run: `npm test -- --run tests/decision.test.ts`

Expected: FAIL due to contract mismatch.

- [ ] **Step 3: Implement the minimal unified decision contract**

Make `src/decision/model.ts` converge on one shape only:

```ts
export type GuardDecision = "ALLOW" | "WARN" | "CONFIRM"
export type GuardRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
export type GuardRecommendedAction = "REVIEW" | "BLOCK"

export interface GuardDecisionResult {
  decision: GuardDecision
  riskLevel: GuardRiskLevel
  summary: string
  findings: readonly GuardDecisionFinding[]
  recommendedAction?: GuardRecommendedAction
  safePreview?: string
  redactedContent?: string
  originalContent: string
}
```

- [ ] **Step 4: Run the decision tests to verify they pass**

Run: `npm test -- --run tests/decision.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/decision/model.ts tests/decision.test.ts
git commit -m "refactor: stabilize guard decision contract"
```

### Task 3: Lock transport-safe shaping and redaction ownership

**Files:**
- Modify: `src/decision/redaction.ts`
- Modify: `tests/redaction.test.ts`
- Modify: `tests/mcp-payload.test.ts`

- [ ] **Step 1: Write failing tests for transport-safe shaping**

Add tests that assert transport-facing outputs never contain internal fields:

```ts
expect(sanitizeScanResultForExport(result).findings[0]).not.toHaveProperty("match_text")
expect(sanitizeScanResultForExport(result).findings[0]).not.toHaveProperty("match_start")
expect(sanitizeScanResultForExport(result).findings[0]).not.toHaveProperty("match_end")
```

- [ ] **Step 2: Run the redaction/payload tests to verify current behavior**

Run: `npm test -- --run tests/redaction.test.ts tests/mcp-payload.test.ts`

Expected: FAIL if transport-safe shaping is inconsistent.

- [ ] **Step 3: Keep sanitization canonical in the decision/redaction layer**

Ensure `src/decision/redaction.ts` is the canonical home for stripping unsafe fields, with helpers shaped like:

```ts
export function sanitizeFindingForExport(f: Finding): TransportSafeFinding {
  const { match_start: _ms, match_end: _me, match_text: _mt, ...safe } = f
  return safe
}
```

- [ ] **Step 4: Run the tests to verify pass**

Run: `npm test -- --run tests/redaction.test.ts tests/mcp-payload.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/decision/redaction.ts tests/redaction.test.ts tests/mcp-payload.test.ts
git commit -m "test: lock transport-safe redaction outputs"
```

### Task 4: Preserve CLI as operator mode with the same policy core

**Files:**
- Modify: `src/transports/cli.ts`
- Modify: `tests/cli.test.ts`

- [ ] **Step 1: Write failing CLI tests for operator-mode behavior**

Add tests that assert:

```ts
expect(buildDecisionJsonOutput(decision, "file.ts")).not.toHaveProperty("originalContent")
expect(formatCliDecision(decision, "file.ts").join("\n")).toContain("ALLOW")
expect(formatCliDecision(confirmDecision, "file.ts").join("\n")).toContain("--redact")
```

- [ ] **Step 2: Run CLI tests to verify failure**

Run: `npm test -- --run tests/cli.test.ts`

Expected: FAIL if signatures or outputs still drift.

- [ ] **Step 3: Implement minimal CLI alignment**

Keep CLI features intact:

```ts
// keep
--text
--file
--dir
--redact
--dry-run

// ensure
CLI remains scan/redact/dry-run capable
CLI JSON never exposes originalContent or match_text
CLI wording does not claim it is the sole mandatory runtime boundary
```

- [ ] **Step 4: Run CLI tests to verify pass**

Run: `npm test -- --run tests/cli.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/transports/cli.ts tests/cli.test.ts
git commit -m "refactor: keep cli as operator mode"
```

### Task 5: Document and verify Web as explicit demo-only scan surface

**Files:**
- Modify: `src/transports/web.ts`
- Create: `tests/web.test.ts`

- [ ] **Step 1: Write the failing Web test for explicit demo metadata/copy**

First expose a pure seam in `src/transports/web.ts`, for example:

```ts
export function getWebDemoHtml(): string
// or
export function buildWebScanResponse(result: ScanResult): TransportSafeScanResult
```

Then create `tests/web.test.ts` with concrete assertions that this pure seam identifies the surface as demo-only/local-only while remaining transport-safe.

Example assertion target:

```ts
expect(webResponseJson).not.toHaveProperty("originalContent")
expect(htmlOrResponseText).toContain("demo")
```

- [ ] **Step 2: Run the targeted test to verify failure**

Run: `npm test -- --run tests/web.test.ts`

Expected: FAIL because explicit demo-only wording/metadata does not exist yet.

- [ ] **Step 3: Make the demo-only role explicit in code comments and output copy**

Update `src/transports/web.ts` comments/text so it is clearly scan-only/demo-oriented and does not read like a formal gate claim.

- [ ] **Step 4: Run the targeted test to verify pass**

Run: `npm test -- --run tests/web.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/transports/web.ts tests/web.test.ts
git commit -m "docs: mark web transport as demo surface"
```

### Task 6: Narrow the formal claim by documentation, not package API removal

**Files:**
- Modify: `README.md`
- Create: `tests/claim-boundary.test.ts`

- [ ] **Step 1: Write the failing docs-and-export-surface test**

Create `tests/claim-boundary.test.ts` with assertions against side-effect-free documentation or metadata inputs only. Do **not** import `src/index.ts`, because it is the live bootstrap entrypoint.

This task is docs-only in this iteration: it verifies that the formal claim is narrowed in README without redesigning the bootstrap/export surface.

Concrete target:

```ts
expect(readmeText).toContain("brokered MCP deployments")
expect(readmeText).toContain("CLI")
expect(readmeText).toContain("Web")
expect(readmeText).toContain("not part of the formal security claim")
```

For this plan, choose **documentation narrowing (Option B)**:

- keep current low-level exports for now
- explicitly exclude direct library/package usage from the mandatory-gate claim
- do not broaden scope into package API redesign in this iteration

- [ ] **Step 2: Run targeted tests to capture current contract**

Run: `npm test -- --run tests/claim-boundary.test.ts`

Expected: FAIL if the intended export contract is not represented.

- [ ] **Step 3: Apply the minimal change that supports the formal claim**

Update documentation accordingly without redesigning the package API.

- [ ] **Step 4: Run targeted tests and docs checks**

Run: `npm test -- --run tests/claim-boundary.test.ts && npm test`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add README.md tests/claim-boundary.test.ts
git commit -m "docs: narrow formal broker security claim"
```

### Task 7: Full verification pass

**Files:**
- Modify: none unless failures require fixes
- Test: `tests/decision.test.ts`
- Test: `tests/redaction.test.ts`
- Test: `tests/mcp-payload.test.ts`
- Test: `tests/mcp.test.ts`
- Test: `tests/cli.test.ts`
- Test: `tests/web.test.ts`
- Test: `tests/claim-boundary.test.ts`

- [ ] **Step 1: Run the focused architecture test set**

Run:

```bash
npm test -- --run tests/decision.test.ts tests/redaction.test.ts tests/mcp-payload.test.ts tests/mcp.test.ts tests/cli.test.ts tests/web.test.ts tests/claim-boundary.test.ts
```

Expected: PASS

- [ ] **Step 2: Run the full test suite**

Run:

```bash
npm test
```

Expected: PASS

- [ ] **Step 3: Build the package**

Run:

```bash
npm run build
```

Expected: successful TypeScript build with no errors.

- [ ] **Step 4: Review README/spec consistency**

Manually verify these statements are all true:

```md
- brokered MCP deployments are the formal ingress gate
- CLI is the supported operator mode
- Web is demo-only and outside the formal security claim
```

- [ ] **Step 5: Commit final verification fixes if needed**

```bash
git add .
git commit -m "test: verify mandatory ingress gate architecture"
```
