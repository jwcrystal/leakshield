# leakshield 新成員 3 分鐘 Onboarding

> 目標：讓新成員在 3 分鐘內理解這個專案能做什麼、怎麼跑、何時用。
> 專案目前是**實驗性的 `0.x` 版本**，已發佈到 npm（`leakshield`）。細節與限制以 [README.zh-TW.md](../README.zh-TW.md) 的「目前狀態」為準。

## 0) 你會得到什麼

在內容送到 AI 模型之前，攔截或遮罩敏感資訊（API Key、Token、密碼、PII、DB 連線字串、`.env` 內的值等）。

五種入口，共用同一套掃描器：

| 入口 | 用在哪 | 特性 |
|------|--------|------|
| **OpenCode plugin** | 日常用 OpenCode v2 時 | 自動、fail-closed，在 prompt、歷史、工具輸出送出前處理；涵蓋最完整 |
| **pi extension** | 日常用 pi 時 | 行程內包住 `fetch`，遮罩 provider 請求，並在本機還原 read/write/edit/bash 參數 |
| **Claude Code proxy**（實驗性） | 日常用 Claude Code 時 | 本機 proxy，遮罩 Messages 請求並還原助理文字；工具參數尚未還原 |
| **CLI** | 本機 / CI 明確掃描 | 不會把內容送給任何模型 |
| **Web UI** | 手動貼文掃描 | 本機瀏覽器操作 |

> MCP server 模式已移除：它靠模型自己「記得」呼叫掃描工具，而此時內容早已進了模型上下文，無法形成安全邊界。

---

## 1) 30 秒安裝

```bash
git clone https://github.com/jwcrystal/leakshield.git
cd leakshield
npm install
npm run build
```

常用腳本：

```bash
npm run scan -- --text '...'   # CLI 掃描（不需先 build）
npm run web                    # 本機 Web UI（不需先 build）
npm test                       # 單元測試
npx tsc --noEmit               # 型別檢查
```

> 想測本機改動時，用 repo 內的 `npm run scan -- ...`（或全域安裝 / `npm link` 這份 build）；直接用 `npx leakshield` 會抓到 npm 上的已發佈版本，不是你正在改的程式碼。

---

## 2) 60 秒接上你用的宿主

選你日常用的那一個就好。以下用 repo 內的 build；用已發佈版本時，把 `npm run scan --` 換成全域安裝後的 `leakshield`。

### OpenCode plugin

1. 先 `npm run build`。
2. 在 `opencode.json` 的 plugin 設定加入 build 後的 `dist` 目錄（僅支援 OpenCode v2）。建議的 hook-first 設定範本：[`config/opencode.hook-first.example.json`](../config/opencode.hook-first.example.json)。
3. 跑安裝檢查：

```bash
npm run scan -- --doctor
```

- `PROTECTED`：完整保護（v2）。
- `PARTIAL`：僅部分保護（hook-first 設定會顯示 `PARTIAL`）。
- 其他狀態：會印出失敗的檢查項與修正方式。

### pi extension

```bash
pi install "$PWD"              # 註冊本機 build；已發佈版本用 pi install npm:leakshield
node dist/cli.js --doctor pi   # 套件安裝會顯示 PARTIAL（載入順序無法驗證）
```

需要 pi 1.6 與 Node.js 22.19 以上。細節見 [pi adapter](pi.zh-TW.md)。

### Claude Code proxy（實驗性）

```bash
node dist/cli.js --claude-code-proxy             # 另開一個終端，保持執行
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787  # 在啟動 Claude Code 的 shell
node dist/cli.js --doctor claude-code
```

工具呼叫參數尚未還原，繞過 base URL 的流量也不在範圍內，見 [Claude Code](claude-code.zh-TW.md)。

> `--doctor` 只檢查安裝，看不到執行中的 session。要確認真的有擋，請用 `sk-` 加 20 個英數字的**合成 key** 測（OpenCode 可照 [OpenCode plugin](opencode.zh-TW.md#隔離-smoke-testopencode-v2) 的 smoke test），不要用真實憑證。

**它不保護什麼：** 它保護的是送往模型的對話內容，不是工具對外連線的防火牆；被允許的工具（`curl`、遠端 MCP）仍可能把原文傳出去。

---

## 3) 60 秒學會 CLI

### 情境 A：貼設定給 AI 前先檢查

```bash
npm run scan -- --text 'OPENAI_KEY=sk-xxxx password="supersecret"'
```

- `exit 0`：沒問題（`ALLOW`）
- `exit 1`：有命中（`WARN` 或 `CONFIRM`）
- `exit 2`：路徑不存在等使用錯誤

### 情境 B：掃描整個專案

```bash
npm run scan -- --dir ./src
npm run scan -- --dir ./src --ext .ts .env .json   # 只掃特定副檔名
```

### 情境 C：產生可安全分享的脫敏版本

```bash
cat .env | npm run scan -- --redact --stdin
npm run scan -- --redact --file .env --out .env.redacted
npm run scan -- --redact --dry-run --file .env     # 只預覽命中，不輸出內容
```

### 決策怎麼看

| 決策 | 意義 |
|------|------|
| `ALLOW` | 乾淨 |
| `WARN` | 只有低嚴重度，提醒即可 |
| `CONFIRM` | 有中／高嚴重度；CLI 為非互動，只印警示卡並 exit 1，可用 `--format json` 取 `redactedContent` 或加 `--redact` 取得脫敏版 |

`--format json` 可取得 `decision`、`riskLevel`、`findings` 等欄位，完整說明見 README「決策模型」。

---

## 4) 30 秒學會 Web UI

```bash
npm run web -- --port 3001
```

打開 `http://localhost:3001`，貼上文字後按「掃描」。也可走 API：

```bash
curl -s -X POST http://localhost:3001/scan \
  -H 'Content-Type: application/json' \
  -d '{"content":"token=sk-proj-abc123"}'
```

---

## 5) 常見情境速查

### Q1. CI 只想在 HIGH 風險時失敗

```bash
npm run scan -- --dir . --min-severity high --format json
```

### Q2. 為什麼掃描 `../xxx` 會失敗？

預設禁止掃描工作目錄外的路徑，避免誤掃主機敏感檔。確定需要時：

```bash
npm run scan -- --file ../shared.env --allow-outside
```

### Q3. 公司內部詞彙沒被抓到？

在設定檔加 `nda_keywords`（預設只有 `CONFIDENTIAL`、`INTERNAL ONLY`、`DO NOT SHARE`、`NDA`）、`private_domains`（預設是空的）或 `custom_rules`。設定檔依序找 `./config/guard.config.yaml`、`~/.leakshield/guard.config.yaml`；pi 可以用 `LEAKSHIELD_CONFIG`、Claude Code proxy 可以用 `--config` 指定。CLI 下次執行就會讀到新設定；OpenCode、pi、Claude Code proxy 和 Web UI 要重啟才會套用。

### Q4. 想讓 `.env` 裡的值完全不進模型？

在設定檔（位置同 Q3）設 `settings.env_files`，Guard 會偵測這些檔案中的值是否原樣出現在要送出的內容。CLI 下次執行就會套用；OpenCode、pi、Claude Code proxy 和 Web UI 要重啟。

---

## 6) 新成員第一天建議流程

```bash
# 1) 安裝與建置
npm install && npm run build

# 2) 確認環境正常
npm test

# 3) 掃自己的專案
npm run scan -- --dir . --ext .ts .js .env .json

# 4) 有命中就先脫敏再分享
npm run scan -- --redact --file .env --out .env.redacted

# 5) 接上宿主後檢查（opencode / pi / claude-code）
npm run scan -- --doctor opencode
```

接著讀：[README.zh-TW.md](../README.zh-TW.md)（完整功能與限制）、[CONTRIBUTING.md](../CONTRIBUTING.md)（提交前必跑的檢查）、[docs/evidence](./evidence/README.md)（驗證紀錄）。

如果你只記得一件事：

> **宿主整合（plugin／extension／proxy）負責自動擋；手動貼內容給 AI 前，先跑一次 scan。**
