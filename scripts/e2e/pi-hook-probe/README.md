# pi hook-only feasibility probe

Research for [#118](https://github.com/jwcrystal/leakshield/issues/118), not a
production adapter or a new protection mode. This harness runs real pi **1.6.0**
against synthetic loopback providers. It compares content-hook prototypes with
the existing built pi fetch guard.

Some positive controls and failure probes intentionally deliver the synthetic
canary to the loopback recorder. A successful run means the observations match
the assertions; it does **not** mean every prototype protects every path.

## Run

Use Node 24 from the repository root. The runtime is installed separately; the
probe rejects other pi versions and does not install or update packages itself.

```sh
npm ci
npm run build
piRuntimeDir="$(mktemp -d)"
piEvidenceDir="$(mktemp -d)"
npm install --prefix "$piRuntimeDir" --cache "$piRuntimeDir/npm-cache" \
  --ignore-scripts --save-exact @earendil-works/pi-coding-agent@1.6.0
node scripts/e2e/pi-hook-probe/probe.mjs \
  --runtime "$piRuntimeDir" --out "$piEvidenceDir"
node scripts/e2e/pi-hook-probe/analyze.mjs \
  --runtime "$piRuntimeDir" --out "$piEvidenceDir"
```

The full run creates `results.json`, `summary.json`, per-case observations and
three `cli-<api>.log` files in the output directory. No real provider account or
credential is needed. All model URLs point to a recorder on `127.0.0.1`;
`PI_OFFLINE` and isolated agent directories disable normal resource discovery.
The fixture key and private-value canary are synthetic.

The probe also invokes the existing `run-pi-wire.mjs` with the installed real pi
CLI for each supported API, checking request masking and restored display text.
The SDK cases use real `AgentSession` methods, including `navigateTree()` for
branch summarization; interactive TUI navigation is not exercised.

For one unguarded positive control, add `--smoke` to `probe.mjs`. This does not run
the full matrix or CLI checks, so it cannot be passed to `analyze.mjs`.

## What is measured

- Three APIs: `openai-completions`, `anthropic-messages`, `openai-responses`.
- Ordinary system/user prompts, replayed history, and an actual `read` tool
  returning the original canary before outbound masking.
- Manual compaction, threshold-triggered automatic compaction, and branch
  summarization through the SDK (background workflows use Chat Completions).
- Hook exceptions/rejections, explicit `ctx.abort()`, and specialized background
  cancellation; these are distinct cases.
- Late extension payload changes, real Core size refusal, and an injected Core
  exception caught by the existing fetch wrapper.

Hook prototypes replace one synthetic canary; they do not implement production
mapping, assistant restoration, or tool-argument restoration. The formal CLI
checks exercise the existing adapter instead. The SDK matrix disables retries
and does not prove cancellation races, other versions, real-provider
compatibility rates, OAuth, non-fetch transports, or Windows support.

See the dated [evidence and decision gate](../../../docs/evidence/2026-11-23-pi-hook-only-feasibility.md).
