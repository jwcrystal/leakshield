# Contributing

Thanks for helping. Issues and pull requests are welcome; security problems go through [SECURITY.md](SECURITY.md) instead.

## Setup

- Node.js 24 is what CI uses. The core runs on Node 20+, but persistence tests need the built-in `node:sqlite` (Node 22.13+).
- `npm ci`, then `npm run build`.

## Before opening a pull request

```bash
npx tsc --noEmit
npm test
```

CI runs both on every pull request.

Host end-to-end checks live in `scripts/e2e/` and need the host binary installed locally. Run `npm run build` first. They use a loopback or recording stub provider and synthetic values; no credentials are needed.

| Host | Needs | Scripts |
|------|-------|---------|
| OpenCode | `opencode` on `PATH` or `OPENCODE_BIN` | `run-boundary.mjs` and others in `scripts/e2e/`; see [`scripts/e2e/README.md`](scripts/e2e/README.md) and [`scripts/e2e/compare/README.md`](scripts/e2e/compare/README.md) |
| pi | a pi 1.6 binary (pass its path) | `run-pi-*.mjs`; see [Verification in docs/pi.md](docs/pi.md#verification) |
| Claude Code | `claude` on `PATH` | `scripts/e2e/claude-code/run.mjs [--scenario mask\|refuse]`; see the [verification record](docs/evidence/2026-11-21-claude-code-proxy.md) |

A change to shared code (`src/core/`, the scanner or rules) can affect every host; run the checks for each host you have available and say in the pull request which ones you ran.

## Guidelines

- **Fix bugs test-first**: add a test that fails without the change.
- **Synthetic values only.** Never put a real secret, token, email or personal data in tests, fixtures, evidence or issues.
- **Fail closed.** If masking or restoration cannot be done safely, refuse the request or tool call; do not forward the original.
- **Behaviour changes** (rule defaults, refusal policy) need a line in [CHANGELOG.md](CHANGELOG.md).
- **Evidence files** under `docs/evidence/` are dated records. Do not rewrite their conclusions; add a newer file and a one-line pointer instead (see [docs/evidence/README.md](docs/evidence/README.md)).
- Commit messages follow Conventional Commits (`fix(scanner): …`, `feat(transparent): …`).

## Testing placeholder refusals

Some tests need a marker that has no mapping: one that was never minted, one whose mapping was lost on restart, or one minted in a different session. Keep those fixtures explicit.

- **Never write a complete placeholder literal into a test or fixture.** The guard that protects your own editing session will try to restore it and refuse the write. Build the pattern from the exported `PSEUDONYM_TOKEN_PREFIX_V2` constant, and derive an unminted marker from one minted inside the test rather than pasting a new one.
- **Say which component is under test.** A test that writes through the plugin cannot also be the proof that the plugin refuses the same call; keep the authoring path and the asserted path separate in the header comment.
- **Assert the refusal, not just the throw.** The hook rejects instead of returning, and the tool input it was given is unchanged. Then assert that the same guard still restores a mapped value, so the test cannot pass by refusing everything. A hook-level test cannot prove the host skipped the tool; that ordering belongs to the E2E runners under `scripts/e2e/`.
- **Do not encode, split, rename, or move a marker to get past the guard**, and do not add a test-mode bypass or a broad allowlist. The runtime cannot tell a stale mapping from a synthetic one, so no test should expect it to.

`tests/transparent-unresolved-mapping.test.ts` is the worked example.
