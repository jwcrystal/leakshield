# pi adapter

LeakShield 讓 [pi coding agent](https://github.com/earendil-works/pi) 改走本機 loopback provider 邊界：任何送往 provider 的請求先換成 placeholder，本機工具只在執行邊界拿回原值。

已用 pi **1.6.0** 實機驗證；啟動器接受 `>= 1.6.0 < 2.0.0`，但只有 1.6.0 有實機證據。

## 為什麼不能只靠 extension

pi 的 hook 方便，但不能當成出口管制：

- `before_provider_request` 的 handler 拋錯或被 reject 時，pi 會用原始 payload 繼續送出。
- compaction、branch summarization 等背景請求走另一條 provider 路徑，可能繞過 payload hook。
- extension 被停用、以 `--no-extensions` 啟動，或專案套件自行連線時，callback 攔不住。

因此 adapter 同時用兩層：

| 層 | 責任 |
|---|---|
| Loopback provider 邊界（`src/pi/proxy.ts`） | 遮罩每個 provider 請求、持有 session mapping、用上游憑證轉送、拒絕未支援路由／模型與遮罩失敗 |
| pi extension（`src/pi/extension.ts`） | 提供 pi session 身分、在工具邊界還原 placeholder、還原助理顯示文字 |

`leakshield pi` 會產生只含這個邊界的暫存 agent 目錄，停用環境 extension 探索與專案信任，且不把上游憑證交給 pi 子行程。

## 安裝

需要 Node.js 20 以上與已建置的 LeakShield。

```bash
npm install -g leakshield
leakshield --pi-install   # 選用：把 extension 註冊到 ~/.pi/agent/settings.json
```

`--pi-install` 只追加 extension 路徑，保留其他設定。受管啟動器會明確載入 extension，所以只有直接跑 `pi` 時才需要這個註冊（此時 extension 會 fail-closed）。

從 checkout 使用：

```bash
npm ci
npm run build
node dist/cli.js pi --provider commandcode --continue
```

## 透過邊界啟動 pi

```bash
leakshield pi --provider commandcode --continue
leakshield pi --provider commandcode -p "review this diff"
leakshield --pi --provider commandcode   # 等價寫法
```

啟動器選項（其餘參數原樣傳給 pi）：

| 選項 | 說明 |
|---|---|
| `--provider <id>` | **必填。** 要保護的 pi provider；必須宣告在 pi `models.json`，且設定 `apiKey` |
| `--model <pattern>` | 傳給 pi，支援 `provider/id` 與 `:thinking` |
| `--upstream <url>` | 覆寫 provider API base（https，或 loopback http） |
| `--api <api>` | `openai-completions`、`openai-responses`、`anthropic-messages` |
| `--config <path>` | 指定 `guard.config.yaml` |
| `--control-port <port>` | 邊界埠號，預設隨機 loopback 埠 |

啟動器輸出不包含任何憑證。

## Provider 支援

| pi `api` | 端點 | 驗證 |
|---|---|---|
| `openai-completions` | `POST …/chat/completions` | 單元測試 + 真實 pi 行程 + 真實 CommandCode provider |
| `anthropic-messages` | `POST …/messages` | 單元測試 + 真實 pi 行程（stub） |
| `openai-responses` | `POST …/responses` | 單元測試 + 真實 pi 行程（stub） |

pi `models.json` 中宣告的 provider 會照其 base URL、API 與模型清單使用。provider 必須在那裡宣告並設定 `apiKey`；`--upstream` 與 `--api` 只覆寫它的 base URL 與 API。內建 provider 選擇（pi 目錄中繼資料與環境變數憑證）已從 adapter 移除，追蹤於 #106。

範例：Command Code 以自訂 provider 宣告（已用 `deepseek/deepseek-v4.1-flash` 驗證）：

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

啟動器只會把安全的模型中繼資料複製到產生的設定；該 entry 的 `baseUrl`、`apiKey`、`headers` 不會進到 pi 子行程。

### 憑證

上游憑證只來自所選 provider 在 pi `models.json` 的 `apiKey`：literal，或 `$ENV_NAME` 指向的環境變數。`!command` 一律拒絕、不會執行。不會隱性讀取環境變數，也不會採用 `pi auth login` 存下的 API key；`apiKey` 缺少或其 `$ENV` 未設定時，啟動器直接拒絕啟動。

受管路徑不支援只有 OAuth 的帳號。已用 CommandCode 的 `deepseek/deepseek-v4.1-flash`（自訂 `models.json` entry）完成一次真實 provider 請求；Anthropic、OpenAI、OpenRouter 也要像其他 provider 一樣宣告在 `models.json` 才能用；adapter 以三種 wire format 的單元測試覆蓋，不逐家跑真實服務。憑證值不會傳給 pi 子行程，子行程的 provider API key 只是短期的 loopback token。

## 保護範圍

- 設定路由上的每個 provider 請求：system prompt、對話歷史、工具結果，以及 compaction／branch summary 發出的摘要請求。自動 compaction 與 branch summarization 尚未在正式啟動器上實跑；請求形狀由單元測試覆蓋。
- 串流回覆原樣通過，模型端歷史保持 placeholder；助理顯示文字由 `pi.registerMarkdownTransformer` 在本機還原，儲存訊息不改寫。
- 工具執行邊界的參數：
  - `read`（`path`、`offset`、`limit`）、`grep`、`find`、`ls`：還原；未解析的 placeholder 可保持字面，因為只會 match 不到。
  - `write`（`path`、`content`）、`edit`（`path`、`edits[].oldText/newText`）：還原；不完整就拒絕該次呼叫。
  - `bash`、`powershell`：只有在完整參數詞、且原值在該引號情境安全時才還原；命令位置、選項注入、引號與 shell 特殊字元一律拒絕。
  - shell 還原沿用 OpenCode plugin 的同一份 literal-argument 子集：placeholder 可以是完整未加引號或整詞引號的參數、`curl`／`http` 的內嵌值，或位於結尾單一 `>`／`>>`（目標為靜態檔名）之前。pipeline、命令串接、展開、`<`／`2>` 重導向、token 化的 redirect 目標都會拒絕該次呼叫；不含 token 的命令不受影響。
  - 未知、MCP、自訂工具：含 placeholder 就拒絕，因為參數可能被轉送到這個 session mapping 之外的遠端服務。
- 未支援路由／模型、格式錯誤的 body、缺少 session 身分、錯誤的 loopback token、遮罩失敗、上游 redirect，都在送出前拒絕。

## Session

Session 檔留在使用者原本的目錄，`--continue`、`--resume`、`--session` 與 `/tree` 行為不變。邊界依 extension 提供的 pi session id 區分 mapping。

mapping 只在行程內。續用舊 session 時舊 placeholder 保持字面；需要它的 `write`、`edit` 與 shell（`bash`、`powershell`）呼叫會被拒絕，唯讀工具退化為 match 不到。跨重啟的持久化追蹤於 #105。

## 未受管的 pi 會 fail-closed

若 extension 已裝在 pi 設定中，但沒有透過啟動器執行，extension 會拒絕輸入與所有工具呼叫，並提示改用 `leakshield pi`。它無法單獨阻擋 provider 請求，也不會假裝有保護。

## Doctor

`leakshield --doctor` 會多一段 `pi:`：

- pi 執行檔與版本是否支援
- extension 檔案是否存在
- pi `settings.json`／`models.json` 是否可讀
- 透過 `PI_PROVIDER` 選定的 provider（未設定時跳過），以及其 `models.json` `apiKey` 是否存在（不讀值）
- 直接跑 `pi` 會連到真實 provider 端點時的警告
- 目前 shell 是否在受管啟動中，並探測邊界健康狀態

`leakshield --doctor pi` 只檢查這一段，且只有在此 shell 是受管啟動、沒有失敗檢查時才 exit 0。`--doctor claude-code` 與 `--doctor opencode` 同理，CI 可以只檢查單一整合，不受其他 host 狀態影響。請用 `--doctor pi`，不要用 `leakshield pi --doctor`，那會把 flag 傳給 pi。

## 限制

- 不經啟動器的 `pi` 沒有保護；extension 只能在本機拒絕。
- 啟動器固定加 `--no-extensions`，因此 pi 內建 extension（MCP、codemode、tool search）與專案套件不會載入。啟動器也拒絕額外的 `-e`／`--extension`，因為 extension 可以自行連線、繞過邊界。
- 受管執行固定加 `--no-approve`，專案 `.pi` 資源不載入。
- 三種 wire protocol 之外的 provider（`google-generative-ai`、Bedrock、Vertex、Codex responses）一律拒絕。
- 圖片與附件沿用 LeakShield 的 `block` 政策，會被替換而非轉送。
- 這是模型邊界控制，不是作業系統層的出口防火牆；任何本機行程仍可直接連網。OpenCode plugin 的範圍相同，OS-level egress 屬部署層問題，不是 host adapter 的缺口。
- 獨立發行檔（Bun 編譯的 `leakshield`）無法從二進位檔提供 pi extension 檔案；pi adapter 請用 npm 套件或 checkout，`--doctor` 會回報缺少 extension。
- 這次沒有驗證互動式 TUI 畫面；transformer 由單元測試與 print mode 覆蓋。
