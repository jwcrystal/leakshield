# 外掛比較測試

在真實 OpenCode host 上，用同一組情境比較 baseline（無插件）、Sensitive Guard、官方 `@rehydra/opencode` 與 EightDoor `opencode-rehydar`。模型端是本機 loopback 替身，資料全為合成值，**不需要任何憑證，也不會呼叫真實模型**。每個案例使用獨立的 HOME／XDG，不讀寫你的 OpenCode 設定。

| 腳本 | 內容 |
|---|---|
| `chat.mjs` | Chat Completions，11 情境：一般對話、含敏感值對話、回覆還原、工具讀／寫／shell 還原、system 內容、重啟後續聊與沿用舊 token |
| `responses.mjs` | native OpenAI Responses，HTTP／明確 WebSocket／host 預設 transport 各一案 |
| `common.mjs` | 共用：前置檢查、隔離環境、各 suite 的 plugin 設定 |

## 執行

先建置 SG 並確認 host 可用：

```bash
npm run build
opencode --version        # 或 export OPENCODE_BIN=/path/to/opencode
```

只比 baseline 與 SG（不需任何第三方套件）：

```bash
node scripts/e2e/compare/chat.mjs
node scripts/e2e/compare/responses.mjs
```

加入官方與 EightDoor：套件不隨 repo 附帶，安裝到私有目錄並固定版本（不執行安裝腳本），再指定路徑：

```bash
DIR="$(mktemp -d)"
npm install --prefix "$DIR/official"  --ignore-scripts @rehydra/opencode@0.14.0
npm install --prefix "$DIR/eightdoor" --ignore-scripts opencode-rehydar@0.14.3
export E2E_REHYDRA_PACKAGE="$DIR/official/node_modules/@rehydra/opencode"
export E2E_EIGHTDOOR_PACKAGE="$DIR/eightdoor/node_modules/opencode-rehydar"
node scripts/e2e/compare/chat.mjs
node scripts/e2e/compare/responses.mjs
```

## 選項與環境變數

- `--suite=a,b`：`baseline`、`sg-hook`、`sg-wire`、`sg-persist-test`、`official`、`eightdoor`、`eightdoor-default`。未指定時跑 baseline、`sg-hook`、`sg-wire`，並在設了對應環境變數時加入 `official`、`eightdoor`。
- `--case=x,y`（`chat.mjs`）、`--transport=http,websocket,default`（`responses.mjs`）：只跑部分情境。
- `--assert`：除 baseline 外，任何外送、對話或操作不如預期就 exit 1。**官方版會外送，不要把 `official` 放進 `--assert`。**預設（持久化關閉）的 `sg-hook`／`sg-wire` 會在 `restart-write` 失敗（見下），所以整組 `--assert` 只適合 `sg-persist-test`，或用 `--case` 排除該情境。
- `OPENCODE_BIN`、`E2E_SG_DIST`（預設 repo 的 `dist/`）、`E2E_REHYDRA_PACKAGE`、`E2E_EIGHTDOOR_PACKAGE`、`E2E_WORK_ROOT`（證據輸出的父目錄，預設 `$TMPDIR/opencode`）。
- 前置條件不成立（找不到 host、沒建置、缺第三方套件）時，直接以 exit 2 結束並說明，不會跑出一整排無意義的 FAIL。

## 怎麼看結果

- `leaks`：Chat 是「請求 × 合成值種類」命中數；Responses 是含原值的請求數（標題與主請求各一筆，未保護時為 2）。
- `operation=FAIL` 不一定是插件的錯：官方版在 OpenCode V2 載入失敗，沒有產生 token，還原類情境無從驗證。
- `sg-restart-write` 在預設（持久化關閉）下失敗是設計：重啟後模型沿用舊 token 寫檔，SG 拒絕該工具並讓對話繼續。`sg-persist-test` 開啟持久化後該情境通過。
- `sg-persist-test` 使用測試專用的記憶體金鑰，**不驗證真實 Keychain**。

輸出（captures、stdout、stderr、`summary.json`）寫在 `E2E_WORK_ROOT` 下的 `sg-compare-*` 目錄，是暫存資料，可能被系統清除。
