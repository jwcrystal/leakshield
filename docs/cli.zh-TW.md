# CLI 與 Web UI

[← README](../README.zh-TW.md) · 🌐 [English](cli.md) | 繁體中文

CLI 與 Web UI 只掃描你交給它們的文字，不會把內容送到模型。要保護送往模型的請求，請見 [README](../README.zh-TW.md#快速開始) 的宿主整合。

## CLI

```bash
# 掃描文字
npm run scan -- --text 'sk-proj-test1234567890abcdef my_password="super_secret"'

# 掃描單一檔案
npm run scan -- --file ./src/config.ts

# 掃描整個目錄
npm run scan -- --dir ./src

# 只掃描特定副檔名
npm run scan -- --dir ./src --ext .ts .env .json

# 從 stdin 讀取
cat .env | npm run scan -- --stdin

# 全域安裝後
leakshield --file ./config.ts
```

Exit code：`0` = 安全（ALLOW），`1` = 有發現（WARN 或 CONFIRM），`2` = 檔案不存在

### 脫敏模式（Redaction）

將敏感內容替換為 `[REDACTED_TYPE]` 佔位符，而非只是回報：

```bash
# 脫敏 stdin，結果輸出到 stdout
echo 'token=sk-proj-test1234567890abcdef' | npm run scan -- --redact --stdin

# 脫敏檔案，結果寫入新檔
npm run scan -- --redact --file .env --out .env.redacted

# Dry-run：只預覽哪些內容會被脫敏，不產生任何輸出
npm run scan -- --redact --dry-run --file .env
```

脫敏後的文字輸出至 **stdout**；findings 摘要輸出至 **stderr**，方便在 pipeline 中分開處理。

| Flag | 行為 |
|------|------|
| `--redact` | 替換命中內容為 `[REDACTED_TYPE]`，寫入 stdout；脫敏後仍有命中時不輸出 |
| `--redact --dry-run` | 僅預覽命中位置，不輸出；有命中時 exit `1` |
| `--redact --out <path>` | 脫敏結果寫入指定檔案，不寫到 stdout |
| `--redact --format json` | 以 JSON 格式回傳 `redacted`、`findings`、`summary` |

### CLI 選項

| 選項 | 說明 |
|------|------|
| `--format json` | 輸出 JSON（適合 CI/CD） |
| `--min-severity high` | 只回報 HIGH（或 `medium` / `low`） |
| `--allow-outside` | 允許掃描工作目錄以外的路徑（預設禁止） |
| `--enable-encoding-detection` | 啟用 Base64/URL/Hex 解碼檢測（預設關閉） |

### 編碼檢測功能

**為什麼需要編碼檢測？**

攻擊者可能使用編碼技巧繞過敏感資料檢測：
- **Base64 編碼**：將 API Key 或密碼編碼後傳送
- **URL 編碼**：使用 `%20` 等格式隱藏關鍵字
- **Hex 編碼**：十六進制編碼繞過模式匹配

**啟用編碼檢測**

```bash
# 啟用編碼檢測掃描
npm run scan -- --enable-encoding-detection --text "c2stcHJvai10ZXN0MTIzNDU2Nzg5MGFiY2RlZg=="

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
echo "c2stcHJvai10ZXN0MTIzNDU2Nzg5MGFiY2RlZg==" | npm run scan -- --enable-encoding-detection --stdin
# → 檢測到 OpenAI API Key（合成值）

# URL 編碼的敏感內容
echo "password%3Dsecret123" | npm run scan -- --enable-encoding-detection --stdin
# → 檢測到 password 關鍵字

# 正常文字不受影響
echo "This is safe content" | npm run scan -- --enable-encoding-detection --stdin
# → 安全，無敏感內容
```

偵測到編碼內容時，文字與 JSON 摘要都會列出編碼類型，語言依 `LEAKSHIELD_LANG` 而定。下面是 `LEAKSHIELD_LANG=zh-TW` 的輸出；預設為英文，會顯示 `[WARNING: Encoded content: Base64, URL]`：

```
[WARNING: 編碼檢測: Base64, URL]
```

### 工作目錄路徑限制

預設情況下，`--file` 與 `--dir` 只接受**工作目錄內**的路徑。若嘗試掃描工作目錄以外的路徑（例如 `../shared.env` 或 `/etc/passwd`），會直接拋出錯誤並終止。

如需掃描工作目錄以外的路徑，請明確加上 `--allow-outside`：

```bash
npm run scan -- --file ../shared.env --allow-outside
```

> ⚠️ 工作目錄外的掃描為選擇性開啟功能，僅在確實需要時使用。

### 忽略指令

CLI 與 Web UI 會跳過含有 `leakshield-ignore`、`guard:skip`、`guard:ignore`、`sg-ignore`、`no-scan` 或 `skip-guard`（不分大小寫）的整行。即使該行有真實密碼，也會回報 `ALLOW`。

> ⚠️ 任何能編輯受掃描檔案的人都能加上這類指令，所以 CLI 掃描擋不住不受信任的變更。宿主整合（OpenCode plugin、pi extension、Claude Code proxy）都不理會這些指令。

## Web UI

啟動本地 Web 伺服器，在瀏覽器中使用：

```bash
# 已安裝套件（預設 port 3000）
leakshield --web

# 在 repo 內、不需建置
npx tsx src/cli.ts --web

# 指定 port
npx tsx src/cli.ts --web --port 3001

# Build 後的版本
node dist/cli.js --web --port 3001
```

開啟瀏覽器 `http://localhost:3001`，貼上內容後按「掃描」或 Ctrl+Enter。

### REST API

也可直接呼叫 API：

```bash
# 掃描文字
curl -s -X POST http://localhost:3001/scan \
  -H 'Content-Type: application/json' \
  -d '{"content": "sk-proj-test1234567890abcdef my_password=\"super_secret\""}' | jq

# 回應格式
{
  "decision": "CONFIRM",
  "riskLevel": "CRITICAL",
  "summary": "...",
  "findings": [
    { "type": "API_KEY", "severity": "HIGH", "description": "OpenAI API Key", "preview": "****", "line": 1 },
    { "type": "SECRET", "severity": "HIGH", "description": "...", "preview": "****", "line": 1 }
  ],
  "recommendedAction": "BLOCK",
  "redactedContent": "[REDACTED_API_KEY] my_[REDACTED_SECRET]",
  "redactionVerified": true,
  "residualFindings": 0,
  "wasTruncated": false
}
```

`redactionVerified` 為 `false` 時不會回傳 `redactedContent`。

| 端點 | 方法 | 說明 |
|------|------|------|
| `/` | GET | Web UI HTML |
| `/scan` | POST | 掃描 `{ "content": string }`，回傳 JSON |

## 決策模型

每次掃描都會產生一個**決策**，告訴呼叫端該如何處理內容。CLI 與 Web UI 會直接回報這個決策；宿主整合則依命中結果處理（transparent 模式遮罩，`redact`、`block` 模式取代或拒絕）：

| 決策 | 時機 | 風險等級 | 意義 |
|------|------|----------|------|
| `ALLOW` | 沒有發現 | LOW | 內容乾淨，可安全送出 |
| `WARN` | 只有 LOW 嚴重度的發現 | MEDIUM | 偵測到次要項目，顯示提醒，內容仍可送出 |
| `CONFIRM` | 有 MEDIUM 或 HIGH 的發現 | HIGH / CRITICAL | 偵測到敏感內容，使用者必須明確確認 |

### CONFIRM 的處理方式

決策為 `CONFIRM` 時，CLI 是非互動式的：會印出警告卡片與下一步提示，不會請你選擇。提示會建議使用 `--format json`（讀取 `redactedContent`）或 `--redact`（輸出脫敏版本）。Exit code `1` 表示內容已被攔截。

`CONFIRM` 決策包含：
- `recommendedAction`：`REVIEW`（MEDIUM 發現）或 `BLOCK`（HIGH 發現）
- `safePreview`：圍繞第一個發現的遮罩摘錄
- `redactedContent`：所有敏感片段都已取代的完整內容

無法精確定位敏感片段時（例如編碼片段中夾了零寬字元），不會有 `safePreview` 和 `redactedContent`。欄位不存在代表沒有可用的安全版本。

### JSON 輸出欄位

使用 `--format json` 時，輸出包含以下與決策相關的欄位：

| 欄位 | 說明 |
|------|------|
| `decision` | `ALLOW`、`WARN` 或 `CONFIRM` |
| `riskLevel` | `LOW`、`MEDIUM`、`HIGH` 或 `CRITICAL` |
| `recommendedAction` | `REVIEW` 或 `BLOCK`（僅 CONFIRM） |
| `findings` | 已清理的發現陣列（不含內部中繼資料） |
| `safePreview` | 遮罩摘錄（僅 CONFIRM；可能不存在） |
| `redactedContent` | 完整的脫敏文字（僅 CONFIRM；可能不存在） |

## 實務使用建議

### 場景一：你要把一個設定檔交給 OpenCode 分析

下面是 `mode: "block"` 的情況。在 v2 預設的 transparent 模式下，模型看到的是佔位符，工作會繼續進行。

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
npm run scan -- --dir ./my-project
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

## 敏感資訊預覽行為

掃描結果中所有敏感資訊的預覽一律顯示為 `****`，不論原始值長度為何，不保留任何前後綴字元。這樣可避免在日誌、CI 輸出或 Web UI 回應中洩漏部分機密內容。

## 多語系（i18n）

CLI 輸出語言由 `LEAKSHIELD_LANG` 環境變數控制。

| 值 | 語言 |
|----|------|
| `en`（預設） | 英文 |
| `zh-TW` 或 `zh` | 繁體中文 |

```bash
# 英文輸出（預設）
npm run scan -- --text "your content"

# 繁體中文輸出
LEAKSHIELD_LANG=zh-TW npm run scan -- --text "你的內容"
```

也可以寫進 shell profile 長期生效：

```bash
export LEAKSHIELD_LANG=zh-TW
```
