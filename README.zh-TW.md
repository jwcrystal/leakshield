# 🛡️ sensitive-guard

> 🌐 [English](./README.md) | 繁體中文

**在把程式碼、文件、資料丟給 AI 服務之前，先掃描敏感內容的守門員。**

支援四種使用模式：
- **OpenCode Plugin**：在內容寫入 session 或送往 OpenCode 模型前強制執行入口檢查
- **MCP Server**：提供 Claude Code、CI 或其他 MCP client 隨需掃描
- **CLI**：手動掃描指定文字、檔案或目錄；支援**脫敏模式**，可直接替換敏感內容
- **Web UI**：瀏覽器介面，貼上內容即可掃描；同時提供 REST API

---


## 🚀 新成員快速上手

- 3 分鐘 Onboarding：[`ONBOARDING.zh-TW.md`](./ONBOARDING.zh-TW.md)

---

## 偵測範圍

| 類型 | 說明 | 嚴重度 |
|------|------|--------|
| API Key | OpenAI、Anthropic、Google、AWS | 🔴 HIGH |
| Secret / Password | 通用密碼賦值、AWS Secret | 🔴 HIGH |
| Token | GitHub PAT、JWT、Bearer Token | 🔴 HIGH |
| DB 連線字串 | MongoDB、PostgreSQL、MySQL、Redis 等 | 🔴 HIGH |
| 台灣身份證字號 | 格式驗證 | 🔴 HIGH |
| Email 地址 | 所有 email 格式 | 🟡 MEDIUM |
| 台灣手機號碼 | 09xx-xxx-xxx | 🟡 MEDIUM |
| 國際電話 | +國碼格式 | 🟢 LOW |
| NDA 關鍵字 | 自訂（見 config/guard.config.yaml） | 🔴 HIGH |
| 私有域名 | 自訂（見 config/guard.config.yaml） | 🟡 MEDIUM |

---

## 安裝

```bash
git clone https://github.com/jwcrystal/sensitive-guard.git
cd sensitive-guard
npm install
npm run build
```

### npm scripts 速查

| 指令 | 說明 |
|------|------|
| `npm run build` | 編譯 TypeScript → `dist/` |
| `npm run dev` | 開發模式（MCP，不需先 build） |
| `npm run scan` | CLI 掃描（不需先 build） |
| `npm test` | 執行單元測試 |

---

## 使用方式

### 一、CLI 模式

```bash
# 掃描文字
npm run scan -- --text 'sk-1234abcd my_password="super_secret"'

# 掃描單一檔案
npm run scan -- --file ./src/config.ts

# 掃描整個目錄
npm run scan -- --dir ./src

# 只掃描特定副檔名
npm run scan -- --dir ./src --ext .ts .env .json

# 從 stdin 讀取
cat .env | npm run scan -- --stdin

# Build 後的版本
node dist/index.js --cli --file ./config.ts
```

Exit code：`0` = 安全，`1` = 有問題，`2` = 檔案不存在

#### 脫敏模式（Redaction）

將敏感內容替換為 `[REDACTED_TYPE]` 佔位符，而非只是回報：

```bash
# 脫敏 stdin，結果輸出到 stdout
echo 'token=sk-proj-abc123...' | npm run scan -- --redact --stdin

# 脫敏檔案，結果寫入新檔
npm run scan -- --redact --file .env --out .env.redacted

# Dry-run：只預覽哪些內容會被脫敏，不產生任何輸出
npm run scan -- --redact --dry-run --file .env
```

脫敏後的文字輸出至 **stdout**；findings 摘要輸出至 **stderr**，方便在 pipeline 中分開處理。

| Flag | 行為 |
|------|------|
| `--redact` | 替換命中內容為 `[REDACTED_TYPE]`，寫入 stdout |
| `--redact --dry-run` | 僅預覽命中位置，不輸出；有命中時 exit `1` |
| `--redact --out <path>` | 脫敏結果寫入指定檔案，不寫到 stdout |
| `--redact --format json` | 以 JSON 格式回傳 `redacted`、`findings`、`summary` |

#### CLI 選項

| 選項 | 說明 |
|------|------|
| `--format json` | 輸出 JSON（適合 CI/CD） |
| `--min-severity high` | 只回報 HIGH（或 `medium` / `low`） |
| `--allow-outside` | 允許掃描工作目錄以外的路徑（預設禁止） |
| `--enable-encoding-detection` | 啟用 Base64/URL/Hex 解碼檢測（預設關閉） |

#### 編碼檢測功能

**為什麼需要編碼檢測？**

攻擊者可能使用編碼技巧繞過敏感資料檢測：
- **Base64 編碼**：將 API Key 或密碼編碼後傳送
- **URL 編碼**：使用 `%20` 等格式隱藏關鍵字
- **Hex 編碼**：十六進制編碼繞過模式匹配

**啟用編碼檢測**

```bash
# 啟用編碼檢測掃描
npm run scan -- --enable-encoding-detection --text "c2stcHJvai1hYmMxMjM="

# 結合其他選項使用
npm run scan -- --enable-encoding-detection --file ./config.yaml --format json

# 掃描目錄時啟用
npm run scan -- --enable-encoding-detection --dir ./src --ext .ts .env
```

**效能考量**

編碼檢測會額外嘗試解碼並重新掃描內容，可能增加 10-30% 的掃描時間。建議：
- **預設關閉**：一般掃描使用預設值即可
- **按需啟用**：在處理外部來源或不明內容時啟用
- **CI/CD 環境**：建議在 CI pipeline 中啟用以攔截編碼攻擊

**檢測範例**

```bash
# Base64 編碼的 API Key
echo "c2stcHJvai1hYmMxMjM=" | npm run scan -- --enable-encoding-detection --stdin
# → 檢測到 "sk-proj-abc123" API Key

# URL 編碼的敏感內容
echo "password%3Dsecret123" | npm run scan -- --enable-encoding-detection --stdin
# → 檢測到 password 關鍵字

# 正常文字不受影響
echo "This is safe content" | npm run scan -- --enable-encoding-detection --stdin
# → 安全，無敏感內容
```

當啟用編碼檢測時，摘要會包含檢測到的編碼類型：
```
[WARNING: 編碼檢測: Base64, URL]
```

#### 工作目錄路徑限制

預設情況下，`--file` 與 `--dir` 只接受**工作目錄內**的路徑。若嘗試掃描工作目錄以外的路徑（例如 `../shared.env` 或 `/etc/passwd`），會直接拋出錯誤並終止。

如需掃描工作目錄以外的路徑，請明確加上 `--allow-outside`：

```bash
npm run scan -- --file ../shared.env --allow-outside
```

> ⚠️ 工作目錄外的掃描為選擇性開啟功能，僅在確實需要時使用。

---

### 二、Web UI 模式

啟動本地 Web 伺服器，在瀏覽器中使用：

```bash
# 預設 port 3000
npx tsx src/index.ts --web

# 指定 port
npx tsx src/index.ts --web --port 3001

# Build 後的版本
node dist/index.js --web --port 3001
```

開啟瀏覽器 `http://localhost:3001`，貼上內容後按「掃描」或 Ctrl+Enter。

#### REST API

也可直接呼叫 API：

```bash
# 掃描文字
curl -s -X POST http://localhost:3001/scan \
  -H 'Content-Type: application/json' \
  -d '{"content": "sk-proj-abc123 secret_key=test"}' | jq

# 回應格式
{
  "safe": false,
  "total_findings": 2,
  "findings": [
    { "type": "API_KEY", "severity": "HIGH", "line": 1, ... }
  ],
  "summary": "...",
  "recommendation": "..."
}
```

| 端點 | 方法 | 說明 |
|------|------|------|
| `/` | GET | Web UI HTML |
| `/scan` | POST | 掃描 `{ "content": string }`，回傳 JSON |

---

### 三、OpenCode Plugin 模式（建議使用）

OpenCode plugin 成功載入後會成為強制性整合：它會在 OpenCode 儲存或送出使用者文字給模型前掃描並攔截，清理 system prompt 與 tool definition，並在下一輪模型讀取前清理工具輸出及歷史訊息。它會固定啟用編碼內容偵測。plugin 選項或掃描設定無效時，所有受保護 hook 都會 fail closed 並中止模型請求。

先 build 專案，再將編譯後的 plugin 加到 `opencode.json`：

```json
{
  "plugin": [
    [
      "file:///絕對路徑/sensitive-guard/dist/opencode.js",
      { "mode": "block" }
    ]
  ]
}
```

`block` 是預設值，會用不含機敏值的攔截訊息替換危險內容。只有在你明確希望已辨識的直接命中改為 `[REDACTED_TYPE]` 佔位符時，才設定 `mode: "redact"`。

附件會被攔截，因為文字掃描器無法安全檢查任意二進位或遠端附件內容。既有 session 可能已存有原文，安裝 plugin 後請建立新 session。此 plugin 僅保護 OpenCode 發出的模型請求，不涵蓋其他 AI client 或本機工具。

OpenCode 目前會記錄並跳過在 plugin factory 執行前就載入失敗的模組，例如套件缺失或 JavaScript 語法錯誤。安裝或升級後，請先用 `sk-` 加至少 20 個英數字元的合成測試 key 執行 smoke test，確認訊息已被 Sensitive Guard 替換，再處理真實機敏資料。

#### 隔離 smoke test

在專案根目錄執行下列指令。它會使用暫存的 OpenCode 設定目錄與合成值，不會使用真實憑證：

```bash
npm run build
SMOKE_DIR="$(mktemp -d)"
PROJECT_DIR="$(pwd)"
cat > "$SMOKE_DIR/opencode.json" <<EOF
{
  "plugin": [
    ["file://$PROJECT_DIR/dist/opencode.js", { "mode": "block" }]
  ]
}
EOF
OPENCODE_CONFIG_DIR="$SMOKE_DIR" opencode --prompt \
  "Smoke test only. Do not reveal or use this token: sk-AAAAAAAAAAAAAAAAAAAA"
rm -rf "$SMOKE_DIR"
```

模型可見的訊息必須包含 Sensitive Guard 的攔截通知，且不可包含該合成 token。不要用真實憑證執行此測試。

發布到 npm 後，可用 `"sensitive-guard"` 取代上述 `file:` URL。

### 四、MCP Server 模式（Claude Code / CI / 手動整合）

#### 步驟 1：Build

```bash
npm run build
```

#### 步驟 2：設定 MCP client

在你的 OpenCode 設定檔（通常是 `~/.config/opencode/config.json` 或 `opencode.json`）加入：

```json
{
  "mcp": {
    "servers": {
      "sensitive-guard": {
        "type": "local",
        "command": "node",
        "args": ["/絕對路徑/sensitive-guard/dist/index.js"],
        "env": {}
      }
    }
  }
}
```

> ⚠️ **務必用絕對路徑**，不要用 `~` 或相對路徑。

#### 步驟 3：在 System Prompt 中加入守門規則

對沒有原生入口 hook 的 MCP client，在 system prompt 加入以下指令，讓 AI 在讀取任何檔案或處理你貼上的程式碼前，先呼叫掃描工具：

```
在你讀取任何本機檔案、或我提供任何程式碼 / 設定檔 / 資料之前，
請先呼叫 sensitive-guard 的 scan_file 或 scan_text 工具。
如果掃描結果的 safe 欄位為 false，請立即停止並告訴我哪些內容有問題，
等待我確認後再繼續。不要自動修改或繼續處理敏感內容。
```

#### MCP 工具列表

| 工具 | 用途 | 編碼檢測參數 |
|------|------|----------------|
| `scan_text` | 掃描一段文字（你貼進去的 code / 資料） | ✅ `enable_encoding_detection` |
| `scan_file` | 掃描本機單一檔案 | ✅ `enable_encoding_detection` |
| `scan_dir` | 掃描整個目錄（遞迴，跳過 node_modules / .git） | - |
| `redact_text` | 將命中的敏感內容替換為 `[REDACTED_TYPE]`，回傳乾淨文字 | - |
| `reload_config` | 修改 YAML 後重新載入，不用重啟 server | - |

**MCP 工具使用範例（含編碼檢測）**

```typescript
// 掃描文字並啟用編碼檢測
await mcp.callTool("scan_text", {
  content: "c2stcHJvai1hYmMxMjM=",  // Base64 編碼內容
  enable_encoding_detection: true
});

// 掃描檔案並啟用編碼檢測
await mcp.callTool("scan_file", {
  file_path: "./config.yaml",
  enable_encoding_detection: true
});
```

#### MCP 路徑限制

`scan_file` 與 `scan_dir` 只接受解析後位於 **MCP Server 啟動目錄（工作目錄）以內**的路徑。任何指向工作目錄外的路徑（包含符號連結目標）都會被拒絕並回傳錯誤，防止 AI 透過 MCP 介面讀取主機上的任意檔案。

---

## 設定檔

編輯 `config/guard.config.yaml`：

```yaml
# NDA 關鍵字（大小寫不敏感）
nda_keywords:
  - "CONFIDENTIAL"
  - "INTERNAL ONLY"
  - "DO NOT SHARE"
  - "NDA"
  - "PROPRIETARY"
  # 加入你公司的內部關鍵字：
  # - "Project Phoenix"
  # - "MyCompany Internal"

# 私有域名
private_domains:
  - "internal.mycompany.com"
  # - "dev.yourcompany.io"

settings:
  max_chars: 200000      # 超過截斷，避免掃太久
  show_line_numbers: true
  preview_length: 60
  encoding_detection: false  # 編碼檢測（Base64/URL/Hex），預設關閉
```

修改後：
- **CLI**：下次執行自動載入
- **MCP Server**：呼叫 `reload_config` 工具，或重啟 server

---

## 實務使用建議

### 場景一：你要把一個設定檔交給 OpenCode 分析

```
你（對 OpenCode）：請幫我看看這個 config.ts 有沒有問題
OpenCode（自動）：[呼叫 scan_file config.ts]
→ 發現 API_KEY，HIGH severity，第 12 行
→ 停止並報告給你
你：把第 12 行換成假 key 後再繼續
```

### 場景二：你在 CLI 掃描整個專案再送出

```bash
npm run cli -- --dir ./my-project
# 如果 exit code = 1，表示有問題，先處理再貼給 AI
```

### 場景三：CI/CD 整合（防止含敏感資訊的 prompt 進入 pipeline）

```bash
# 在 CI script 加入
node dist/index.js --cli --dir ./prompts
if [ $? -ne 0 ]; then
  echo "❌ 偵測到敏感內容，停止 pipeline"
  exit 1
fi
```

---

## 設定檔驗證

動態規則的輸入長度在載入時會透過 Zod 驗證：

| 欄位 | 最大長度 |
|------|---------|
| `nda_keywords` 每個項目 | 200 字元 |
| `private_domains` 每個項目 | 255 字元 |

超過長度限制的值會導致 `loadConfig()` 拋出 Zod 驗證錯誤，避免過長的 pattern 進入掃描器。

## 敏感資訊預覽行為

掃描結果中所有敏感資訊的預覽一律顯示為 `****`，不論原始值長度為何，不保留任何前後綴字元。這樣可避免在日誌、CI 輸出或 MCP 回應中洩漏部分機密內容。

## 注意事項

- 這個工具是**靜態 pattern 掃描**，無法保證 100% 覆蓋所有情況
- **高誤報情境**：測試用的假 key（如 `sk-test123456`）、範例程式碼中的佔位符，可能被誤判為真實 key
- 最終判斷仍需你自己確認，工具的作用是「提醒」而非「保證」
- NDA 關鍵字請只填真正機密的詞，避免太多誤報影響使用體驗
