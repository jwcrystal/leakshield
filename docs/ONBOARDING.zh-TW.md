# leakshield 新成員 3 分鐘 Onboarding

> 目標：讓新成員在 3 分鐘內理解這個專案能做什麼、怎麼跑、何時用。
> 專案目前是**實驗性、尚未正式發佈**（未上 npm），細節與限制以 [README.zh-TW.md](../README.zh-TW.md) 的「目前狀態」為準。

## 0) 你會得到什麼

在內容送到 AI 模型之前，攔截或遮罩敏感資訊（API Key、Token、密碼、PII、DB 連線字串、`.env` 內的值等）。

三種模式：

| 模式 | 用在哪 | 特性 |
|------|--------|------|
| **OpenCode Plugin**（主力） | 日常用 OpenCode 時 | 自動、fail-closed，在 prompt、歷史、工具輸出送出前處理 |
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

## 2) 60 秒接上 OpenCode Plugin（主力）

1. 先 `npm run build`。
2. 在 `opencode.json` 的 plugin 設定加入 build 後的 `dist` 目錄（OpenCode v2）或 `dist/opencode.js`（v1）。建議的 hook-first 設定範本：[`config/opencode.hook-first.example.json`](../config/opencode.hook-first.example.json)。
3. 跑安裝檢查：

```bash
npm run scan -- --doctor
```

- `PROTECTED`：完整保護（v2）。
- `PARTIAL`：僅部分保護（v1 只有 session hooks；hook-first 設定也會顯示 `PARTIAL`）。
- 其他狀態：會印出失敗的檢查項與修正方式。

> `--doctor` 只檢查安裝，看不到執行中的 session。要確認真的有擋，請照 README 的 smoke test，用 `sk-` 加 20 個英數字的**合成 key** 測，不要用真實憑證。

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

改 `config/guard.config.yaml` 的 `nda_keywords`、`private_domains`、`custom_rules`。CLI 下次執行自動讀新設定；OpenCode plugin 要重啟 OpenCode 才會套用。

### Q4. 想讓 `.env` 裡的值完全不進模型？

在 `config/guard.config.yaml` 設 `settings.env_files`，Guard 會偵測這些檔案中的值是否原樣出現在要送出的內容。改完要重啟 OpenCode。

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

# 5) 若要接 OpenCode：註冊 plugin 後檢查
npm run scan -- --doctor
```

接著讀：[README.zh-TW.md](../README.zh-TW.md)（完整功能與限制）、[CONTRIBUTING.md](../CONTRIBUTING.md)（提交前必跑的檢查）、[docs/evidence](./evidence/README.md)（驗證紀錄）。

如果你只記得一件事：

> **Plugin 負責自動擋；手動貼內容給 AI 前，先跑一次 scan。**
