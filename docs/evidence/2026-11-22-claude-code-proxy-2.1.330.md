# Claude Code 本機 proxy：Claude Code 2.1.330 重測

日期：2026-11-22 · Claude Code 2.1.330 · leakshield `main` `047e5aa`（含 #94、#95、#97），以 `npm run build` 產生的 `dist/cli.js --claude-code-proxy` 執行。

## 方法

與 [2026-11-21 的驗證](2026-11-21-claude-code-proxy.md)相同：[`scripts/e2e/claude-code/run.mjs`](../../scripts/e2e/claude-code/run.mjs)，真實的 `claude -p`，獨立的 `CLAUDE_CONFIG_DIR`，合成的 API key 與 canary，上游是本機替身 [`stub-upstream.mjs`](../../scripts/e2e/claude-code/stub-upstream.mjs)。**沒有使用真實模型，也沒有連到 Anthropic。**

和上次不同的一點：腳本會把自己的環境變數整份傳給 `claude`，這次以 `env -i PATH=… HOME=…` 執行，確保執行環境裡其他的 Claude Code 變數不會混進測試。

## 結果

### mask：8/8 PASS

| 檢查 | 結果 |
|---|---|
| `claude` 結束碼 0 | PASS |
| 上游收到 3 個 `POST /v1/messages?beta=true`（另有 `GET /`、`HEAD /api/hello`） | PASS |
| 上游收到的所有請求都**不含**原值 | PASS |
| 每個 Messages 請求都帶 placeholder | PASS |
| 歷史帶有 `thinking` block | PASS |
| 歷史帶有 `tool_result` | PASS |
| `claude` 輸出還原後的原值：`notes.txt holds the key sk-proj-Q7vR…; I only saw it as a placeholder.` | PASS |
| `claude` 輸出不含 placeholder | PASS |

### refuse：4/4 PASS

| 檢查 | 結果 |
|---|---|
| `claude` 結束碼非 0 | PASS |
| 上游**沒有**收到任何 Messages 請求（只有 `GET /`、`HEAD /api/hello`） | PASS |
| `claude` 顯示 LeakShield 的拒絕訊息 | PASS |
| proxy 記錄 6 次拒絕，在 Claude Code 自己對 400 的處理次數內（1–6） | PASS |

## 結論

2.1.321 的結論在 2.1.330 仍然成立。真實 Anthropic API 與 claude.ai 訂閱登入仍未驗證。
