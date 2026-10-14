# 目前 Sensitive Guard、官方 Rehydra 與 EightDoor：OpenCode V2 對照

日期：2026-10-11。Host：OpenCode v2.0.25。

## 結論

**目前不建議直接全域啟用任一方。** Sensitive Guard（SG）在隔離的正常 HTTP／WS 流程有效，但實際服務已有 WS 歸屬檢查阻斷回覆的證據。官方 `@rehydra/opencode@0.14.0` 在此 V2 host 載入失敗；對話完成是未啟用保護，不是可安全替換 SG。

本文件分開比較官方發布版及使用者指定的 EightDoor V2 fork。`opencode-rehydar@0.14.3` 的 V2 成功結果不能算在官方版上。補測的 fork 可以作為對話降級設計參考，但其 system 遮罩缺口仍存在，不建議直接換裝。

## 已驗證：比較對象及邊界

- SG：目前工作樹的 `dist/`，含先前 shell、WS、AI SDK 修正；不是乾淨 HEAD 的能力。
- 官方：本次核對 npm latest 為 `@rehydra/opencode@0.14.0`，隔離安裝並固定其引擎為 `rehydra@0.14.0`。
- 對照：無插件、SG hook-first（`wireProtection: false`）、SG final-wire（true）、官方版。
- 各案例以獨立 HOME／XDG 及 `opencode run --standalone` 執行。
- 只使用 loopback 模型替身、合成 email／secret；本次沒有真實模型請求。
- SG 明確設定 `.env` 來源，持久化關閉。官方配置相同來源、NER 關閉，但其 V2 載入失敗，選項並未生效。
- 沒有重新註冊全域 SG，沒有重啟共用服務，沒有存取 Keychain，沒有修改產品程式碼。

## 已驗證：官方插件沒有在此 V2 host 生效

官方套件預設匯出 `createRehydraPlugin()` 回傳的 V1 plugin function。引擎註冊五個 V1 hooks：

```text
experimental.chat.messages.transform
experimental.chat.system.transform
tool.execute.before
tool.execute.after
experimental.text.complete
```

發布內容沒有 V2 的 `id/setup/effect` 入口。本次實際 host 的日誌明確記錄：

```text
message="failed to load plugin"
PluginModule.LoadError: Plugin must export a default definition
with an id and an effect or setup function.
SchemaError(Expected object at ["default"])
```

`secret-chat` 的 title 與 primary 捕獲均含合成 email 和 env secret，沒有 placeholder。這與無插件對照一致。不是「官方完全不攔、仍正常遮罩」，而是根本沒有載入。

V2 官方文件也明確說：V2 讀取預設匯出的 `id/setup/effect`，不會自動將 V1 hooks 轉成 V2 hooks。

## 已驗證：本次隔離測試矩陣

共執行 **48 個 Chat Completions 案例＋12 個 native Responses transport 案例**。這是執行數，不是 60 個安全成功案例。Runner 用於記錄差異，本次未帶 `--assert`；runner exit 0 不能當成全套通過。

| 檢查 | SG hook-first | SG final-wire | 官方 0.14.0／V2 |
|---|---|---|---|
| 普通中英對話 | 完成 | 完成 | 完成，但插件載入失敗 |
| 敏感對話，title＋primary 遮罩 | 通過 | 通過 | 原值送出 |
| placeholder 跨 SSE chunks，顯示還原 | 通過 | 通過 | 無遮罩／還原可驗證 |
| read 工具輸出再送模型 | 通過，原值未送出 | 通過，原值未送出 | 工具完成，原值送出 |
| tokenized 路徑 read／內容 write | 正確還原 | 正確還原 | 未形成 token，不能驗證還原 |
| plain／單引號 shell／引號＋靜態重新導向 | 正確完成 | 正確完成 | 未形成 token，不能驗證還原 |
| AGENTS.md system 敏感值 | 遮罩 | 遮罩 | 原值送出 |
| process 重啟後續聊 | 完成且遮罩 | 完成且遮罩 | 完成但原值送出 |
| 重啟後刻意沿用第一輪舊 token 寫檔 | 工具拒絕；對話繼續 | 工具拒絕；對話繼續 | 無有效 token，不能驗證 |
| native Responses HTTP | 完成、遮罩、還原 | 完成、遮罩、還原 | 完成但未保護 |
| native Responses 明確 WS | 完成、遮罩、還原 | 完成、遮罩、還原 | 完成但未保護 |
| native OpenAI default transport | primary 走 HTTP，通過 | primary 走 HTTP，通過 | primary 走 WS，但未保護 |

Chat Completions 的 SG 每組 12 案中，12 案對話完成，11 案操作／還原正確，0 次合成原值外送。唯一操作失敗是重啟後舊 token 寫檔：

```text
Sensitive Guard transparent mode blocked this tool call because
a placeholder has no mapping in this session.
```

官方與無插件對照都在 11 個含敏感值案例中送出原值；各有 35 個「請求 × 合成原值種類」命中。數字不代表 35 個獨立漏洞。官方工具還原案例缺 token 所產生的 fixture 失敗，不能解讀成官方 V1 引擎的工具缺陷。

Native Responses 的 SG 六案全部完成、還原且未送出原值；官方三案各有兩筆含原值請求。官方顯示原值只是模型替身收到原值後回傳原值，不能算去識別化還原成功。

## 已驗證：為何先前修正仍會擋

先前修正沒有取消所有拒絕。三層行為必須分開：

| 層 | 已修正／現況 |
|---|---|
| AI SDK 初始化 | 不再全面拒絕；接納使用 OpenCode injected fetch 的受支援路線 |
| 最終出站內容掃描 | `wireProtection: false` 關閉此層掃描／重新遮罩 |
| transport／請求歸屬／工具安全還原 | 仍保留拒絕；wire=false 不解除 |

使用者報告的同一串流錯誤，其底層日誌為：

```text
AI.Error.InvalidProviderOutput: Failed to read openai/openai-responses stream
Sensitive Guard transparent mode blocked a WebSocket frame
without matching request attribution. [hook=experimental.ws.receive]
```

這證明該次串流被 SG 歸屬守門阻斷，不是 Go／`/alpha/generate` 的拒絕。它尚未證明為何歸屬狀態缺失。

本次另外重跑 `tests/opencode-transparent-ws.test.ts`：**23 tests passed**。其中明確測試 false／true 都拒絕缺歸屬的 frame。這證明目前規則仍會拒絕，不是此實際故障已修好。

## 已驗證但不是本次重跑：真實帳號證據

此前 GOAT 帳號 smoke：OpenAI Chat Completions 的兩種 wire 設定通過，合成 email 送出前遮罩、顯示還原。Anthropic Messages 的兩案捕獲到已遮罩請求，但生成失敗，原因尚未釐清。不能將本地 Anthropic 成功當作真實 provider 已驗收。

## 使用者指定的 V2 參考：EightDoor 補測

參考訊息：`openchamber://session/ses_ed95147f0ffelZl7Ao33U13pgU?message=msg_1273eaeac0014jrRxwS1Bcb3tT`。已讀取該訊息；它所指的 V2 實作是 EightDoor fork，不是官方套件。訊息引用的 GitHub commit 與 npm 發布版不視為同一份程式；本次實測的是已安裝的 `opencode-rehydar@0.14.3`。

相同 host、合成資料、隔離方法及案例腳本補跑 **12 個 Chat Completions 案例＋3 個 native Responses transport 案例**。與上面的 60 案合計執行 75 案，仍不是 75 個安全成功案例。

| 檢查 | 目前 SG（兩種 wire） | EightDoor V2 0.14.3 |
|---|---|---|
| 正常／敏感對話、title 遮罩、SSE 顯示還原 | 通過 | 通過 |
| read 輸出重新遮罩、tokenized 路徑及 write 內容還原 | 通過 | 通過 |
| plain／單引號 shell／靜態輸出重新導向 | 通過 | 通過 |
| 重啟後正常續聊 | 通過 | 通過 |
| 模型替身刻意沿用重啟前舊 token 寫檔 | 拒絕該工具；對話繼續 | 本 fixture 正確完成 |
| AGENTS.md system email／secret | 遮罩 | **原值送出** |
| 明確 native Responses HTTP／WS | 本地替身通過 | 本地替身通過 |
| native OpenAI default transport | primary 導向 HTTP | primary 走 WS，完成且遮罩 |
| 真實服務的缺歸屬 WS frame | 已有 SG 阻斷紀錄，未修復 | **未實測此故障條件** |

EightDoor 的 12 案對話及操作均完成，沒有 fixture harness error；但 `system-secret` 的第二筆（primary）請求含 system email 及 env secret。三個 native transport 案均完成、顯示還原、捕獲未含原值。重啟舊 token 的成功只證明本固定順序 fixture，不證明 durable mapping 或 fork/reorder 安全。

### 可以參考的設計，以及不可照搬的部分

**已驗證於發布內容：** `dist/opencode-plugin/v2/response-rehydrate.js` 說明並實作回覆還原失敗時記錄錯誤、傳回原始 payload；`plugin.js` 的 HTTP／WS 回覆 hook 也捕捉錯誤。`v2/register-hooks.js` 對工具還原錯誤記錄後吞錯，而遮罩錯誤會重新拋出。

**推論／改善方向：** 回覆側降級可參考「無法還原就保留占位符」，避免只因還原失敗中止整段對話。但缺歸屬情況不得猜測 session 或取其他 lane 的 mapping；不能把本地正常 WS 成功視為此 lifecycle 故障已被 fork 解決。

**不直接照搬：** 工具還原失敗後仍執行可能造成錯誤路徑、錯誤內容或不安全 shell 語意。system 遮罩缺口亦必須修復。此次沒有修改 SG 的拒絕政策或安裝 EightDoor 到使用者全域設定。

## 未解決及建議

1. SG 保持全域停用；設定已移除，但本次沒有確認所有既有服務實例已卸載。
2. 不直接換成官方 0.14.0：此 V2 host 不會載入它。
3. 若繼續 SG，先重現實際 WS lifecycle／歸屬故障，再修正；不可直接白名單放行或移除還原隔離。
4. 修正後先在隔離環境驗證，再以使用者常用的真實 native OpenAI 路線驗證；未通過前不重新全域啟用。
5. EightDoor V2 已補測，可作回覆側降級參考；先補 system 遮罩與實際 WS 故障驗證，再討論替換。勿直接照搬工具吞錯政策。

未驗證：真實長時間 WS、載入中已存在的 socket、重連／模型切換／HTTP fallback 是否造成此故障、官方 V1 runtime 能力、NER、完整資安審計與效能比較。

## 原始證據與來源

暫存測試根：

```text
$TMPDIR/opencode/sg-rehydra-test-4Uw7Wx/
```

- `results/2026-10-11T05-19-09-352Z-B1fEh6/summary.json`：48 案。各案例保留 result、captures、stdout、stderr。
- `protocol-results/2026-10-11T05-20-02-431Z/summary.json`：12 transport 案。
- `results/2026-10-11T05-24-42-678Z-d9X5Uq/summary.json`：EightDoor 補測 12 案；`eightdoor--system-secret/captures.json` 保存 primary system 漏值證據。
- `protocol-results/2026-10-11T05-24-55-294Z/summary.json`：EightDoor 補測 3 transport 案。
- `compare.mjs`／`protocols.mjs`：本次重用並加入官方 suite、`E2E_SG_DIST`、`E2E_REHYDRA_PACKAGE` 選擇。
- 官方安裝根：同一暫存父目錄下的 `sg-rehydra-official-7kXIwF/node_modules/`。
- 載入錯誤：Chat 證據的 `official--secret-chat/run1.stderr.log`。
- 先前真實帳號摘要：同一暫存父目錄的 `sg-live-compatible-zurMT9/summary.json`。
- 實際串流錯誤：`~/.local/share/opencode/log/opencode.log`，`2026-10-11T03:51:11.171Z`。
- V2 文件：<https://opencode.ai/v2/docs/build/plugins>（Support V1 段）。
- 官方 registry：<https://registry.npmjs.org/@rehydra/opencode/latest>。
- 官方來源：`@rehydra/opencode/index.js`、`rehydra/dist/opencode-plugin/plugin.js`、`rehydra/dist/storage/session-base.js`。
- EightDoor 來源：測試根下 `eightdoor/node_modules/opencode-rehydar/dist/opencode-plugin/plugin.js`、`v2/register-hooks.js`、`v2/response-rehydrate.js`。補測使用 `--suite=eightdoor`。

重跑 Chat 比較：設定 `E2E_SG_DIST` 指向此 repo 的 `dist`，`E2E_REHYDRA_PACKAGE` 指向隔離的官方 package directory，執行 `node compare.mjs --suite=baseline,sg-hook,sg-wire,official`。Native 比較使用相同環境變數執行 `node protocols.mjs --suite=baseline,sg-hook,sg-wire,official --transport=http,websocket,default`。

暫存資料不保證永久留存；本文件保存可審查的導出結論。沒有 commit／push。
