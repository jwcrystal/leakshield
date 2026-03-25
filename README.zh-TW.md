# 🛡️ sensitive-guard

> 🌐 [English](./README.md) | 繁體中文

**在把程式碼、文件、資料丟給 AI 服務之前，先掃描敏感內容的守門員。**

支援三種使用模式：
- **MCP Server**：整合進 OpenCode / Claude Code，AI 讀檔前自動觸發守門
- **CLI**：手動掃描指定文字、檔案或目錄
- **Web UI**：瀏覽器介面，貼上內容即可掃描；同時提供 REST API

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
git clone <此 repo>
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

### 三、MCP Server 模式（整合進 OpenCode / Claude Code）

#### 步驟 1：Build

```bash
npm run build
```

#### 步驟 2：設定 OpenCode

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

#### 步驟 3：在 OpenCode System Prompt 中加入守門規則

在你的 OpenCode system prompt 加入以下指令，讓 AI 在讀取任何檔案或處理你貼上的程式碼前，先呼叫掃描工具：

```
在你讀取任何本機檔案、或我提供任何程式碼 / 設定檔 / 資料之前，
請先呼叫 sensitive-guard 的 scan_file 或 scan_text 工具。
如果掃描結果的 safe 欄位為 false，請立即停止並告訴我哪些內容有問題，
等待我確認後再繼續。不要自動修改或繼續處理敏感內容。
```

#### MCP 工具列表

| 工具 | 用途 |
|------|------|
| `scan_text` | 掃描一段文字（你貼進去的 code / 資料） |
| `scan_file` | 掃描本機單一檔案 |
| `scan_dir` | 掃描整個目錄（遞迴，跳過 node_modules / .git） |
| `reload_config` | 修改 YAML 後重新載入，不用重啟 server |

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

## 注意事項

- 這個工具是**靜態 pattern 掃描**，無法保證 100% 覆蓋所有情況
- **高誤報情境**：測試用的假 key（如 `sk-test123456`）、範例程式碼中的佔位符，可能被誤判為真實 key
- 最終判斷仍需你自己確認，工具的作用是「提醒」而非「保證」
- NDA 關鍵字請只填真正機密的詞，避免太多誤報影響使用體驗
