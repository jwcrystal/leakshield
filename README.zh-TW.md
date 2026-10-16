<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./icon.svg">
  <img alt="leakshield" src="./icon.svg" width="64">
</picture>

# leakshield

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
| CLI | `npm run scan -- --file ./path`（全域安裝或 `npm link` 後可用 `leakshield --file ./path`） | 明確的本機或 CI 掃描；不會把內容送到模型 |
| Web UI | `npm run web` | 在 `http://localhost:3000` 手動以瀏覽器掃描 |

## 目前狀態

**實驗性，尚未正式發佈。** 還沒發佈到 npm：請在本機建置（`npm ci && npm run build`），再讓 OpenCode 指向 `dist` 目錄。

- Transparent 模式已在 OpenCode v2.0.28 搭配本機替身 provider 驗證，並用真實 OpenAI 模型驗證過一次。它**不保證**敏感內容絕不會送到模型：建議的 hook-first 設定在 `--doctor` 顯示為 `PARTIAL`，hook 之後才加入的內容，以及被允許的工具外送（curl、遠端 MCP），都不在保護範圍內。
- 尚未驗證：OS keychain 持久化、真實 Anthropic provider、其他 provider 的長對話、長時間使用（[#26](https://github.com/jwcrystal/leakshield/issues/26)）。
- 第一個正式版本前，預設值仍可能調整（[#24](https://github.com/jwcrystal/leakshield/issues/24)、[#27](https://github.com/jwcrystal/leakshield/issues/27)），變更見 [CHANGELOG](CHANGELOG.md)。
- 驗證紀錄：[docs/evidence](docs/evidence/README.md)。漏洞請私下回報：[SECURITY.md](SECURITY.md)。授權：[MIT](LICENSE)。

---


## 🚀 新成員快速上手

- 3 分鐘 Onboarding：[`docs/ONBOARDING.zh-TW.md`](./docs/ONBOARDING.zh-TW.md)

---

## 偵測範圍

| 類型 | 說明 | 嚴重度 |
|------|------|--------|
| API Key | OpenAI、Anthropic、Google、AWS | 🔴 HIGH |
| Secret / Password | 通用密碼賦值、AWS Secret | 🔴 HIGH |
| Token | GitHub PAT、JWT、Bearer Token | 🔴 HIGH |
| DB 連線字串 | MongoDB、PostgreSQL、MySQL、Redis 等 | 🔴 HIGH |
| 台灣身份證字號 | 格式驗證 | 🔴 HIGH |
| 信用卡號 | 13–19 位數字，需通過 Luhn 檢查碼 | 🔴 HIGH |
| IBAN | 緊湊或四字一組格式，需通過 mod-97 檢查碼 | 🔴 HIGH |
| 公共 IPv4 位址 | 排除私有／回環／CGNAT／保留段 | 🟡 MEDIUM |
| Email 地址 | 所有 email 格式 | 🟡 MEDIUM |
| 台灣手機號碼 | **Opt-in** —— 預設關閉（`rule_overrides: { "phone-tw": true }` 開啟）；數字段是實測的誤報來源，關閉的代價是漏偵真電話 | 🟡 MEDIUM |
| 國際電話 | **Opt-in** —— 預設關閉（`rule_overrides: { "phone-intl": true }` 開啟）；取捨同上 | 🟢 LOW |
| HTTP(S) URL | **Opt-in** —— 預設關閉（`rule_overrides: { "url": true }` 開啟） | 🟢 LOW |
| NDA 關鍵字 | 自訂（見 config/guard.config.yaml） | 🔴 HIGH |
| 私有域名 | 自訂（見 config/guard.config.yaml） | 🟡 MEDIUM |

---

## 決策模型

每次掃描都會產生一個**決策**，告訴呼叫端該如何處理內容：

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

### JSON 輸出欄位

使用 `--format json` 時，輸出包含以下與決策相關的欄位：

| 欄位 | 說明 |
|------|------|
| `decision` | `ALLOW`、`WARN` 或 `CONFIRM` |
| `riskLevel` | `LOW`、`MEDIUM`、`HIGH` 或 `CRITICAL` |
| `recommendedAction` | `REVIEW` 或 `BLOCK`（僅 CONFIRM） |
| `findings` | 已清理的發現陣列（不含內部中繼資料） |
| `safePreview` | 遮罩摘錄（僅 CONFIRM） |
| `redactedContent` | 完整的脫敏文字（僅 CONFIRM） |

---

## 安裝

```bash
git clone https://github.com/jwcrystal/leakshield.git
cd leakshield
npm install
npm run build
```

尚未發佈到 npm，所以 `npx leakshield` 要等你全域安裝或 `npm link` 這份 build 後才能用，之後可直接使用
`leakshield`；在此 repository 內不用安裝，直接用 `npm run scan -- ...` 即可。

### npm scripts 速查

| 指令 | 說明 |
|------|------|
| `npm run build` | 先清除再編譯 TypeScript → `dist/` |
| `npm run clean` | 移除 `dist/` |
| `npm start` | 執行已 build 的 CLI（`node dist/cli.js --cli`） |
| `npm run dev` | CLI 模式（不需先 build） |
| `npm run scan` | CLI 掃描（不需先 build） |
| `npm run web` | 啟動本機 Web UI（不需先 build） |
| `npm test` | 執行單元測試 |
| `npm run test:watch` | 以 watch 模式執行測試 |
| `npm run binary` | 建置當前平台的獨立執行檔（macOS ARM） |
| `npm run binary:win` | 跨編譯 Windows x64 |
| `npm run binary:linux` | 跨編譯 Linux x64 |
| `npm run binary:mac-intel` | 跨編譯 macOS Intel |
| `npm run binary:win-icon` | 建置帶圖示的 Windows 執行檔（`scripts/build-win.js`） |
| `npm run binary:all` | 一次建置所有平台 |
| `npm run bundle:mac` | 建置執行檔並打包 macOS bundle（`scripts/bundle-mac.sh`） |

---

## 獨立執行檔

無法使用 Node.js 或 npm？用 [Bun](https://bun.sh) 建置成單一執行檔，目標機器不需任何 runtime。

```bash
# 一鍵建置當前平台
npm run binary

# 跨平台編譯
npm run binary:win     # Windows x64  → leakshield.exe
npm run binary:linux   # Linux x64    → leakshield-linux
npm run binary:all     # 全平台
```

或直接用 Bun：

```bash
bun build --compile --target=bun-windows-x64 ./src/cli.ts --outfile=leakshield.exe
```

產出單一執行檔，直接交給任何人，無任何相依套件。

### 自訂設定（binary 使用者）

執行檔內建預設值可直接使用。若要自訂規則（NDA 關鍵字、私有網域、自訂正則），將 `config/guard.config.yaml` 放在以下任一位置：

| 位置 | 範圍 |
|------|------|
| `./config/guard.config.yaml` | 當前工作目錄 |
| `~/.leakshield/guard.config.yaml` | 所有位置（家目錄） |

```bash
# 快速開始：把設定放到家目錄
mkdir -p ~/.leakshield
cp config/guard.config.yaml ~/.leakshield/

# 或依專案放置
mkdir -p ./config
# 編輯 ./config/guard.config.yaml
```

詳見[設定](#設定檔)章節。

---

## 使用方式

### CLI

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

Exit code：`0` = 安全，`1` = 有問題，`2` = 檔案不存在

#### 脫敏模式（Redaction）

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
      "package": "/絕對路徑/leakshield/dist",
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
      "file:///絕對路徑/leakshield/dist/opencode.js",
      { "mode": "block" }
    ]
  ]
}
```

`block` 是預設值，會用不含機敏值的攔截訊息替換危險內容。只有在你明確希望已辨識的直接命中改為 `[REDACTED_TYPE]` 佔位符時，才設定 `mode: "redact"`。

**僅限 OpenCode v2 — 透明假名化（transparent）：** 設定 `"mode": "transparent"` 後，偵測到的敏感值會在模型請求快照中替換為穩定的不透明佔位符——W1（2026-10-07）起為帶類別的 `[SGP2:<TYPE>-xxxx-xxxx-xxxx]`（仍辨識舊 `[SGP1:…]` 映射）。反查映射預設僅在行程記憶體、以 OpenCode session 為界；持久化 opt-in。已知佔位符在工具執行前及支援的助理顯示文字中還原。HTTP adapters 支援按路徑形狀判別的 Chat Completions、Anthropic Messages、Responses（含串流），另支援 native Responses-family WS；不依 provider 品牌設 allowlist。Hook-only 保護 content 快照，不設出站傳輸守門，也不為未知協定新增 adapter。失效或不安全的工具還原仍拒絕該次操作。本機歷史、日誌與檔案可能含原文——保護的是模型邊界，不是磁碟。

**純 hook-only／共用 wire 開關：** 新 transparent 安裝可使用 [hook-first 範本](config/opencode.hook-first.example.json)，明確設 `wireProtection: false`。保留 system/messages/options/tools 遮罩與工具安全還原；**不註冊出站 HTTP request、WS handshake/send 或 AI SDK admission hooks**，不檢查 transport metadata、不改 provider transport 設定。未知路線與 SDK 私有傳輸不會因 SG 傳輸門檻被擋。選擇性入站 HTTP／WS hooks 依同 session/kind/model 的成功準備還原支援的顯示文字；缺 hook 或還原失敗只保留 literal，不停用輸入保護。後續新增內容／附件可能未遮罩，`doctor` 仍顯示 `PARTIAL`。**Hook 內無法遮罩的輸入仍拒絕該次請求**，並附安全的 `[stage=prepare.mask reason=…]`；不是靜默放行原文。true 增加 final-wire 與傳輸守門；省略 wire 仍為 true，plugin 預設 mode 仍為 block。[本輪驗證](docs/evidence/2026-10-11-pure-hook-only-verification.md)。

**透明模式容量與生命週期：** guard 每次遮罩／還原操作使用輸入＋輸出合計 8 Mi UTF-16 units、100,000 個 value nodes 的有限預算，不再把 standalone core 的 1 Mi-unit 小預算套在整份歷史。HTTP body／WS frame 仍限 4 MiB；scanner `max_chars`、深度 32、mapping entry 與總記憶體預算仍檢查。每個 guard 最多保留 4,096 個 session，不用 LRU 任意丟棄仍可續用的 mapping。正式 V2 `session.deleted` 事件只回收該 session 的 RAM、回覆準備證明及 WS 緩衝；idle、完成或中斷不視為刪除。缺少／失敗的事件訂閱會保留 mapping 到 unload，因此不是無限期不限容量。刪除事件不抹除加密持久化資料，仍由 TTL／明確 `forget` 管理。[本地驗證與實機限制](docs/evidence/2026-10-14-transparent-capacity-verification.md)。

**AI SDK provider：** true 要求 SDK 使用 OpenCode 注入的 `options.fetch`，以 request-scoped HTTP hooks 提供歸屬與 wire 保護，不依 provider 品牌設 allowlist。Wrapper 檢查 HTTP／HTTPS、支援路徑；缺 fetch、accessor／proxy 或不可寫設定拒絕。false 不註冊 SDK wrapper，不要求 injected fetch，只保留 content/tool hooks 與可選入站還原。私有傳輸不在 final-wire 覆蓋內，也不保證被擋。Commandcode 的 Go／403 fallback `/alpha/generate` 在 false 不受 SG 傳輸守門，true 仍拒絕；沒有 legacy 回覆 adapter。參數、abort 與真實 provider 錯誤維持 host 行為。

Wire 模式的 wrapper 把自身拒絕表示為 **本地 HTTP 400 錯誤回覆**，附 `error.code: "leakshield_transport_refusal"` 與不含原值的 WARN；被拒請求不外送。Hook-only 沒有此 wrapper 或傳輸 admission。真正網路錯誤、abort 與 provider 回覆不改，也不捏造 provider 成功。Responses easy-input 可省略 `type: "message"`，不擅自補 type。

**兩種模式共用回覆降級：** SG 的歸屬、JSON／SSE／WS 還原或解析失敗會停止 SG 改寫，不再因此阻斷 host 回覆；不猜其他 session／model 的 mapping。SSE 以有界交易保留尚未送出的原始 events，失敗後按原順序釋出並接續原 bytes，不重送已發內容、不丟 held tails。Provider error event 立即傳遞，來源錯誤與 consumer cancel 仍生效。使用者可能看到 placeholder，壞掉的 provider 資料仍可能被 OpenCode 拒絕。WS 只能取代單一 frame，不能重播多 channel；限制見 [降級驗證](docs/evidence/2026-10-11-experience-first-verification.md)。工具防線不隨回覆降級解除。

**Native WebSocket（experimental）：** 支援 `/responses` 的 `ws:`／`wss:` 與 flat `response.create`，按協定形狀而非 OpenAI 品牌限制。出站共用 HTTP Responses masker；入站支援跨 frame 顯示文字還原，工具參數保留 token 給本機 tool gate，encrypted reasoning 與 continuation ID 不亂改。不同協定／extensions 不自動視為相容。Host 沒有 connection ID，狀態按 session、請求種類、模型，再按 response ID 與內容 channel 隔離；新 handshake／模型切換、HTTP fallback、拒絕 frame 與 dispose 清除舊狀態，terminal 清除緩衝，並限制 frame／channel／總緩衝大小。若 provider 缺最後一個文字 delta，保留並還原 `.done` 完整欄位、顯示固定警告，不擅自改成 delta；只讀 delta 的 consumer 可能顯示不完整。未知顯示 token 保持 literal，不因此中斷回答；不安全或未知寫入映射仍拒絕。原有 native OpenAI HTTP preference 為相容性保留，明確 WS 設定現在可走支援路線。這不是系統網路防火牆或所有 WS provider 的支援承諾。[驗證與限制](docs/evidence/2026-10-11-responses-ws-verification.md)。

**選擇性映射持久化（W2，2026-10-07）：** transparent 模式設定 `"persistence": { "enabled": true }` 後，已保存映射以 per-entry AES-256-GCM（AAD 綁 session＋token）加密持久於 SQLite（預設 `~/.local/share/leakshield/SGP.db`），session 首次觸及時水合，供跨重啟還原。需要 Node.js 22.13 以上（內建 `node:sqlite`）；較舊的 runtime 無法開啟 store，映射維持僅在記憶體並記錄 WARN。選項：`ttlDays`（預設 7；0＝僅手動清除）、`path`（儲存位置）、`keyFile`/`keyfilePath`（無 OS keychain 環境的較弱降級）。金鑰走 OS keychain（macOS Keychain／Windows DPAPI／Linux libsecret）→ 明確啟用的 keyfile → 記憶體降級。Runtime log 在成功開啟 store 時記錄 `persistence: active; key=os-keychain|keyfile`，後續降級另有 WARN；缺金鑰不直接拒絕對話，但未保存的舊 token 仍可能被工具防線拒絕。`--doctor` 只查設定／DB 可讀性，標示 **尚未驗證 runtime 啟用與解密**，不碰真實 keychain。TTL 在 writer 開啟 store 時清理，非定時刪除；保存變動映射會延長期限，單純讀取不延長，7 天不是嚴格刪除期限。啟用不能找回先前已遺失的映射。主動清除：`leakshield --forget --all`（或 `--session <id>`）刪除持久映射，輸出僅計數。擦除為邏輯層＋檔內盡力（`secure_delete` 清零釋放頁、`forget --all` 另做 VACUUM 與 WAL 截斷）；實體媒體與備份殘留（SSD wear-leveling、快照、還原）不在保證範圍。開啟後若切換金鑰來源（keychain↔keyfile），store 會拒開並降級 memory-only，直到 `forget --all` 重置——不靜默換 key。

**持久化風險須知（開啟前必讀）：** 設計為雙秘密——單獨拿到 DB 檔或金鑰都解不開，兩者同時才行。備份（Time Machine、雲端同步）會複製 `SGP.db`：`forget` 無法回收備份已抄走的內容，還原備份＋尚存的金鑰可再識別舊 session——備份保留政策請一併考量。keychain 防**離線竊取**（偷磁碟、偷備份、複製 `SGP.db`）；不防已在你登入 session 內執行的惡意程式。keyfile 選項把門檻降為「同目錄樹的兩個檔案」，僅建議無 keychain 服務的伺服器/無頭環境使用。

**僅限 OpenCode v2 — Email 去識別化試驗：** 選擇性開啟的 `deidentify` 選項（必須搭配 `mode: "redact"`）會將重複出現的 MEDIUM 等級 email 命中改為穩定且不透明的 `[SG-EMAIL-…]` 佔位符，讓 agent 能關聯多筆記錄而不會看到原始地址。對應金鑰在每次 plugin setup（即一個 OpenCode session）產生一次、僅存在記憶體、永不持久化——佔位符在同一個 live session 內穩定，重新啟動後即改變，且不存在反查映射。其他行為維持不變：HIGH 憑證仍會被脫敏或攔截，截斷、編碼或無法驗證的內容會攔截整個單元。

```jsonc
{ "package": "/絕對路徑/leakshield/dist", "options": { "mode": "redact", "deidentify": true } }
```

**選擇性開啟的唯讀 env 查詢（兩個版本皆支援）：** `envQueries` 選項（預設 `false`）針對 `settings.env_files` 所列檔案提供三個唯讀工具，讓 agent 能回答設定問題而不看到任何 value：

| 工具 | 契約 |
|---|---|
| `guard_env_list` | 回傳不透明、僅限當前 session 的 file id 與 key 名稱——永遠不含路徑、value、長度或預覽。 |
| `guard_env_inspect(file_id, key)` | 回傳 `missing` \| `empty` \| `nonempty`；非空時再給粗略詞彙形態 `boolean_like` \| `number_like` \| `multiline_text` \| `text`。形態只是提示，不代表該值是有效的布林或數字。 |
| `guard_env_compare(left_file_id, left_key, right_file_id, right_key)` | key 對 key（同檔或跨檔）相等性比較，回傳 `equal` \| `different` \| `unavailable`。缺少的 key 或無法讀取的檔案回 `unavailable`。 |

```jsonc
{ "package": "/絕對路徑/leakshield/dist", "options": { "mode": "block", "envQueries": true } }
```

基本規則：只有 `settings.env_files` 內的檔案可查（最多 16 個、各 1 MiB）。file id 只在列出它的 session 有效。每次呼叫都重新讀檔，比較的兩個運算元取自同一份單次呼叫快照。任何輸出都不會出現原始 value、value 長度、預覽、指紋或反查映射。若 setup 後 guard 設定檔變更，工具會回傳固定的「請重啟」錯誤直到 OpenCode 重啟——絕不悄悄退回新舊任一份授權。

檔案存取採「盡力而為的路徑身分驗證」，不是 sandbox。Workspace root 在 setup 時凍結（解析後的路徑加上 device/inode 身分）；每次查詢都會在開檔前與讀取後重新 lstat root 與每個祖先目錄、拒絕任何路徑元件上的 symlink（包括解析到別處——即使仍在 workspace 內——的祖先目錄 symlink）、要求一般檔案、以 `O_NOFOLLOW` 與 `O_NONBLOCK` 開啟完整解析後的 canonical 路徑，並以讀取前後的 size/mtime 檢查把開啟的 descriptor 綁定到 lstat 過的 inode。限制（據實以告）：同一擁有者的惡意並發檔案系統變動不在本威脅模型內——在兩次檢查之間替換又還原（ABA 競態，發生在 root、祖先目錄或檔案上）無法靠路徑檢查偵測；hardlink 與原始檔案不做區分（不檢查出處）；保留 size 與 mtime 的就地覆寫無法分辨；且 agent 仍可透過其他工具修改 env 檔案——因此結果描述的是檔案當下狀態，而非可信任的基準。key 名稱本身照原樣回傳，並照常通過既有的輸出／歷史保護。OpenCode v1 上這些工具透過標準 v1 tool API（`@opencode-ai/plugin`，由 v1 host 提供）註冊。

附件：transparent 模式支援 `attachments` 政策，動作為 DLP 標準命名。**`"block"`（預設）** 會略過 media／file parts——以通知文字取代，二進位永不離開本機，對話照常繼續（模型讀不到圖片）。**`"allow"`** 會將附件未掃描送出並附加一則可見通知——這是明確的設定層決定，代表你為圖片內容作保（`"allow"` 需搭配 `mode: "transparent"`）。三家參考產品都直接放行附件且無選項。block／redact 模式下附件照舊攔截。既有 session 可能已存有原文，安裝 plugin 後請建立新 session。此 plugin 僅保護 OpenCode 發出的模型請求，不涵蓋其他 AI client 或本機工具。

OpenCode 目前會記錄並跳過在 plugin factory 執行前就載入失敗的模組，例如套件缺失或 JavaScript 語法錯誤。安裝或升級後，請先用 `sk-` 加至少 20 個英數字元的合成測試 key 執行 smoke test，確認訊息已被 LeakShield 替換，再處理真實機敏資料。

**Shell 參數還原：** macOS／Linux 的 POSIX shell 支援占位符作為完整的未加引號、單引號或雙引號參數；保留原引號，並檢查原值不會破壞該引號語境，含空格的原值仍是一個參數。支援單一、結尾的 `>`／`>>`，目標須為靜態字面檔名。命令／變數賦值位置、帶 token 的重新導向檔名、展開、引號拼接、管線、inline script、會跳出引號或以 `-` 起始的原值，仍在修改參數前拒絕該次工具呼叫。不含 token 的命令不受影響。Windows 不啟用新增的引號／重新導向支援；這不是通用 shell parser。`wireProtection` 的兩種設定不會改變此工具防線。

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

模型可見的訊息必須包含 LeakShield 的攔截通知，且不可包含該合成 token。不要用真實憑證執行此測試。

發布到 npm 後，可用 `"leakshield"` 取代上述本機 `dist` 路徑。

#### 自動安裝檢查：`--doctor`

```bash
leakshield --doctor     # 全域安裝或 npm link 後；在 repo 內可用 npm run scan -- --doctor
```

Doctor 不會把任何內容送出去。它會檢查 OpenCode host 版本、尋找 `opencode.json`（先 workspace 再全域）、確認 LeakShield 已用 plugin 本身接受的選項註冊、確認本機 `dist` 進入點真的存在（缺少時 OpenCode 會靜默記錄並跳過 plugin：session 看起來正常但沒有保護）、載入 guard 設定，並在本機跑合成 canary 的 smoke scan。Exit code 0 代表 `PROTECTED`（v2）或 `PARTIAL`（v1：僅 session hooks）；其他狀態會印出失敗的檢查項與具體修正方式，plugin 未註冊時還會附上可直接複製的註冊片段。

Doctor 是在 host 之外執行的安裝層檢查，看不到執行中的 session。執行期的證明來自上面的 smoke test 或 `scripts/e2e/run-boundary.mjs`。

### 保護範圍與不保護的部分

LeakShield 保護送往模型的對話內容：prompt、重播的歷史、工具輸出，以及（transparent 模式下）可解析其結構的 provider 請求 body。它**不是**工具對外連線的防火牆：被允許的本機工具仍可透過 `curl`、遠端 MCP server 或任何其他管道把原文傳出去。要管控工具的目的地，需要此 plugin 之外的權限層。

偵測也有已知缺口：街道／郵遞地址、日期、IPv6，以及關鍵字清單之外或短於 8 字元的一般賦值都不會被偵測。信用卡與 IBAN 只有在檢查碼驗證通過時才會命中；IP 偵測只涵蓋公開 IPv4；URL 偵測存在但需手動開啟，見[偵測範圍](#偵測範圍)。

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
