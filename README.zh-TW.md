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

OpenCode plugin 成功載入後會成為強制性整合：它會在 OpenCode 儲存或送出使用者文字給模型前掃描並攔截，清理 system prompt 與 tool definition，並在下一輪模型讀取前清理工具輸出及歷史訊息。它會固定啟用編碼內容偵測。plugin 選項或掃描設定無效時，所有受保護 hook 都會 fail closed 並中止模型請求。受限的 SHA-256 決策快取會避免重複掃描未變動歷史，同時不保留原文或脫敏後內容。transparent 模式下，tool input schema 內的注解文字（`description`/`title` 的值）若命中掃描規則，會與一般內容一樣遮罩為化名 token；識別碼位置（tool 名稱、property key、enum/const 值、regex pattern）仍會拒絕整個請求而不會被改名。

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

**僅限 OpenCode v2 — 透明假名化（transparent）：** 設定 `"mode": "transparent"` 後，偵測到的敏感值會在送往支援的模型請求前替換為穩定的不透明 `[SGP1:…]` 佔位符；反查映射僅存在行程記憶體、以 OpenCode session 為界、永不持久化，也沒有固定 TTL。已知佔位符會在工具執行前還原到工具輸入，並在支援的 wire 回應中還原助理顯示文字。防護涵蓋以 URL 路徑形狀判別的三種自訂 provider 協定——Chat Completions、Anthropic Messages、OpenAI Responses——含串流。無法安全防護的一律拒絕而非放行：WebSocket 與 `aisdk` provider 套件路由、未知或混形 body、以及出現在 transport metadata 或結構識別碼中的佔位符。重新啟動或映射遺失後，請重讀來源並更新受影響的參數；無法還原或不安全的還原會拒絕該次工具呼叫，附可行指引且不留副作用。本機歷史、日誌與產生的檔案仍可能含原文——plugin 保護的是模型邊界，不是你的磁碟。

**僅限 OpenCode v2 — Email 去識別化試驗：** 選擇性開啟的 `deidentify` 選項（必須搭配 `mode: "redact"`）會將重複出現的 MEDIUM 等級 email 命中改為穩定且不透明的 `[SG-EMAIL-…]` 佔位符，讓 agent 能關聯多筆記錄而不會看到原始地址。對應金鑰在每次 plugin setup（即一個 OpenCode session）產生一次、僅存在記憶體、永不持久化——佔位符在同一個 live session 內穩定，重新啟動後即改變，且不存在反查映射。其他行為維持不變：HIGH 憑證仍會被脫敏或攔截，截斷、編碼或無法驗證的內容會攔截整個單元。

```jsonc
{ "package": "/絕對路徑/sensitive-guard/dist", "options": { "mode": "redact", "deidentify": true } }
```

**選擇性開啟的唯讀 env 查詢（兩個版本皆支援）：** `envQueries` 選項（預設 `false`）針對 `settings.env_files` 所列檔案提供三個唯讀工具，讓 agent 能回答設定問題而不看到任何 value：

| 工具 | 契約 |
|---|---|
| `guard_env_list` | 回傳不透明、僅限當前 session 的 file id 與 key 名稱——永遠不含路徑、value、長度或預覽。 |
| `guard_env_inspect(file_id, key)` | 回傳 `missing` \| `empty` \| `nonempty`；非空時再給粗略詞彙形態 `boolean_like` \| `number_like` \| `multiline_text` \| `text`。形態只是提示，不代表該值是有效的布林或數字。 |
| `guard_env_compare(left_file_id, left_key, right_file_id, right_key)` | key 對 key（同檔或跨檔）相等性比較，回傳 `equal` \| `different` \| `unavailable`。缺少的 key 或無法讀取的檔案回 `unavailable`。 |

```jsonc
{ "package": "/絕對路徑/sensitive-guard/dist", "options": { "mode": "block", "envQueries": true } }
```

基本規則：只有 `settings.env_files` 內的檔案可查（最多 16 個、各 1 MiB）。file id 只在列出它的 session 有效。每次呼叫都重新讀檔，比較的兩個運算元取自同一份單次呼叫快照。任何輸出都不會出現原始 value、value 長度、預覽、指紋或反查映射。若 setup 後 guard 設定檔變更，工具會回傳固定的「請重啟」錯誤直到 OpenCode 重啟——絕不悄悄退回新舊任一份授權。

檔案存取採「盡力而為的路徑身分驗證」，不是 sandbox。Workspace root 在 setup 時凍結（解析後的路徑加上 device/inode 身分）；每次查詢都會在開檔前與讀取後重新 lstat root 與每個祖先目錄、拒絕任何路徑元件上的 symlink（包括解析到別處——即使仍在 workspace 內——的祖先目錄 symlink）、要求一般檔案、以 `O_NOFOLLOW` 與 `O_NONBLOCK` 開啟完整解析後的 canonical 路徑，並以讀取前後的 size/mtime 檢查把開啟的 descriptor 綁定到 lstat 過的 inode。限制（據實以告）：同一擁有者的惡意並發檔案系統變動不在本威脅模型內——在兩次檢查之間替換又還原（ABA 競態，發生在 root、祖先目錄或檔案上）無法靠路徑檢查偵測；hardlink 與原始檔案不做區分（不檢查出處）；保留 size 與 mtime 的就地覆寫無法分辨；且 agent 仍可透過其他工具修改 env 檔案——因此結果描述的是檔案當下狀態，而非可信任的基準。key 名稱本身照原樣回傳，並照常通過既有的輸出／歷史保護。OpenCode v1 上這些工具透過標準 v1 tool API（`@opencode-ai/plugin`，由 v1 host 提供）註冊。

附件：transparent 模式支援 `attachments` 政策，動作為 DLP 標準命名。**`"block"`（預設）** 會略過 media／file parts——以通知文字取代，二進位永不離開本機，對話照常繼續（模型讀不到圖片）。**`"allow"`** 會將附件未掃描送出並附加一則可見通知——這是明確的設定層決定，代表你為圖片內容作保（`"allow"` 需搭配 `mode: "transparent"`）。三家參考產品都直接放行附件且無選項。block／redact 模式下附件照舊攔截。既有 session 可能已存有原文，安裝 plugin 後請建立新 session。此 plugin 僅保護 OpenCode 發出的模型請求，不涵蓋其他 AI client 或本機工具。

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

`env_files` 路徑相對專案根目錄，且不能離開 workspace。Guard 只讀取非空且至少 8 字元的 value，掃描準備送往模型的內容是否出現完全相同的值。載入的 value 不會傳給模型、寫入 log 或序列化；也不會自動讀取所有 process environment variables。修改已啟用的 `.env` 後，請重啟 OpenCode。選擇性開啟的 `envQueries` plugin 工具（見 OpenCode Plugin 一節）查詢的是同樣這些檔案，且永不回傳其 value。

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
