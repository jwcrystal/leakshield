# AI SDK HTTP 相容性修正與驗證

日期：2026-10-11。

## 結論

**已驗證：SG 不再因 provider 使用 AI SDK 就全面拒絕初始化。** 使用 OpenCode 注入 HTTP fetch 的 SDK 共用現有 request／response hooks。品牌不影響 admission。

**已驗證：OpenAI SDK Responses、Anthropic SDK Messages、commandcode 標準 Chat Completions 的工具迴路成功。** 兩種 wire 設定均完成本地寫入、讀取、quoted shell 與跨 delta 回覆還原。模型捕獲沒有合成原值。

**限制：commandcode Go／legacy `/alpha/generate` 仍不支援。** 修正後會明確拒絕，不外送，且本次 host 驗證沒有再次逾時重試。這是拒絕行為成功，不是 Go 對話成功。

本文用結果表區分成功對話、預期拒絕與尚未驗證事項。它不宣稱所有 SDK 或真實帳號均可用。

## 已驗證：三個問題與修正

| 問題 | Red 證據 | 修正 |
|---|---|---|
| SDK 初始化全面拒絕 | 新公開 hook 測試在 true／false 都失敗於 `[hook=aisdk.sdk]` | `sdk`／`language` hooks 接納可寫的 injected fetch，保留 host SDK／language 選擇，不設品牌 allowlist |
| Responses easy-input 被誤判未知 item | 實際 OpenAI SDK final-wire 無模型請求；重播 hook-first capture 得 `[responses-item-type]`；新的 easy-input 測試先失敗 | 接受缺 `type` 但有已知 role＋受支援 content 的 message；不替 body 插入 type；未知 role/type、缺 content 或未知 parts 仍拒絕 |
| Guard 拒絕被當成網路故障重試 | commandcode Go 的實際 host 測試兩種 wire 都無外送，但直到 60 秒逾時；本地 HTTP 400 regression 先失敗 | admission wrapper 回傳本地 status 400 的錯誤 Response，固定 code＋content-free WARN；不偽造成功、不轉交未知路線到 underlying fetch |

SDK 呼叫仍由 host 管理認證、abort、真正的網路重試與 stream lifetime。Wrapper 保留呼叫參數與 receiver。SDK cache 可以保留 earlier options；language hook 也會接納新 host options。Dispose 使舊 wrapper 回傳本地拒絕，不繼續外送。

缺 fetch、fetch accessor、proxy 或首次無法替換的非 writable fetch 仍拒絕初始化。初始化 hook 錯誤含固定 hook 名稱，不帶 package、URL、金鑰或原值。Fetch refusal body 固定為 error envelope，code 為 `sensitive_guard_transport_refusal`，header 為 `x-sensitive-guard-refusal: 1`。同一 guard 同類 WARN 只記一次。

**Wire 政策未改。** true 在 HTTP hooks 驗證／再遮罩最終 body。false 不掃最終 body，仍做 route／metadata admission、session attribution 與回覆還原。False 的 late-added 內容仍可能未遮罩。

## 已驗證：公開邊界與完整工作樹

`tests/opencode-transparent-aisdk.test.ts` 有 19 個案例。它們覆蓋 arbitrary SDK label、兩種 wire 設定、SDK／language 初始化、Responses easy-input、未知內容拒絕、標準 HTTP 往返還原、metadata、Request／URL／signal／receiver 保留、SDK cache、dispose、本地 HTTP 400 與真實錯誤不被誤分類。

此 suite 的模擬 host fetch 是公開 HTTP hooks 的合成 pipeline。下方實際 host 測試另外驗證 OpenCode 是否真的執行該 pipeline；兩者不可互相冒充。

完整原倉庫工作樹：**40 files／863 tests passed**。`npm run build` 與 `git diff --check` 成功。這包括使用者原有未提交工作，不是乾淨 HEAD 的結果。

## 已驗證：實際 OpenCode＋本地模型替身

Host：OpenCode v2.0.25，`/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode`。SDKs 在唯一外部測試目錄以 `npm install --ignore-scripts` 安裝。原倉庫 package.json／lockfile 不變。

| 套件／路線 | Wire=false | Wire=true | 實際能力 |
|---|---|---|---|
| `@ai-sdk/openai@3.0.125`／Responses | PASS | PASS | 每案四輪主請求，write/read/shell，顯示還原，原值外送 0 |
| `@ai-sdk/anthropic@3.0.129`／Messages | PASS | PASS | 每案四輪主請求，write/read/shell，顯示還原，原值外送 0 |
| `opencode-cmd-provider@2.2.6`／Chat Completions | PASS | PASS | 每案四輪主請求，patch/read/shell，顯示還原，原值外送 0 |
| commandcode `plan=go`／legacy | 預期拒絕 PASS | 預期拒絕 PASS | 零 provider capture、零未知路線請求、無工具檔案、明確 guard 錯誤、未逾時；沒有成功對話 |
| Native OpenAI HTTP／Responses | PASS | PASS | 既有工具流程不回歸，原值外送 0 |
| Native OpenAI WS／Responses | PASS | PASS | 每案四輪主請求共用一條 WS，工具與顯示還原，原值外送 0 |

正向驗收共 **10 案成功**，負向驗收另 **2 案預期拒絕**。不要把它們合寫成 12 案正常對話成功。

資料根目錄為 `$TMPDIR/opencode/`。最新各組證據：

| 測試 | 子目錄（每組含 summary.json、captures、stdout、stderr） |
|---|---|
| OpenAI SDK | `sg-ws-tools-aty6Dc/` |
| Anthropic SDK | `sg-ws-tools-S1JncX/` |
| commandcode 標準 | `sg-ws-tools-Lwp1nB/` |
| commandcode Go 拒絕 | `sg-ws-tools-HRtmL0/` |
| native HTTP／WS 回歸 | `sg-ws-tools-wn8LPA/` |

上述 SDK 測試使用本地 `aisdk:<absolute-package-directory>`，不是 native provider 假扮 SDK。透過 SDK factory 載入原發布套件，未改 SDK 源碼。認證與 prompt／AGENTS.md／env 值皆為合成資料。Runner 隔離 HOME／XDG，不讀使用者 provider credentials 或真實 Keychain。

### 失敗測試與替身修正

保留了初次錯誤使用 provider package 形式的失敗目錄。沒有 `aisdk:` 前綴會被 host 當 native module；有前綴但指向單個 index.mjs，host 會找不到 package.json。這些是 runner 設定失敗，不算 SG 回歸。

替身一開始缺 Responses `created_at`／`model`／完整 usage details，以及 Chat Completions usage chunk。SDK 對協定比 native driver 嚴格，因此出現 parse／truncation 重試。修正替身後才比較 SG 行為。

Commandcode 的實際 `gpt-6.1` 工具集提供 patch 而非 write。Runner 現在依 advertised tools 選 patch，並精確驗證其檔案內容含正常結尾 newline；shell 檔仍須精確等於 email 原值。沒有用「忽略工具失敗」方式讓案例轉綠。

OpenAI final-wire 的 SG 缺口證據留在 `sg-ws-tools-Kw97Ad/`。Guard 直接 throw 導致 Go 逾時的失敗證據留在 `sg-ws-tools-T22WX6/`。暫存目錄不是永久封存，runner 可重跑。

## 重跑

先在外部目錄安裝上述 SDK 版本。不要把測試 SDK 加入本倉庫 production dependencies。`SDK_DIR` 為該目錄的 node_modules。

```sh
npm test
npm run build
OPENCODE_BIN=/absolute/path/to/opencode \
E2E_PROVIDER_PACKAGE="$SDK_DIR/@ai-sdk/openai" \
node scripts/e2e/run-responses-ws.mjs

OPENCODE_BIN=/absolute/path/to/opencode \
E2E_PROVIDER_PACKAGE="$SDK_DIR/@ai-sdk/anthropic" \
E2E_MODEL_ID=claude-sonnet-4-5 \
node scripts/e2e/run-responses-ws.mjs

OPENCODE_BIN=/absolute/path/to/opencode \
E2E_PROVIDER_PACKAGE="$SDK_DIR/opencode-cmd-provider" \
E2E_MODEL_ID=gpt-6.1 \
node scripts/e2e/run-responses-ws.mjs

OPENCODE_BIN=/absolute/path/to/opencode \
E2E_PROVIDER_PACKAGE="$SDK_DIR/opencode-cmd-provider" \
E2E_MODEL_ID=gpt-6.1 E2E_REJECT_LEGACY=1 \
node scripts/e2e/run-responses-ws.mjs
```

不指定 E2E_PROVIDER_PACKAGE 即重跑既有四個 native HTTP／WS 案例。Runner 失敗 exit 1。Negative 模式要求明確拒絕、沒有外送與 side effects、沒有逾時；零 capture 或程序 exit 0 本身不算通過。

## 覆蓋限制與待辦

**已驗證的邊界：** 這三種 SDK 使用 injected fetch，標準協定由現有 HTTP hooks 防護。Guard 本身不是 process-wide 網路防火牆。

**未驗證：** 自行使用 global fetch、內部 socket、獨立子程序或其他 transport 的 SDK 不在覆蓋內。接受初始化不代表證明了該 SDK 的所有路線安全，也不能聲稱繞過 injected fetch 的 SDK 一定被拒絕。每個新增 SDK 仍需要 source／capture 驗證。

**未驗證：** 真實 provider／subscription／OAuth、外部錯誤回覆、完整 SDK title／compaction／generate、併行多 session 的實際 host 流程、非標準 extensions 與所有模型工具集。既有 HTTP mock attribution 測試不替代這些驗證。

**未完成：** Go 的 legacy adapter、實際全域／專案插件註冊與最新 Rehydra 三方對照。此次是在安裝前修正相容性缺口；沒有改使用者正式設定、啟用 persistence、存取真實 Keychain、重啟 shared service、commit 或 push。

下一步先決定正式安裝範圍，並確認日常 commandcode 是否需要 Go／legacy。需要該路線時，不能用標準路線成功推論安裝後不會影響對話。
