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

Host end-to-end checks need a local OpenCode binary (`opencode` on `PATH` or `OPENCODE_BIN`): see `scripts/e2e/` and [`scripts/e2e/compare/README.md`](scripts/e2e/compare/README.md). They use a loopback provider and synthetic values; no credentials are needed.

## Guidelines

- **Fix bugs test-first**: add a test that fails without the change.
- **Synthetic values only.** Never put a real secret, token, email or personal data in tests, fixtures, evidence or issues.
- **Fail closed.** If masking or restoration cannot be done safely, refuse the request or tool call; do not forward the original.
- **Behaviour changes** (rule defaults, refusal policy) need a line in [CHANGELOG.md](CHANGELOG.md).
- **Evidence files** under `docs/evidence/` are dated records. Do not rewrite their conclusions; add a newer file and a one-line pointer instead (see [docs/evidence/README.md](docs/evidence/README.md)).
- Commit messages follow Conventional Commits (`fix(scanner): …`, `feat(transparent): …`).
