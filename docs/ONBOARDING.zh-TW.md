# sensitive-guard 新成員 3 分鐘 Onboarding

> 目標：讓新成員在 3 分鐘內理解這個專案能做什麼、怎麼跑、何時用。

## 0) 你會得到什麼

- 在把程式碼或資料送去 AI 前，先掃描敏感資訊（API Key、Token、密碼、PII、DB 連線字串等）。
- 三種常用模式：
  - **CLI**（本機 / CI 最常用）
  - **Web UI**（快速手動貼文掃描）
  - **MCP Server**（讓 AI agent 讀檔前自動先掃）

---

## 1) 30 秒安裝與啟動

```bash
git clone https://github.com/jwcrystal/sensitive-guard.git
cd sensitive-guard
npm install
npm run build
```

常用腳本：

```bash
npm run dev    # 啟動 TypeScript 版本（預設 MCP 模式）
npm run scan   # 直接進 CLI 掃描模式
npm test       # 跑單元測試
```

---

## 2) 60 秒學會 CLI（最重要）

### 情境 A：你要把一段設定貼給 AI 前先檢查

```bash
npm run scan -- --text 'OPENAI_KEY=sk-xxxx password="supersecret"'
```

- `exit 0`：沒問題
- `exit 1`：有命中
- `exit 2`：路徑不存在等使用錯誤

### 情境 B：掃描整個專案（例：送 PR 前）

```bash
npm run scan -- --dir ./src
```

只掃特定副檔名：

```bash
npm run scan -- --dir ./src --ext .ts .env .json
```

### 情境 C：你要「可安全分享」版本（脫敏）

```bash
# 從 stdin 脫敏
cat .env | npm run scan -- --redact --stdin

# 檔案脫敏後輸出到新檔
npm run scan -- --redact --file .env --out .env.redacted

# 只預覽會命中哪些，不輸出內容
npm run scan -- --redact --dry-run --file .env
```

---

## 3) 30 秒學會 Web UI

```bash
npx tsx src/cli.ts --web --port 3001
```

打開 `http://localhost:3001`，貼上文字後按「掃描」。

也可走 API：

```bash
curl -s -X POST http://localhost:3001/scan \
  -H 'Content-Type: application/json' \
  -d '{"content":"token=sk-proj-abc123"}'
```

---

## 4) 60 秒接到 AI 工作流（MCP）

1. 先 build：

```bash
npm run build
```

2. 在 OpenCode/Claude Code 設定 MCP server，指向 `dist/cli.js`（請用絕對路徑）。
3. 在 system prompt/CLAUDE.md 寫規則：
   - 讀任何檔案前先 `scan_file` 或 `scan_text`
   - 若 `safe=false`，停止並先回報

---

## 5) 常見情境速查

### Q1. 我只想在 CI 報 HIGH 風險

```bash
npm run scan -- --dir . --min-severity high --format json
```

### Q2. 為什麼掃描 `../xxx` 會失敗？

預設禁止掃描工作目錄外路徑，避免誤掃主機敏感檔。若確定需要：

```bash
npm run scan -- --file ../shared.env --allow-outside
```

### Q3. 公司內部詞彙沒被抓到？

去改 `config/guard.config.yaml` 的：
- `nda_keywords`
- `private_domains`
- `custom_rules`

改完後：
- CLI 下次執行自動讀新設定
- MCP 可呼叫 `reload_config`

---

## 6) 新成員第一天建議流程（可直接照做）

```bash
# 1) 安裝
npm install

# 2) 先跑測試確保環境正常
npm test

# 3) 掃你的專案目錄
npm run scan -- --dir . --ext .ts .js .env .json

# 4) 有命中就先脫敏再分享
npm run scan -- --redact --file .env --out .env.redacted
```

如果你只記得一件事：

> **任何內容送給 AI 前，先跑一次 scan。**
