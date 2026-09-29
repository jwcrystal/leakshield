<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./icon.svg">
  <img alt="sensitive-guard" src="./icon.svg" width="64">
</picture>

# sensitive-guard

> 🌐 [English](./README.md) | 繁體中文

**在把程式碼、文件、資料丟給 AI 服務之前，先掃描敏感內容的守門員。**

支援三種使用模式：
- **OpenCode Plugin**：OpenCode 的強制入口檢查；OpenCode 要把內容送往模型時使用。
- **CLI**：手動或 CI 掃描文字、檔案與目錄；支援脫敏。
- **Web UI**：本機瀏覽器介面與 REST endpoint，供手動掃描。

MCP Server 模式已移除。它依賴模型在已收到相關 context 後自行決定呼叫掃描工具，無法提供 plugin 的安全邊界。

| 模式 | 啟動方式 | 適用情境 |
|------|----------|----------|
| OpenCode Plugin | 在 `opencode.json` 加入 `dist` 目錄（v2）或 `dist/opencode.js`（v1） | 自動且 fail-closed 地保護 OpenCode 模型輸入與工具輸出 |
| CLI | `npx sensitive-guard --file ./path` | 明確的本機或 CI 掃描；不會把內容送到模型 |
| Web UI | `npm run web` | 在 `http://localhost:3000` 手動以瀏覽器掃描 |

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

Build 後使用 `npx sensitive-guard`。若已全域安裝，可直接使用
`sensitive-guard`；在此 repository 開發時仍可用 `npm run scan -- ...`。

### npm scripts 速查

| 指令 | 說明 |
|------|------|
| `npm run build` | 編譯 TypeScript → `dist/` |
| `npm run dev` | CLI 模式（不需先 build） |
| `npm run scan` | CLI 掃描（不需先 build） |
| `npm run web` | 啟動本機 Web UI（不需先 build） |
| `npm test` | 執行單元測試 |
| `npm run binary` | 建置當前平台的獨立執行檔（macOS ARM） |
| `npm run binary:win` | 跨編譯 Windows x64 |
| `npm run binary:linux` | 跨編譯 Linux x64 |
| `npm run binary:mac-intel` | 跨編譯 macOS Intel |
| `npm run binary:all` | 一次建置所有平台 |

---

## 獨立執行檔

無法使用 Node.js 或 npm？用 [Bun](https://bun.sh) 建置成單一執行檔，目標機器不需任何 runtime。

```bash
# 一鍵建置當前平台
npm run binary

# 跨平台編譯
npm run binary:win     # Windows x64  → sensitive-guard.exe
npm run binary:linux   # Linux x64    → sensitive-guard-linux
npm run binary:all     # 全平台
```

或直接用 Bun：

```bash
bun build --compile --target=bun-windows-x64 ./src/cli.ts --outfile=sensitive-guard.exe
```

產出單一執行檔，直接交給任何人，無任何相依套件。

### 自訂設定（binary 使用者）

執行檔內建預設值可直接使用。若要自訂規則（NDA 關鍵字、私有網域、自訂正則），將 `config/guard.config.yaml` 放在以下任一位置：

| 位置 | 範圍 |
|------|------|
| `./config/guard.config.yaml` | 當前工作目錄 |
| `~/.sensitive-guard/guard.config.yaml` | 所有位置（家目錄） |

```bash
# 快速開始：把設定放到家目錄
mkdir -p ~/.sensitive-guard
cp config/guard.config.yaml ~/.sensitive-guard/

# 或依專案放置
mkdir -p ./config
# 編輯 ./config/guard.config.yaml
```

詳見[設定](#設定)章節。

---

## 使用方式

### CLI

```bash
# 掃描文字
npx sensitive-guard --text 'sk-proj-test1234567890abcdef my_password="super_secret"'

# 掃描單一檔案
npx sensitive-guard --file ./src/config.ts

# 掃描整個目錄
npx sensitive-guard --dir ./src

# 只掃描特定副檔名
npx sensitive-guard --dir ./src --ext .ts .env .json

# 從 stdin 讀取
cat .env | npx sensitive-guard --stdin

# 全域安裝後
sensitive-guard --file ./config.ts
```

Exit code：`0` = 安全，`1` = 有問題，`2` = 檔案不存在

#### 脫敏模式（Redaction）

將敏感內容替換為 `[REDACTED_TYPE]` 佔位符，而非只是回報：

```bash
# 脫敏 stdin，結果輸出到 stdout
echo 'token=sk-proj-test1234567890abcdef' | npx sensitive-guard --redact --stdin

# 脫敏檔案，結果寫入新檔
npx sensitive-guard --redact --file .env --out .env.redacted

# Dry-run：只預覽哪些內容會被脫敏，不產生任何輸出
npx sensitive-guard --redact --dry-run --file .env
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
npx sensitive-guard --enable-encoding-detection --text "c2stcHJvai1hYmMxMjM="

# 結合其他選項使用
npx sensitive-guard --enable-encoding-detection --file ./config.yaml --format json

# 掃描目錄時啟用
npx sensitive-guard --enable-encoding-detection --dir ./src --ext .ts .env
```

**效能考量**

編碼檢測會額外嘗試解碼並重新掃描內容，可能增加 10-30% 的掃描時間。建議：
- **預設關閉**：一般掃描使用預設值即可
- **按需啟用**：在處理外部來源或不明內容時啟用
- **CI/CD 環境**：建議在 CI pipeline 中啟用以攔截編碼攻擊

**檢測範例**

```bash
# Base64 編碼的 API Key
echo "c2stcHJvai1hYmMxMjM=" | npx sensitive-guard --enable-encoding-detection --stdin
# → 檢測到 "sk-proj-abc123" API Key

# URL 編碼的敏感內容
echo "password%3Dsecret123" | npx sensitive-guard --enable-encoding-detection --stdin
# → 檢測到 password 關鍵字

# 正常文字不受影響
echo "This is safe content" | npx sensitive-guard --enable-encoding-detection --stdin
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
npx sensitive-guard --file ../shared.env --allow-outside
```

> ⚠️ 工作目錄外的掃描為選擇性開啟功能，僅在確實需要時使用。

---

### Web UI

啟動本地 Web 伺服器，在瀏覽器中使用：

```bash
# 預設 port 3000
npx tsx src/cli.ts --web

# 指定 port
npx tsx src/cli.ts --web --port 3001

# Build 後的版本
node dist/cli.js --web --port 3001
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

### OpenCode Plugin（建議使用）

OpenCode plugin 成功載入後會成為強制性整合：它會在 OpenCode 儲存或送出使用者文字給模型前掃描並攔截，清理 system prompt 與 tool definition，並在下一輪模型讀取前清理工具輸出及歷史訊息。它會固定啟用編碼內容偵測。plugin 選項或掃描設定無效時，所有受保護 hook 都會 fail closed 並中止模型請求。受限的 SHA-256 決策快取會避免重複掃描未變動歷史，同時不保留原文或脫敏後內容。

同一份編譯產物同時支援兩個 OpenCode 大版本：v2 載入套件的 `id` + `setup(ctx)` 定義，v1（1.18.29+）呼叫舊版 `server()` factory。

**OpenCode v2** — 先 build 專案，再將 `plugins` 指向 `dist` 目錄（發布到 npm 後也可用套件名稱）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/絕對路徑/sensitive-guard/dist",
      "options": { "mode": "block" }
    }
  ]
}
```

注意 v2 只接受 plugin「目錄」（會解析 `dist/index.js`）或套件名稱；指向單一 `.js` 檔的 `file://` URL 會被拒絕，並出現 `configured plugin path must be a directory`。

**OpenCode v1（1.18.29+）** — 使用舊版 `plugin` 陣列指向編譯後的 plugin 檔案：

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

#### 隔離 smoke test（OpenCode v2）

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

模型可見的訊息必須包含 Sensitive Guard 的攔截通知，且不可包含該合成 token。不要用真實憑證執行此測試。

發布到 npm 後，可用 `"sensitive-guard"` 取代上述本機 `dist` 路徑。

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
  # 選用：將指定檔案的 value 作為 exact-secret matcher，不會自動讀取 .env
  env_files:
    - .env
    - .env.local
```

`env_files` 路徑相對專案根目錄，且不能離開 workspace。Guard 只讀取非空且至少 8 字元的 value，掃描準備送往模型的內容是否出現完全相同的值。載入的 value 不會傳給模型、寫入 log 或序列化；也不會自動讀取所有 process environment variables。修改已啟用的 `.env` 後，請重啟 OpenCode。

修改後：
- **CLI**：下次執行自動載入
- **OpenCode Plugin**：重啟 OpenCode 以重新載入 plugin 設定
- **Web UI**：重啟本機 server

---

## 實務使用建議

### 場景一：你要把一個設定檔交給 OpenCode 分析

```
你（對 OpenCode）：請幫我看看這個 config.ts 有沒有問題
OpenCode：[讀取 config.ts]
→ 工具輸出含有 API_KEY
→ plugin 在下一輪模型讀取前將其替換
→ OpenCode 收到攔截通知，而非 secret
你：把第 12 行換成假 key 後再繼續
```

### 場景二：你在 CLI 掃描整個專案再送出

```bash
npx sensitive-guard --dir ./my-project
# 如果 exit code = 1，表示有問題，先處理再貼給 AI
```

### 場景三：CI/CD 整合（防止含敏感資訊的 prompt 進入 pipeline）

```bash
# 在 CI script 加入
node dist/cli.js --cli --dir ./prompts
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

掃描結果中所有敏感資訊的預覽一律顯示為 `****`，不論原始值長度為何，不保留任何前後綴字元。這樣可避免在日誌、CI 輸出或 Web UI 回應中洩漏部分機密內容。

## 注意事項

- 這個工具是**靜態 pattern 掃描**，無法保證 100% 覆蓋所有情況
- **高誤報情境**：測試用的假 key（如 `sk-test123456`）、範例程式碼中的佔位符，可能被誤判為真實 key
- 最終判斷仍需你自己確認，工具的作用是「提醒」而非「保證」
- NDA 關鍵字請只填真正機密的詞，避免太多誤報影響使用體驗
