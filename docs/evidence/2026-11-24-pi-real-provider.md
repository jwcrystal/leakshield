# pi 1.6.0: a real provider through the in-process extension

Date: 2026-11-24. macOS (arm64), Node 24.22.3, pi 1.6.0, LeakShield
`release/0.4.0` (`da9d6d9`, which contains #121 and #125).

Every earlier pi record in this directory used a loopback stub. This run leaves
the machine: the provider is Command Code's OpenAI-compatible endpoint
(`openai-completions`), the model is `deepseek/deepseek-v4.1-flash`, and the
credential is the one the local CLI already stored.

## Method

- Throwaway agent directory (`PI_CODING_AGENT_DIR`) whose `settings.json` lists
  `dist/adapters/pi/extension.js` in `extensions`, plus a `models.json` provider
  entry for the endpoint. `HOME` points at the same temporary tree, so the run
  reads none of the user's pi sessions or settings. The credential is the one
  the local Command Code CLI already stored; it is handed to this isolated run
  and never printed. pi still writes its own transcript under
  `<agent>/sessions/`, so the transcript, original canary included, stays in
  the temporary tree; the trees from this run were deleted afterwards.
- `LEAKSHIELD_CONFIG` holds one `nda_keywords` entry, the synthetic canary
  `PIREALCANARY9f3b` (16 characters). Mapping persistence is off.
- `pi --print --provider cc --model deepseek/deepseek-v4.1-flash`, pi 1.6.0 in
  print mode. Only the canary was sent; no user content was read or forwarded.

## Results

| Check | Result |
|---|---|
| The prompt asks for the identifier's length and its first four characters; the model answers `31\|SGP2` | PASS — the canary is 16 characters and starts `PIRE`, so the request carried a placeholder |
| A prompt asks the model to `read` a file holding the canary; the model's reasoning names `SGP2:NDA_KEYWORD-nhqo-ygjn-cxzq` | PASS — the tool result was masked before the request |
| A prompt asks the model to repeat the identifier; stdout is the canary | PASS — the placeholder in the reply was restored for display |
| The model then calls `bash` to count characters; the call does not run and the result reads `LeakShield blocked this tool call` | PASS — shell restoration refuses an argument that holds a placeholder |
| `leakshield --doctor pi` with pi on `PATH` | PASS — `Coverage: PROTECTED`, exit 0 |
| `leakshield --doctor pi` with pi absent from `PATH` | `NOT INSTALLED`, exit 1, although `settings.extensions` registered the extension — the binary check takes part in the verdict |

No request body was recorded on this run, so masking is inferred from what the
model could know rather than from an intercepted request: a model cannot report
the token namespace and token length unless it was sent a token.

## Not covered

- One provider and one model. Anthropic Messages and Responses still have
  stub-only evidence.
- No `--continue` or persistence in this run; the resumed-session checks are in
  [2026-11-23-pi-extension.md](2026-11-23-pi-extension.md).
- No compaction, branch summary, image, Windows or interactive TUI run.
