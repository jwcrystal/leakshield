# pi adapter

LeakShield 用一個行程內 extension 保護 [pi coding agent](https://github.com/earendil-works/pi)。extension 在任何 provider client 建立之前包住 `globalThis.fetch`，三種支援的 wire API 上每個模型請求都會經過共用 core 遮罩，placeholder 只在安全的地方還原：助理顯示文字與本機工具參數。

已用 pi **1.6.0** 實機驗證。doctor 接受 `>= 1.6.0 < 2.0.0`，但只有 1.6.0 有實機證據。

## 運作方式

pi 每次請求才建立 provider client，並在當下解析 `fetch`（`options.fetch ?? globalThis.fetch`），compaction 與 branch summary 也一樣。因此包住全域 fetch，就涵蓋了 [OpenCode plugin](README.md#opencode-plugin-recommended) 用 wire hook 涵蓋的同一批流量，不需要 proxy，也不需要啟動器。

| 層 | 責任 |
|---|---|
| `src/pi/guard.ts` | 包住 `globalThis.fetch`：遮罩 provider 請求、在回覆中還原助理文字、讓無關的 fetch 流量直接通過、拒絕未知路由與看不到的傳輸 |
| `src/pi/extension.ts` | 綁定 pi session 與模型；模型無法保護時擋下輸入與工具；在 `tool_call` 還原工具參數 |
| `src/pi/tool-policy.ts` | pi 的 `HostToolPolicy`：read/write/edit/bash/powershell 欄位；未知與 MCP 工具一律拒絕 |

pi 自己的 provider 流量不管 LeakShield 排在第幾個都會被守到：SDK 是每次請求才解析 `fetch`。順序影響的是其他 extension：比它早載入、且握有原始 fetch（或用它建立的 client）的 extension，送出的請求不會被遮罩。因此排第一是建議，不是 pi 本身的前提；不是第一個時 doctor 會回報。

## 安裝

把 extension 加進 pi `settings.json`（`~/.pi/agent/settings.json`）。建議排在第一個，讓更早載入的 extension 拿不到原始 fetch：

```json
{
  "extensions": ["/absolute/path/to/node_modules/leakshield/dist/pi/extension.js"]
}
```

或用旗標啟動，`-e` 一定比 `settings.extensions` 先載入：

```bash
pi -e /absolute/path/to/node_modules/leakshield/dist/pi/extension.js
```

這是唯一在結構上保證排第一的安裝方式，但 `--doctor pi` 看不到 CLI 旗標：只用 `-e` 時會回報 NOT VERIFIED。要讓檢查有意義，就把路徑註冊進 settings。

從 checkout 使用：

```bash
npm ci
npm run build
pi -e "$PWD/dist/pi/extension.js"
```

然後檢查設定：

```bash
leakshield --doctor pi
```

`LEAKSHIELD_CONFIG` 指定 guard 設定檔，跟 Claude Code proxy 的 `--config` 一樣。沒設定時照一般搜尋順序（工作目錄的 `config/guard.config.yaml`，再找 `~/.leakshield/guard.config.yaml`）。

extension 需要 Node.js 20 以上與已建置的 LeakShield 套件。Bun 打包的單檔執行檔不提供這個檔案；請用 npm 套件或 checkout。

## Provider 支援

guard 只會處理三種 pi wire API：

| pi `api` | 端點 | 驗證 |
|---|---|---|
| `openai-completions` | `POST …/chat/completions` | 單元測試 + 真實 pi 行程（stub） |
| `anthropic-messages` | `POST …/messages` | 單元測試 + 真實 pi 行程（stub） |
| `openai-responses` | `POST …/responses` | 單元測試 + 真實 pi 行程（stub） |

只要 API 是這三種之一，pi `models.json` 自訂的 provider 或 pi 內建的 provider 都能用。自訂 provider 範例：

```json
{
  "providers": {
    "commandcode": {
      "baseUrl": "https://api.commandcode.ai/provider/v1",
      "api": "openai-completions",
      "apiKey": "$COMMANDCODE_API_KEY",
      "models": [{ "id": "deepseek/deepseek-v4.1-flash", "contextWindow": 1000000, "maxTokens": 8192 }]
    }
  }
}
```

其他 API（`openai-codex-responses`、`bedrock-converse-stream`、`google-generative-ai`、Azure responses……）的 provider 流量不經過 fetch。extension 看不到，因此選到這類模型時會拒絕執行。只支援 OAuth 的帳號不在範圍內。

### 憑證

pi 保留自己的憑證與設定。extension 跑在 pi 行程內，所以不像 Claude Code proxy 能把上游憑證與 agent 行程分開：能讀環境變數或 `models.json` 的工具也讀得到。這點與同樣在行程內執行的 OpenCode plugin 一致；LeakShield 的範圍是模型邊界，不是對 host 隱藏密鑰。

## 保護範圍

- 所選模型 origin 上的每個 provider 請求：system prompt、對話歷史、工具結果與摘要請求。自動 compaction 已用真實 pi 1.6.0 跑過；branch summarization 走同一個 `completeSummarization`，由同一條傳輸涵蓋。
- 送往 provider origin、但 guard 無法分類的 `POST` 會被拒絕。遮罩失敗、沒有 session、API 不支援、core 建不起來時也一樣。唯讀的 `GET`/`HEAD`（模型目錄、查詢回覆）直接通過：它們不帶對話內容，拒絕會弄壞 OpenRouter、Copilot 這類 provider 的目錄功能。
- 回覆中的助理文字會還原供顯示。pi 收到什麼就存什麼，下一個請求會再遮罩一次。
- 工具參數在執行時還原：
  - `read`（`path`、`offset`、`limit`）、`grep`、`find`、`ls`：會還原；對不到的 placeholder 可以維持字面，因為它只會比對不到。
  - `write`（`path`、`content`）、`edit`（`path`、`edits[].oldText/newText`）：會還原；還原不完整就拒絕該次呼叫。
  - `bash` 與 `powershell`：只在原值對 shell 安全的完整參數詞中還原；命令位置、選項注入、引號與 shell 特殊字元都會拒絕。
  - shell 還原範圍與 OpenCode plugin 相同：placeholder 可以是完整未加引號的參數、整詞加引號的參數、`curl`/`http` 內嵌的值，或單一結尾 `>`/`>>` 配固定檔名之前。管線、命令串接、展開、`<`/`2>` 重導向與被 token 化的重導向目標都會拒絕。沒有 placeholder 的命令不受影響。
  - 未知、MCP 與自訂工具：帶著 placeholder 就拒絕。它們的參數可能被轉送到這個 session mapping 之外的遠端服務。

## Session

session 檔留在 pi 原本的位置，`--continue`、`--resume`、`--session` 與 `/tree` 照常可用。mapping 只在行程存活期間有效：resume 後的舊 placeholder 維持字面，需要它的 `write`/`edit`/shell 呼叫會被拒絕，唯讀工具退化成比對不到。持久化 mapping 由 #105 追蹤。

## Doctor

`leakshield --doctor` 的 `pi:` 區段會回報：

- pi 執行檔與支援的版本
- extension 檔案存在
- guard 設定可載入
- pi `settings.json` / `models.json` 可讀
- LeakShield 是否註冊在 `settings.extensions`，以及是否排第一
- 所選 provider/model 是否使用三種 fetch API 之一

`leakshield --doctor pi` 只檢查這個區段。LeakShield 是 `settings.extensions` 第一項且沒有失敗檢查時 exit 0、回報 `PROTECTED`；排後面時 exit 0、回報 `PARTIAL`（pi 自己的請求仍受保護，先載入的 extension 可以繞過）。只用 `-e` 時 doctor 看不到，回報 `NOT VERIFIED`、exit 1。`--doctor claude-code` 與 `--doctor opencode` 對其他 host 做同樣的事。

## 限制

- 沒載入 extension 的 `pi` 不受保護。沒載入 guard 的行程無法 fail closed。
- `pi --no-extensions`、`-ne` 或專案覆寫設定都會停用它。doctor 回報的是設定狀態，不是執行中的行程。
- pi 自己的請求不管載入順序都會被守到。比 LeakShield 先載入的 extension 可能握有原始 fetch（或用它建立的 client），送出的請求不會被遮罩；比它晚載入的會看到 guard。把 LeakShield 排第一就排除前一種情況。
- 三種 wire API 以外的 provider 一律拒絕，不嘗試保護。
- 換模型會在 `model_select` 套用，並在每次 `before_agent_start` 重新讀取；即使某條路徑跳過事件，下一個請求仍會套用新模型。
- 圖片與附件在此 adapter 採 LeakShield 的 `block` 政策，會被替換而不是轉送。
- 這是模型邊界控制，不是 OS 出口防火牆。任何本機行程（包含使用者 shell）仍可直接送出資料；OpenCode plugin 的範圍相同，OS 層出口屬於部署問題，不是 host adapter 的缺口。
- 互動式 TUI 顯示不在這次實機驗證範圍；print mode 與 wire 腳本已涵蓋傳輸。

## 驗證

- `node scripts/e2e/run-pi-wire.mjs <pi> openai-completions|anthropic-messages|openai-responses`：真實 pi + 錄製 stub，每種格式一個請求，stub 只看到 placeholder，顯示有還原。
- `node scripts/e2e/run-pi-extension.mjs <pi>`：真實 pi，腳本化 read → write → edit → bash → `--continue`，原值只到得了本機工具。
- 紀錄與傳輸稽核：[2026-11-23-pi-extension.md](evidence/2026-11-23-pi-extension.md) 與 [2026-11-23-pi-fetch-gap-audit.md](evidence/2026-11-23-pi-fetch-gap-audit.md)。
