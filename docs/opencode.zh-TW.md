# OpenCode plugin

[← README](../README.zh-TW.md) · 🌐 [English](opencode.md) | 繁體中文

OpenCode plugin 是 LeakShield 目前最完整的宿主整合：它在 OpenCode 的 content hooks 掃描，transparent 模式下還會檢查最終送往 provider 的 body。其他宿主見 [pi](pi.zh-TW.md) 與 [Claude Code](claude-code.zh-TW.md)；各宿主的涵蓋範圍見[宿主能力矩陣](host-capabilities.md)。

OpenCode plugin 成功載入後會成為強制性整合：它會在 OpenCode 儲存或送出使用者文字給模型前掃描並攔截，清理 system prompt 與 tool definition，並在下一輪模型讀取前清理工具輸出及歷史訊息。它會固定啟用編碼內容偵測。plugin 選項或掃描設定無效時，所有受保護 hook 都會 fail closed 並中止模型請求。受限的 SHA-256 決策快取會避免重複掃描未變動歷史，同時不保留原文或脫敏後內容。

Transparent 模式細節見[編碼內容與 tool schema](plugin/transparent-mode.zh-TW.md#編碼內容與-tool-schema)。

LeakShield 只支援 OpenCode v2：v2 載入套件的 `id` + `setup(ctx)` 定義。OpenCode v1 已不再支援：v1 host 載入此套件時會得到 fail-closed 的 hooks，中止每一個模型請求，`leakshield --doctor` 也會回報 `BROKEN`。請升級到 OpenCode v2。

**OpenCode v2** — 將 `plugins` 指向已發佈的套件，或本機 build 的 `dist` 目錄：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "leakshield" // 或 "/絕對路徑/leakshield/dist"
      // 不設定 options 時，v2 的 mode 預設為 "transparent"。
      // 想改成直接攔截，加上 "options": { "mode": "block" }。
    }
  ]
}
```

注意 v2 只接受 plugin「目錄」（會解析 `dist/index.js`）或套件名稱；指向單一 `.js` 檔的 `file://` URL 會被拒絕，並出現 `configured plugin path must be a directory`。

`mode` 的預設值是 **`transparent`**（見 [Transparent 模式](plugin/transparent-mode.zh-TW.md)）。`block` 會用不含機敏值的攔截訊息替換危險內容；想使用這個行為，請設定 `"mode": "block"`。只有在你明確希望已辨識的直接命中改為 `[REDACTED_TYPE]` 佔位符時，才設定 `mode: "redact"`。`--doctor` 會顯示實際生效的 mode，沒有設定時會標示 `(default)`。

## `PARTIAL` 的意思

`leakshield --doctor` 在兩種狀態下 exit 0。它們是安裝層的結果，不保證敏感內容絕不會送到模型。可用 `--doctor opencode`、`--doctor claude-code` 或 `--doctor pi`（也支援 `--doctor=<host>`）只檢查單一 host，exit code 只反映它。

| 狀態 | 設定 | 意思 |
|------|------|------|
| `PROTECTED` | `block` 或 `redact`，或 transparent 且 `wireProtection` 省略或為 `true`（v2 預設），且每個已宣告的 capability 列都被覆蓋 | 安裝層檢查通過。transparent 模式下也會驗證最終的 HTTP body 或支援的 WS frame |
| `PARTIAL` | Transparent 且 `wireProtection: false`（[hook-first 範本](../config/opencode.hook-first.example.json)），或該 host 的[已宣告 capability 列](host-capabilities.md)包含 `unknown` 或 `outside` | 不檢查最終出站 HTTP body，或某條已宣告的出口沒有覆蓋；doctor 會指名該列與關閉它的 issue |

Doctor 會分開印出 `Configuration status`、`Wire protection` 與宿主整體的 `Coverage`。`Wire protection: enabled` 代表已驗證的設定，不是執行中 session 已成功攔截的證明；block 模式顯示 `not-applicable`，設定尚不明確時顯示 `unknown`。`PARTIAL` 會分別列出設定與宿主覆蓋的原因，兩者同時存在時都會印出。宿主覆蓋不依目前選擇的 provider／model 篩選。每個宿主區段也會印出宣告的憑證處理方式、映射持久化政策與完整 residuals；`opt-in` 表示支援選用持久化，不代表本次安裝已啟用。

`PARTIAL` 時：

- 後續新增內容／附件可能未遮罩，即使設定 `attachments: "block"`。
- **Hook 內無法遮罩的輸入仍拒絕該次請求**；不是靜默放行原文。

兩種層級的說明見 [Wire 保護](plugin/wire-protection.zh-TW.md)。

**僅限 OpenCode v2 — Email 去識別化試驗：** 選擇性開啟的 `deidentify` 選項（必須搭配 `mode: "redact"`）會將重複出現的 MEDIUM 等級 email 命中改為穩定且不透明的 `[SG-EMAIL-…]` 佔位符，讓 agent 能關聯多筆記錄而不會看到原始地址。對應金鑰在每次 plugin setup（即一個 OpenCode session）產生一次、僅存在記憶體、永不持久化——佔位符在同一個 live session 內穩定，重新啟動後即改變，且不存在反查映射。其他行為維持不變：HIGH 憑證仍會被脫敏或攔截，截斷、編碼或無法驗證的內容會攔截整個單元。

```jsonc
{ "package": "/絕對路徑/leakshield/dist", "options": { "mode": "redact", "deidentify": true } }
```

附件：transparent 模式支援 `attachments` 政策（複數；`attachment` 不會被辨識）。**`"block"`（預設）** 會在 content hooks 略過 media／file parts 並以通知文字取代，模型讀不到這些被略過的圖片。Final wire 保護也會拒絕 wire 上殘留的附件 part；hook-first 不檢查後續才加入的附件。**`"allow"`** 會將附件未掃描送出並附加一則可見通知——這是明確的決定，代表你為附件內容作保（`"allow"` 需搭配 `mode: "transparent"`）。block／redact 模式下附件照舊攔截。既有對話可能重播原文，受[重啟限制](plugin/transparent-mode.zh-TW.md#重啟限制)影響；開新對話不能取代驗證復原。此 plugin 僅保護 OpenCode 發出的模型請求，不涵蓋其他 AI client 或本機工具。

OpenCode 目前會記錄並跳過在 plugin factory 執行前就載入失敗的模組，例如套件缺失或 JavaScript 語法錯誤。安裝或升級後，請先用 `sk-` 加至少 20 個英數字元的合成測試 key 執行 smoke test，確認訊息已被 LeakShield 替換，再處理真實機敏資料。

## 隔離 smoke test（OpenCode v2）

在專案根目錄執行下列指令。它會使用暫存工作目錄與合成值，不會使用真實憑證：

```bash
npm run build
SMOKE_DIR="$(mktemp -d)"
PROJECT_DIR="$(pwd)"
cat > "$SMOKE_DIR/opencode.json" <<EOF
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "$PROJECT_DIR/dist", "options": { "mode": "block" } }
  ]
}
EOF
(cd "$SMOKE_DIR" && opencode run --standalone \
  "Smoke test only. Do not reveal or use this token: sk-AAAAAAAAAAAAAAAAAAAA")
rm -rf "$SMOKE_DIR"
```

模型可見的訊息必須包含 LeakShield 的攔截通知，且不可包含該合成 token。不要用真實憑證執行此測試。

要測試已發佈的套件時，可用 `"leakshield"` 取代上述本機 `dist` 路徑。

## 自動安裝檢查：`--doctor`

```bash
leakshield --doctor     # 全域安裝或 npm link 後；在 repo 內可用 npm run scan -- --doctor
```

Doctor 不會把任何內容送出去。它會檢查 OpenCode host 版本、讀取 OpenCode 會套用的 `opencode.json` 或 `opencode.jsonc`（`.opencode/`、專案根目錄和一個全域目錄）、依 host 的方式合併其中的 `plugins` 陣列、確認 LeakShield 已用 plugin 本身接受的選項註冊、確認本機 `dist` 進入點真的存在（缺少時 OpenCode 會靜默記錄並跳過 plugin：session 看起來正常但沒有保護）、載入 guard 設定，並在本機跑合成 canary 的 smoke scan。每個 host 區段後面會印出該 host 宣告的 capability 列（[總表](host-capabilities.md)）；`unknown` 或 `outside` 會讓該 host 停在 `PARTIAL`，並指名關閉它的 issue。Exit code 0 代表 `PROTECTED` 或 `PARTIAL`（`wireProtection: false`：不檢查最終出站 HTTP body）；v1 host 會回報 `BROKEN`，修正方式是升級到 OpenCode v2；其他狀態會印出失敗的檢查項與具體修正方式，plugin 未註冊時還會附上可直接複製的註冊片段。另有 `Claude Code:` 區段檢查 [Claude Code proxy](claude-code.zh-TW.md) 的設定；即使沒有 OpenCode，只要 Claude Code 經過執行中的 LeakShield proxy，結束碼也是 0。

Doctor 是在 host 之外執行的安裝層檢查，看不到執行中的 session。執行期的證明來自上面的 smoke test 或 `scripts/e2e/run-boundary.mjs`。

## 詳細說明

- [Transparent 模式](plugin/transparent-mode.zh-TW.md): 佔位符、支援的協定、工具參數還原（依欄位判斷、`code`／`script` 欄位、Code Mode、`curl`、`rtk`）、重啟限制
- [Wire 保護](plugin/wire-protection.zh-TW.md): hook-only 與 final wire 兩種層級、AI SDK provider、拒絕、回覆端復原
- [Native WebSocket](plugin/websocket.zh-TW.md): 實驗性的 Responses-family 支援與限制
- [映射持久化](plugin/persistence.zh-TW.md): 選擇性開啟的加密儲存、金鑰保管、清除
- [容量與生命週期](plugin/capacity.zh-TW.md): 預算、session 上限、保留
- [唯讀 env 查詢](plugin/env-queries.zh-TW.md): 選擇性開啟、不回傳 value 的設定查詢工具
