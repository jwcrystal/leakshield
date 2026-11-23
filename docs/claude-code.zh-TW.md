# Claude Code（本機 proxy）

LeakShield 透過本機 proxy 保護 Claude Code。Claude Code 把模型請求送到 `ANTHROPIC_BASE_URL`；把它指向 proxy 之後，每個 Anthropic Messages 請求在離開本機前都會被遮罩，助理文字中的 placeholder 則在 Claude Code 顯示前還原。Proxy 原樣轉送 Claude Code 自己的憑證與 `anthropic-beta` header。Claude Code 文件說 base URL 也適用於 claude.ai 訂閱登入，但這裡尚未驗證；訂閱 session 也可能在 base URL 上使用其他帶 body 的路由，proxy 會擋下。

狀態：實驗性。已用 Claude Code 2.1.321 搭配本機替身上游與合成金鑰驗證，尚未對真實 Anthropic API 驗證（[紀錄](evidence/2026-11-21-claude-code-proxy.md)）。

## 設定

1. 啟動 proxy 並保持執行：

   ```bash
   leakshield --claude-code-proxy
   ```

   預設監聽 `127.0.0.1:8787`，轉送到 `https://api.anthropic.com`。選項：`--port <n>`、`--upstream <url>`（其他 Anthropic 相容 gateway；純 `http` 只允許 loopback）、`--config <path>`（與 CLI 相同的 LeakShield 設定檔）、`--attachments allow`。

2. 讓 Claude Code 指向它，可以寫在啟動 Claude Code 的 shell：

   ```bash
   export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
   ```

   或寫在 `~/.claude/settings.json`（或專案的 `.claude/settings.json`）的 `env`：

   ```json
   { "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787" } }
   ```

3. 檢查：

   ```bash
   leakshield --doctor
   ```

   `Claude Code:` 區段會說明 `ANTHROPIC_BASE_URL` 來自哪裡（設定檔優先於 shell；專案 local 優先於專案，再優先於使用者，依 Claude Code 2.1.321 實測），以及該位址是否有 LeakShield proxy 回應。啟用 Bedrock、Vertex 或 Foundry，或設定了 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` 時會警告，因為這時 Claude Code 不會使用設定檔裡的 base URL。OpenCode 的各種結果維持原本的結束碼。沒有 OpenCode 的機器上，只有 Claude Code 指向執行中的 LeakShield proxy、且沒有 provider 或宿主設定繞過它時，結束碼才是 0；base URL 指向沒在執行的 proxy 時結束碼為 1。`leakshield --doctor claude-code` 只跑這一段，且只有 proxy 健康時才 exit 0。

`ANTHROPIC_BASE_URL` 指向 proxy 但 proxy 沒在執行時，Claude Code 的請求會失敗，不會改成直連 Anthropic，doctor 的結束碼為 1。

由其他程式啟動的 Claude Code（Claude 桌面 app、Agent SDK host，或由另一個 Claude Code session 啟動）可能改用該程式提供的端點：在這種子程序裡，實測是 shell 的 `ANTHROPIC_BASE_URL` 勝過設定檔。在這些情境下請先確認請求實際送往哪裡。

## Proxy 做什麼

- `POST /v1/messages`：整個 body（system prompt、歷史、工具結果、工具 schema、thinking 文字）在同一個交易中遮罩。同一個值在整個 Claude Code session 中對應同一個 placeholder（以 Claude Code 的 `x-claude-code-session-id` header 區分 session），所以多輪歷史保持一致。
- 回應（JSON 或 SSE）：還原助理文字中的 placeholder，跨串流事件切開的 placeholder 也會還原。
- `POST /v1/messages/count_tokens`：同樣遮罩，因為它帶著整段對話。
- 延遲載入的工具：Claude Code 透過 ToolSearch 載入工具時，結果是只寫著工具名稱的 `tool_reference`。proxy 原樣轉送；工具名稱含偵測到的值時，請求會被擋。
- Thinking 歷史：Claude Code 會重送先前的 `thinking` block。文字照一般文字遮罩；`signature` 與 `redacted_thinking` 的資料原樣通過，因為 Anthropic 會驗證它們。
- 沒有 body 的 `GET`／`HEAD`（Claude Code 會送 `HEAD /api/hello`）：URL 以及非憑證 header 的名稱與值都沒有命中時才轉送。
- 所有路由：請求路徑或 query 有命中就擋下。上游的 redirect 既不跟隨也不轉交，直接回 400，proxy 和 Claude Code 都不會把請求重送到別的主機。
- 其他一律**擋下，不轉送**：其他路由上帶 body 的請求、遮罩器不認得的 Messages body、無法遮罩的 content block 類型、header 或結構欄位（模型名稱、工具名稱、工具 id）中的敏感值，以及遮罩錯誤。Claude Code 會顯示 `API Error: 400 LeakShield blocked …`，後面附上說明是哪項檢查的代碼。Claude Code 遇到任何 400 最多會嘗試六次，每次都會被擋。
- `GET /__leakshield/health` 由 proxy 自己回應，doctor 用它檢查。

對應關係只存在記憶體。重啟後，Claude Code 歷史中的助理文字（已還原的原值）會以新的 placeholder 再遮罩一次。Thinking 文字與 `tool_use` input 從不還原，所以重啟前的 placeholder 會留在歷史裡：它們原樣通過，模型可能看到同一個值對應兩個 placeholder，舊的也無法再還原。不會外洩，但一個 session 期間請保持 proxy 執行。

## 不涵蓋的部分

- **工具執行。** 目前沒有工具閘門。`tool_use` input 裡的 placeholder 不會還原，所以模型若把 placeholder 寫進 Bash 指令或檔案編輯，工具收到的是 placeholder 而不是原值。你看到的是還原後的助理文字，不是還原後的工具參數。透過 Claude Code hooks 在工具執行時還原是另一張 issue。
- **不走 base URL 的流量。** WebFetch 的網域安全檢查會把 hostname（不含路徑）直接送到 `api.anthropic.com`；在 Claude Code 設定中設 `skipWebFetchPreflight: true` 可關閉。遙測與錯誤回報、Bedrock／Vertex／Foundry provider、Claude Code 雲端 session 也都不經過 proxy。
- **Server tools。** Claude Code 的 WebSearch 會把 `server_tool_use` 與 `web_search_tool_result` block 放進歷史。遮罩器不認得這些 block，所以 session 用過 WebSearch 之後，接下來的請求都會被擋。其他不認得的 block 類型也一樣。
- **圖片與文件**會被擋，除非 proxy 以 `--attachments allow` 啟動；這時它們會未經掃描送出。
- **大型 session。** 超過 4 MiB 的請求 body 會被擋。
- **長時間執行的 proxy。** 一個 proxy 程序最多追蹤 4096 個 Claude Code session，且不會釋放，因為 Claude Code 不會送出 session 結束的訊號。超過之後，新的 session 都會被擋，直到重啟 proxy。
- **本機磁碟。** Claude Code 的 transcript、日誌與檔案仍保有原值。Proxy 只保護模型邊界。
- **新偵測到的 signed thinking。** 如果較早的 thinking block 含有 LeakShield 現在才偵測到的值（例如新增規則之後），遮罩會改變被簽章的文字，Anthropic 會拒絕該請求。
- [README](../README.zh-TW.md#保護範圍與不保護的部分) 列出的偵測缺口在這裡同樣適用。
