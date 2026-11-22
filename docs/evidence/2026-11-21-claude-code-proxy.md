# Claude Code 本機 proxy：Claude Code 2.1.321 實機驗證（issue #86）

> 2026-11-22：Claude Code 2.1.330 重測結果相同，見 [2026-11-22 重測](2026-11-22-claude-code-proxy-2.1.330.md)。

日期：2026-11-21 · Claude Code 2.1.321 · leakshield 分支 `claude/claude-code-proxy-d19a14`（`main` `ac9864e` 之上的 core thinking opt-in `2702f6e` 與 `feat(claude-code)` commit），以 `npm run build` 產生的 `dist/cli.js --claude-code-proxy` 執行。Opus 審查後修正了 proxy（路徑與 GET/HEAD header 掃描、body 正規化、不跟隨 redirect），修正後重新 build，mask 與 refuse 兩個情境重跑，結果與下表相同

## 方法

- **執行方式：** 真實的 `claude -p`，每次用獨立的 `CLAUDE_CONFIG_DIR`，使用者自己的設定、hooks 與登入都不會載入。`ANTHROPIC_BASE_URL` 指向 proxy，`ANTHROPIC_API_KEY` 是合成值。
- **上游：** 本機替身 [`scripts/e2e/claude-code/stub-upstream.mjs`](../../scripts/e2e/claude-code/stub-upstream.mjs)，記錄收到的每個請求（憑證 header 只記 `<present>`），並依腳本扮演會用工具的模型：第一輪回 thinking（含 signature）＋文字＋`Bash cat notes.txt`，第二輪回 `Bash wc -c notes.txt`，第三輪回一段引用 API key placeholder 的文字，placeholder 在兩個 `text_delta` 之間切開。**沒有使用真實模型，也沒有連到 Anthropic。** 本機 Claude Code 的 OAuth 登入已過期（`OAuth session expired and could not be refreshed`），所以沒有做真實帳號的測試。
- **秘密：** 合成的 `sk-proj-…` 金鑰（scanner 判為 `API_KEY`／HIGH），同時出現在 prompt 與工作目錄的 `notes.txt`，後者經 Bash 工具結果回到對話。
- **腳本：** [`scripts/e2e/claude-code/run.mjs`](../../scripts/e2e/claude-code/run.mjs)，`--scenario mask`（預設）與 `--scenario refuse` 兩種；斷言由腳本機械檢查。有可用的登入後，可以把 proxy 的 `--upstream` 指向 [`recording-forwarder.mjs`](../../scripts/e2e/claude-code/recording-forwarder.mjs)，它記錄實際送出的內容並轉送到真實 API，用來對真實帳號重跑。

## 結果

### mask：遮罩與還原

| 檢查 | 結果 |
|---|---|
| `claude` 結束碼 0 | PASS |
| 上游收到 3 個 `POST /v1/messages?beta=true`（另有 `HEAD /api/hello`） | PASS |
| 上游收到的所有請求（含 header）都**不含**原值 | PASS |
| 每個 Messages 請求都帶 placeholder；3 個請求中 API key 只對應**同一個** placeholder | PASS |
| 第二、三輪的歷史帶有 `thinking` block，`signature` 與替身發出的值逐字相同 | PASS |
| 歷史帶有 `tool_result`，其中來自 `notes.txt` 的原值已被遮罩 | PASS |
| `claude` 輸出還原後的原值：`notes.txt holds the key sk-proj-Q7vR…; I only saw it as a placeholder.` | PASS |
| `claude` 輸出不含 placeholder | PASS |

另外觀察到：Claude Code 自己注入 context 的帳號 email 也被偵測並遮罩（每個請求 2 個 `PII_EMAIL` placeholder），上游沒有收到原值。

### refuse：fail closed

以 `--config` 載入一條自訂規則，命中 Claude Code 自己的識別字（`claude-[a-z]+-[0-9]…`）。實際命中的是 `anthropic-beta: claude-code-20250219` header，屬於不能改寫的傳輸欄位。

| 檢查 | 結果 |
|---|---|
| `claude` 結束碼非 0，輸出 `API Error: 400 LeakShield blocked the request because its body is unsupported or could not be identified. [metadata-header-sensitive]` | PASS |
| 上游**沒有**收到任何 Messages 請求（只有不帶 body 的 `HEAD /api/hello`） | PASS |
| proxy 記錄 6 次拒絕 | PASS（見下） |

6 次不是 SDK 重試：直接讓替身對 Messages 回 400（`--fail-status 400`、不經 proxy），Claude Code 同樣送出 6 個請求，每個的 `x-stainless-retry-count` 都是 0，工具數在 12 與 22 之間變化。這是 Claude Code 對 400 的固定處理，次數有上限，每次都被擋下。

### 先前抓到的問題

在加上 core 的 opt-in 前，把同一組 Claude Code 請求直接餵給 core，第二輪以後的請求都以 `[anthropic-content-block-type]` 拒絕，因為 Claude Code 每輪都會重送帶 signature 的 `thinking` block。因此 core 新增 `anthropicThinking: "mask"`（預設仍為 `refuse`，OpenCode 行為不變），proxy 啟用它。

### 設定來源的優先順序

doctor 依「專案 local 設定 > 專案設定 > 使用者設定 > shell」判斷 `ANTHROPIC_BASE_URL`。用三個替身分別代表 shell、使用者設定（`CLAUDE_CONFIG_DIR/settings.json`）與專案 `.claude/settings.json`，以 `env -i` 的乾淨環境執行 `claude -p`：shell＋使用者 → 使用者；三者都有 → 專案；使用者＋專案 → 專案；只有專案 → 專案。與 doctor 的順序一致（專案 local 沒有測）。

在這個測試所在的 Claude Code session 裡直接執行（繼承上層 session 的 `CLAUDE_*` 環境變數）時，結果相反：shell 的值勝過使用者與專案設定。所以由其他程式啟動的 Claude Code 可能不照設定檔走，文件已註明。

## OpenCode 回歸

同一個 build，`scripts/e2e/run-boundary.mjs --only=C10-transparent,C11-transparent-tool,C13-transparent-restore,C17-reply-restore,C18-anthropic-transparent,C19-responses-transparent`，OpenCode v2.3.2：6 個案例全部 pass，provider 請求的原值外洩數為 0。

## 沒有涵蓋

- 真實 Anthropic API 與真實模型，包括真實 signature 的驗證、真實 SSE 中的其他事件類型（server tools、`context_management` 等）。
- claude.ai 訂閱登入（OAuth）經 proxy 的流程。
- 互動模式、`/resume`、背景 Haiku 呼叫（標題、摘要）、WebFetch、WebSearch；`count_tokens` 只有單元測試，這次的 `-p` 執行沒有送出。
- 工具執行時的還原（不在 #86 範圍內）：腳本中的 Bash 指令不含 placeholder。
