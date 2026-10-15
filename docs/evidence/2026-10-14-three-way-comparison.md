# SG、官方 Rehydra、EightDoor：OpenCode V2 三方重測

日期：2026-10-14。Host：OpenCode **v2.0.28**。延續 [10/11 三方隔離比較](2026-10-11-official-rehydra-v2-comparison.md)，以同一套 harness 重跑，更新 SG 欄位。

## 結論

**在這個 V2 host 上，三方之中只有 SG 同時做到「全部情境不外送合成敏感值」與「長歷史真實模型可接續」。** EightDoor 操作最無感，但 AGENTS.md 的 system 內容仍原值送出；官方套件仍無法在 V2 載入，對話完成等同沒有保護。

| | SG（持久化開） | SG（預設） | EightDoor `opencode-rehydar@0.14.3` | 官方 `@rehydra/opencode@0.14.0` |
|---|---|---|---|---|
| V2 載入 | ✅ | ✅ | ✅ | ❌ `Plugin must export a default definition…` |
| 11 情境合成值外送 | **0** | **0** | system-secret 2 筆 | 與無插件相同（10/11 情境外送） |
| 11 情境操作正確 | **11/11** | 10/11（重啟舊 token 寫檔拒絕） | 11/11 | 5/11（未形成 token，無從還原） |
| Responses HTTP／WS／default | — | 6/6 不外送 | 3/3 不外送 | 3/3 各 2 筆外送 |
| 長歷史真實模型分叉 | — | ✅（本日 opaque 修正後） | 未測 | 未測（無法載入） |

## 版本與方法

- **SG**：`55e5ff9`（`dist` 與 HEAD 一致），兩組 `wireProtection: false`（hook）／`true`（wire），持久化關閉；另加 `sg-persist-test` 持久化組，使用測試專用 `InMemoryMappingKeyProvider`，**未驗證真實 Keychain ladder**。
- **官方**：npm `latest` 仍為 0.14.0（`time.modified` 2026-09-06），`rehydra` 0.14.0；與 10/11 同一隔離安裝。
- **EightDoor**：npm `latest` 仍為 0.14.3（2026-09-29）；同一隔離安裝。
- **Harness**：本次結果由本機暫存目錄的 `compare.mjs`（Chat Completions 11 情境）與 `protocols.mjs`（native Responses 三種 transport）產生；各案例獨立 HOME／XDG、`opencode run --standalone`、loopback 模型替身、合成 email／env secret；**無真實模型請求**。持久化組以 `compare-current.mjs`（同腳本，只把寫死的舊 SG 副本路徑改指 `E2E_SG_DIST`）執行。
- **已納入 repo（2026-10-15）**：暫存目錄被系統清掉，`protocols.mjs` 已遺失，現以 [`scripts/e2e/compare/`](../../scripts/e2e/compare/README.md) 的 `chat.mjs`／`responses.mjs` 取代。`chat.mjs` 由保留的 `compare-current.mjs` 轉入；**`responses.mjs` 是依殘留的案例設定與擷取結果重建，不是原檔**。以官方 0.14.0／EightDoor 0.14.3 重新安裝後重跑，Chat 55 案與 Responses 12 案的對話、操作、外送與 primary 路線結果與本文逐格一致（SG 預設組亦同）。數字以本文為準，之後重現請用 repo 內版本。
- 「外送」在 Chat 是請求 × 合成值種類命中數，不是獨立漏洞數；Responses 表的外送是含原值的請求數（標題與主請求各算一筆，故未保護為 2）。

## Chat Completions 11 情境（每格：操作／外送筆數）

| 情境 | 無插件 | SG hook | SG wire | SG 持久化 | 官方 | EightDoor |
|---|---|---|---|---|---|---|
| clean | OK／0 | OK／0 | OK／0 | OK／0 | OK／0 | OK／0 |
| secret-chat | OK／4 | OK／0 | OK／0 | OK／0 | OK／4 | OK／0 |
| reply-restore | OK／2 | OK／0 | OK／0 | OK／0 | FAIL／2 | OK／0 |
| read-output | OK／2 | OK／0 | OK／0 | OK／0 | OK／2 | OK／0 |
| read-restore | OK／3 | OK／0 | OK／0 | OK／0 | FAIL／3 | OK／0 |
| write-restore | OK／3 | OK／0 | OK／0 | OK／0 | FAIL／3 | OK／0 |
| shell-simple | OK／3 | OK／0 | OK／0 | OK／0 | FAIL／3 | OK／0 |
| shell-quoted | OK／3 | OK／0 | OK／0 | OK／0 | FAIL／3 | OK／0 |
| system-secret | OK／2 | OK／0 | OK／0 | OK／0 | OK／2 | OK／**2** |
| restart-chat | OK／6 | OK／0 | OK／0 | OK／0 | OK／6 | OK／0 |
| restart-write | OK／4 | **FAIL**／0 | **FAIL**／0 | OK／0 | FAIL／4 | OK／0 |

- **SG restart-write（持久化關）**：重啟後模型替身沿用前一個 process 的 token 寫檔，SG 拒絕該 write：「placeholder has no mapping in this session. Re-read the source…」，對話繼續。這是刻意的不猜測政策；開啟持久化後同情境 OK。
- **官方 FAIL**：插件沒載入，未形成 token，還原類 fixture 無從驗證；不能解讀成官方 V1 引擎的工具缺陷。外送筆數與無插件逐格相同。
- **EightDoor system-secret**：AGENTS.md 的 email 與 env secret 在 primary 請求原值送出，與 10/11 相同，未修。

## Native Responses（transport × 外送／primary 路線）

| | http | websocket | default |
|---|---|---|---|
| SG hook | 0／http | 0／websocket | 0／**websocket** |
| SG wire | 0／http | 0／websocket | 0／http |
| 官方 | 2／http | 2／websocket | 2／websocket |
| EightDoor | 0／http | 0／websocket | 0／websocket |

- SG hook 的 default 路線現在走 WS：10/11 之後 hook-only 改為純 hook，不再把 primary 導向 HTTP。wire 模式仍導向 HTTP。
- 官方欄 `restored=true` 只是替身收到原值後原樣回傳，不是還原成功。

## 與 10/11 相比的變化

| 項目 | 10/11 | 10/14 |
|---|---|---|
| SG 長歷史真實模型分叉 | 準備階段拒絕；後改為 `invalid_encrypted_content` 400 | **通過**（opaque reasoning state 保持原樣，見 [capacity 重測](2026-10-14-live-capacity-and-lifecycle-retest.md)） |
| SG 容量 | 128 session、1 Mi units 上限 | 4,096 session、8 Mi units；`session.deleted` 回收 |
| SG hook-only default transport | 導向 HTTP | 走 WS，仍不外送 |
| SG 重啟沿用舊 token | 拒絕 | 預設仍拒絕；**持久化開啟可接續**（測試金鑰） |
| 官方 V2 載入 | 失敗（v2.0.25） | 仍失敗（v2.0.28），無新版本 |
| EightDoor system 遮罩 | 原值送出 | 仍原值送出，無新版本 |

## 機制差異（未變，摘要）

詳見 [10/11 現況比較](2026-10-11-current-sg-official-rehydra.md) 與 [官方原始碼稽核](2026-10-11-rehydra-current-source-audit.md)。

- **SG**：V2 `id/setup`；原子保護 system／messages／options／tools；可選 final-wire 掃描；工具還原有 mapping／shell literal 安全閘門，不安全即拒絕；provider opaque state（加密 reasoning、簽章）原樣保留。
- **EightDoor**：V2 plugin；回覆與工具還原失敗時記錄後放行（保留 placeholder），體驗較少中斷；system 未遮罩。
- **官方 0.14.0**：V1 五個 hooks；system 只追加說明不遮罩，title 可能漏首訊；無 final-wire；memory-only；在 V2 無法載入。

## 未驗證

- EightDoor／官方在長歷史真實模型、加密 reasoning state 上的行為。
- 三方的延遲、誤判率；本矩陣不排名效能或偵測準確度。
- SG 持久化的真實 Keychain ladder；本次只用測試金鑰。
- Anthropic Messages 真實 provider。

## 原始證據

```text
$TMPDIR/opencode/sg-rehydra-test-4Uw7Wx/results/2026-10-14T09-51-39-805Z-TH35uJ/summary.json   # 55 案
$TMPDIR/opencode/sg-rehydra-test-4Uw7Wx/results/2026-10-14T09-53-11-231Z-LBVtfe/summary.json   # SG 持久化 11 案
$TMPDIR/opencode/sg-rehydra-test-4Uw7Wx/protocol-results/2026-10-14T09-52-39-390Z/summary.json # Responses 12 案
```
