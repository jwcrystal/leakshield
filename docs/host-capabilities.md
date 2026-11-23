# Host capability matrix

[← README](../README.md)

LeakShield intercepts model traffic at a different point in each host:

- **OpenCode**: in-process host hooks (`http.request` / `http.response`, `experimental.ws.*`, payload hooks).
- **Claude Code**: a loopback proxy selected through `ANTHROPIC_BASE_URL`.
- **pi**: an in-process wrapper around `globalThis.fetch`.

Different mechanisms are not the problem. The problem is that each adapter described its own coverage in its own words, so reviews argued about whether a given egress was covered. This page declares, per host, which egress paths and surfaces are `protected`, `refused`, `not-present`, `outside`, or `unknown`, using one vocabulary. A new adapter fills in the same table instead of writing a new story.

**Status (2026-11-23):** implemented. `src/types/capabilities.ts` holds the contract and the invariant checks; each adapter declares its rows next to its doctor code (`src/adapters/opencode/capabilities.ts`, `src/adapters/claude-code/capabilities.ts`, `src/adapters/pi/capabilities.ts`), and `leakshield --doctor` prints those rows from the same constant. `unknown` and `outside` rows keep the host at `PARTIAL` in the doctor's verdict. A row can no longer change in the code without changing in the doctor, and a test fails if the two disagree.

## States

| State | Meaning | Requirement |
|---|---|---|
| `protected` | Content on this path passes through LeakShield core masking and restoration | An existing evidence path (script or record); the doctor and the test point at the same declaration |
| `refused` | The adapter actually stops the request, or the whole run, before it leaves | A runtime test; a documentation claim is not enough |
| `not-present` | The host does not produce this traffic | Probe evidence |
| `outside` | The traffic exists but the host offers no interception point (for example, Claude Code on Bedrock never contacts the proxy) | The doctor must warn and the docs must list it as a residual; allowed only when the host truly has no hook |
| `unknown` | Not audited yet | The doctor prints `UNKNOWN`, the host's verdict is capped at `PARTIAL`, and the row's note names the tracking issue |

`unknown` is a migration state for existing adapters, not an answer. A new adapter may not merge with `unknown` in a row it produces traffic on.

## Declaration

```ts
type CapabilityState = "protected" | "refused" | "not-present" | "outside" | "unknown";

interface Capability {
  state: CapabilityState;
  /** Which core handler this path reaches, or where the request is refused */
  mechanism: string;
  /** Required for protected and not-present; expected for refused */
  evidence?: string;
  /** Residual risk or coverage limit; only what is true */
  note?: string;
}

interface HostCapabilities {
  host: string;                 // "opencode" | "claude-code" | "pi"
  verifiedVersion: string;
  interception: "in-process-fetch" | "in-process-host-hook" | "loopback-proxy" | "preload";
  transports: {
    http: Capability;           // model HTTP: the three wire families, or the proxy's route
    websocket: Capability;
    nonFetch: Capability;       // smithy / gRPC / node:http / an SDK's built-in transport
  };
  surfaces: {
    toolArgs: Capability;       // the local tool execution boundary
    replyDisplay: Capability;   // assistant text restoration
    background: Capability;     // compaction / branch summary / title
  };
  credentials: "in-process" | "separated";
  persistence: "opt-in" | "none";
  residuals: string[];          // load order, a disabled extension, an unsupported provider…
}
```

## Invariants

Tests enforce these:

1. A `protected` row has an `evidence` path that exists.
2. A `refused` row has a runtime test, or evidence pointing at an end-to-end run.
3. A transport the host produces cannot stay `unknown` and still be called done.
4. An `outside` row appears in `residuals` and in the doctor warning. It may not be used to paper over something the adapter could refuse.
5. The doctor's host section prints this table row by row, with the same count and the same states as the declaration.
6. `credentials` and `persistence` have no default; both must be set explicitly.

## Current state

This is what `leakshield --doctor` prints, generated from the adapter constants above; a cell with a marker is scoped by the matching note.

| Host | Interception | HTTP | WebSocket | Non-fetch | Tool args | Reply | Background | Credentials |
|---|---|---|---|---|---|---|---|---|
| OpenCode | host hook | protected ¹ | protected ¹ ² | unknown (probe pending) | protected | protected | protected (payload hooks) | in-process |
| Claude Code | proxy | protected (Anthropic) | unknown (no probe) | outside (Bedrock/Vertex bypass the proxy) | unknown (not restored yet) | protected | unknown ³ | separated ⁴ |
| pi | fetch | protected | refused (Codex) | refused | protected | protected | protected (same fetch) | in-process |

¹ OpenCode's HTTP and WebSocket rows hold only in transparent mode with wire protection on (`wireProtection` omitted or `true`, the v2 default). The [hook-first configuration](plugin/wire-protection.md) sets `wireProtection: false`: LeakShield registers no outbound HTTP or WS send hooks, the doctor reports `PARTIAL`, and later-added content can leave unmasked. Transports are not uniform either: Commandcode's `/alpha/generate`, including its Go/403 fallback, is untouched with wire protection off and refused with it on.

² OpenCode's WebSocket coverage is Responses-family only and experimental; see [Native WebSocket](plugin/websocket.md).

³ Claude Code compacts and summarizes on `/v1/messages`, the same route the proxy masks, so the masker sees those bodies. No separate background probe has been run ([#111](https://github.com/jwcrystal/leakshield/issues/111)), so the row stays `unknown` rather than claiming a coverage the evidence does not carry.

⁴ `separated` means the proxy holds no credential of its own: it forwards the host's headers, including the credential, unchanged and stores nothing. It does not mean LeakShield cannot see the credential, and the proxy runs as a separate process from the host.

### Unknown rows

Each one caps its host at `PARTIAL` and names the issue that would close it:

- OpenCode `transports.nonFetch`: Bedrock, Vertex and SDK-internal transports are unaudited ([#110](https://github.com/jwcrystal/leakshield/issues/110)).
- Claude Code `transports.websocket`: no WS traffic has been observed, but no transport-level probe has looked for it ([#113](https://github.com/jwcrystal/leakshield/issues/113)).
- Claude Code `surfaces.toolArgs`: placeholders are not restored at tool execution ([#91](https://github.com/jwcrystal/leakshield/issues/91)).
- Claude Code `surfaces.background`: compaction and summaries have no separate probe ([#111](https://github.com/jwcrystal/leakshield/issues/111)).

What the table makes visible is the real disagreement: it is not that the adapters work differently, but that **OpenCode's non-fetch egress and Claude Code's tool arguments are currently undeclared**. Those are the rows that will keep recurring when the next adapter is added.

## Adding a host

1. **Probe**: follow the format of the pi fetch gap audit; list every model egress the host has (HTTP, WebSocket, non-fetch, background requests).
2. **Classify**: for each egress choose one of: reach core, refuse, prove it does not exist, or `outside`.
3. **Declare**: fill in `src/<host>/capabilities.ts`. A `protected` row without evidence does not merge, and an `unknown` row carries the issue that closes it.
4. **Doctor**: print the same table, with `outside` and `unknown` visible.
5. **Docs**: limitation sections reference `residuals` rather than repeating a second list.

## Open questions

- **Standard for `outside`**: who decides that the host truly has no hook? The proposal is to require a recorded end-to-end probe from the adapter, not a reviewer's judgement.
- **Tracking `unknown`**: one issue per unknown row, or bound to the adapter's next PR?
- **Older limitation sections**: should existing pages (such as `docs/pi.md`) reference `residuals` instead of keeping their own list, or keep both and reconcile on a schedule?
