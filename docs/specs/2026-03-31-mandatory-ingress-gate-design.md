# Design: Evolve sensitive-guard into a Mandatory AI Content Ingress Gate

Date: 2026-03-31
Status: Draft approved in conversation
Scope: Architecture only. No implementation. No full DLP expansion.

## Goal

Upgrade `sensitive-guard` from an optional scanner into a system where AI-bound content ingress is enforced through a mandatory boundary in **brokered MCP deployments**, while preserving CLI as a supported operator workflow.

## Non-Goals

- Do not design full DLP coverage.
- Do not redesign detection rules in depth.
- Do not make the demo web surface part of the security boundary.
- Do not implement runtime integration with external model providers in this document.

### DLP note

In this document, **DLP (Data Loss Prevention)** means a broader data-protection program beyond the current ingress-gate scope, for example:

- richer classification and policy tiers,
- exception and allowlist management,
- audit trails and alerting,
- multi-channel enforcement across agent, API, proxy, storage, and logs,
- more advanced routing, quarantine, or review workflows.

This design intentionally does **not** expand into that full space yet. It focuses first on establishing a mandatory ingress boundary for brokered MCP deployments.

## Scope Assumption

This design only supports the formal claim of a mandatory ingress gate in deployments where **AI-bound traffic is routed exclusively through a documented MCP broker workflow**.

If callers can bypass the broker by using direct low-level imports, package re-exports, alternate transports, or direct model-provider paths, then the product may still provide strong scanning and redaction capabilities, but it cannot honestly claim a mandatory ingress boundary.

## Current State Summary

### Runtime entrypoints

- `src/index.ts`
  - Bootstraps one of three modes: MCP, CLI, or Web.
- `src/transports/mcp.ts`
  - Registers MCP tools and already applies decision-aware behavior for MCP scan paths.
- `src/transports/cli.ts`
  - Supports scan/redact/dry-run flows for local and scripted use.
- `src/transports/web.ts`
  - Demo surface for local scanning. Not part of the target security boundary.

### Policy and detection core

- `src/scanner/engine.ts`
  - Produces findings and redaction metadata.
- `src/decision/model.ts`
  - Converts scan results into policy decisions.
- `src/decision/redaction.ts`
  - Builds safe previews, redacted content, and transport-safe finding shapes.
- `src/config/loader.ts`
  - Loads and validates policy config.

### Existing convergence

- MCP and CLI already partially converge on a shared decision-aware path.
- Web remains a scan-only demo path and should not be treated as a formal gate.

## Recommended Approach

Use a dual-layer design:

1. **MCP broker as the mandatory ingress boundary**
2. **Shared decision/policy core as the single source of truth**

This gives the product one formal runtime choke point while keeping policy logic reusable across MCP and CLI.

## Alternatives Considered

### 1. Library-first only

Make the decision and scanner layers the only official API and require all transports to call them.

**Pros**
- Cleanest shared logic.
- Best consistency across surfaces.

**Cons**
- Still bypassable by callers that skip the API.
- Does not satisfy the core requirement of a mandatory ingress boundary.

### 2. Broker-first with shared policy core (**recommended**)

Make MCP the mandatory broker and use the shared decision core underneath it.

**Pros**
- Closest fit to the goal of non-optional ingress control.
- Minimal architectural change from current repo structure.
- Preserves CLI as a supported operator interface.

**Cons**
- Requires stricter boundary definition.
- Requires careful handling of bypass-prone exports and raw payload paths.

### 3. Full wrapper platform

Wrap all reads, tool calls, and outbound AI sends behind one new platform pipeline.

**Pros**
- Strongest long-term control surface.

**Cons**
- Too large for the current scope.
- Prematurely expands into a full DLP/runtime platform project.

## Target Architecture

### Formal product modes

#### MCP mode

Purpose: **mandatory ingress gate for brokered deployments**

- Acts as the formal runtime boundary only when upstream AI-bound workflows are explicitly routed through this broker contract.
- Enforces decision semantics consistently:
  - `ALLOW`: continue
  - `WARN`: continue, but surface the warning
  - `CONFIRM`: stop unless an explicit override is present
- Owns the user-visible stop/continue contract for risky content.

#### CLI mode

Purpose: **operator interface**

- Supports direct local usage for:
  - scanning,
  - redaction,
  - dry-run inspection,
  - file and directory workflows.
- Uses the same policy and redaction core as MCP.
- Is supported and first-class, but is not the claim-bearing runtime choke point.

#### Web demo

Purpose: **demo / local inspection surface**

- Remains outside the formal security claim.
- May continue to exist for demonstration or local testing.
- Must not be used as evidence that “all product surfaces are mandatory gates.”

## Responsibility Split

### `src/transports/mcp.ts`

Role: **mandatory broker**

Responsibilities:
- Accept AI-bound ingress requests for documented brokered workflows.
- Force content through the decision pipeline before release.
- Stop on `CONFIRM` unless an explicit override is present.
- Centralize override semantics at the broker layer.

Override is defined here as a **broker-layer request contract**: the broker may only continue past `CONFIRM` when the request explicitly carries an override signal that matches the documented policy contract. Audit persistence and storage format are deferred.

Non-responsibilities:
- Low-level regex scanning.
- Transport-independent policy classification logic.

### `src/transports/mcp-payload.ts`

Role: **MCP-specific payload assembler**

Responsibilities:
- Convert internal decision results into MCP payloads.
- Keep MCP responses aligned with the policy core.

Non-responsibilities:
- Owning the canonical sanitization logic.

Canonical transport-safe shaping remains in the decision/redaction layer: `src/decision/model.ts` and `src/decision/redaction.ts`.

### `src/decision/model.ts`

Role: **policy brain**

Responsibilities:
- Convert findings into a single decision contract.
- Define `ALLOW`, `WARN`, and `CONFIRM` semantics.
- Define `riskLevel` and `recommendedAction`.

Non-responsibilities:
- I/O.
- Transport formatting.
- User interaction.

### `src/scanner/engine.ts`

Role: **detection engine**

Responsibilities:
- Detect sensitive spans.
- Return findings and redaction metadata.

Non-responsibilities:
- Final gate decisions.
- Transport output shape.
- Override semantics.

### `src/decision/redaction.ts`

Role: **redaction and transport-safety adapter**

Responsibilities:
- Build deterministic redacted content.
- Build safe previews.
- Strip internal finding metadata before transport export.

### `src/transports/cli.ts`

Role: **operator mode**

Responsibilities:
- Expose scan, redact, dry-run, and local inspection operations.
- Reuse the shared decision and redaction core.

Non-responsibilities:
- Serving as the product’s sole mandatory runtime ingress boundary.

### `src/index.ts`

Role: **bootstrap only**

Responsibilities:
- Select mode.
- Start the requested transport.
- Perform startup-level fail-closed checks when required.

Non-responsibilities:
- Per-request decisioning.
- Payload shaping.

## Minimal Evolution Diagram

```text
                         [ Policy Config ]
                      src/config/loader.ts
                                |
                                v
                    [ AI-bound caller / agent runtime ]
                                   |
                                   v
                        [ Mandatory MCP Broker ]
                         src/transports/mcp.ts
                                   |
                                   v
                    [ Detection + Match Metadata ]
                        src/scanner/engine.ts
                                    |
                                    v
                         [ Decision / Policy Core ]
                         src/decision/model.ts
                                    |
                                    v
                  [ Redaction + Safe Serialization ]
                     src/decision/redaction.ts
                                    |
                                    v
                        [ MCP Decision Payload ]
                    src/transports/mcp-payload.ts


[ Human / shell / CI / scripts ]
              |
              v
        [ CLI operator mode ]
      src/transports/cli.ts
              |
              +------ uses same Decision / Detection / Redaction core
```

## Security Boundary Statement

The formal security claim should be limited to the MCP broker path.

This means:

- It is valid to say brokered MCP deployments use the formal ingress gate.
- It is valid to say CLI shares the same policy and redaction core.
- It is **not** valid to say every surface is a mandatory gate.
- The Web demo is intentionally excluded from that claim.

## Key Risks in Current State

### 1. Cross-transport policy drift

- MCP and CLI are decision-aware.
- Web is not.
- Any future surface could drift again if policy logic is not kept centralized.

### 2. Sensitive content leakage through internal result shapes

- Internal finding metadata such as `match_text` is useful for redaction but unsafe for transport output.
- Any raw export path that bypasses safe serializers can leak original sensitive fragments.

### 3. Bypass through non-broker paths

- `src/index.ts` currently re-exports low-level scanning and rule APIs for external consumers.
- If direct package imports or non-broker flows remain first-class runtime paths, the product cannot honestly claim mandatory ingress enforcement.

## Required Architectural Outcomes

1. MCP is the only formal claim-bearing ingress boundary.
2. CLI remains a supported mode for human and scripted workflows.
3. Decision semantics are defined exactly once.
4. Redaction and safe preview generation remain reusable services.
5. Transport-facing payloads are always sanitized.
6. Demo surfaces remain outside the formal security claim.
7. Low-level direct exports that enable broker bypass must either be restricted, reorganized, or explicitly excluded from the mandatory-gate claim.

## Verification Criteria for the Future Implementation

- MCP and CLI both consume the same decision contract.
- MCP responses never expose raw internal finding metadata or original content.
- CLI redact mode remains available.
- Web demo is clearly documented as non-claim-bearing.
- Product documentation distinguishes:
  - formal ingress boundary,
  - operator interface,
  - demo surface.

## Open Questions Deferred

- Exact override audit trail design.
- How external model-provider integrations will be routed through the broker.
- Whether startup should fail closed when guard config is missing.

## Recommendation

Proceed with a **broker-first architecture backed by a shared policy core**:

- Brokered MCP deployments become the mandatory ingress gate.
- CLI mode remains a supported operator interface.
- Decision, redaction, and sanitization logic become the single reusable substrate for both.

## Sequencing Recommendation

Yes — a broader DLP effort should come **after** the current ingress-gate plan is completed.

Recommended order:

1. Establish the mandatory broker boundary.
2. Stabilize the shared decision, redaction, and transport-safe output contract.
3. Clarify formal versus non-claim-bearing product surfaces.
4. Only then expand into broader DLP capabilities.

Reasoning:

- Without a stable ingress boundary, DLP work risks being bolted onto multiple bypassable surfaces.
- A shared policy core is a prerequisite for later audit, exception, and enforcement expansion.
- Doing DLP first would increase scope sharply and make the current plan less likely to land cleanly.
