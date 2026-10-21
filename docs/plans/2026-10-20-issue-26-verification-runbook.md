# Issue #26 驗證 runbook（透明模式：真實環境）

Status: **模板，尚未執行**（2026-10-20）。這份文件不含任何已完成的驗證結果；
跑完之後把數字填進最後的記錄區塊，再關閉 issue。

例外：keychain 那格在 2026-10-20 跑過一次，結果在
[`docs/evidence/2026-10-20-keychain-custody.md`](../evidence/2026-10-20-keychain-custody.md)。
那次執行時 restart 子程序仍可能建立金鑰；現在子程序已改為唯讀，**建議重跑一次**
再拿去勾選。

Issue #26 的五個勾大部分不是程式缺口，而是「需要真人 + 真憑證」的缺口：腳本已經
備好，執行者只需要放憑證、按系統授權、讓 soak 跑完。**但腳本目前只提供部分證據**，
還不足以關掉整個 #26：LeakShield mapping 釋放（見下）與 native Responses WS
重用都缺 content-free 插樁，延遲／誤報則只能由真人主觀記錄。

## 五個勾與對應方法

| # | Issue 勾選項 | 方法 | 需要誰 | 產出 |
|---|---|---|---|---|
| 1 | 真實 OS keychain 金鑰保管 | `scripts/diagnostics/verify-keychain-persistence.mjs --real-keychain` | 本人（授權彈窗） | `summary.json`：`source=os-keychain`、跨程序解密成功 |
| 2 | 真實 Anthropic Messages provider | `scripts/e2e/run-real-provider.mjs`（`E2E_PROVIDER=anthropic`） | 本人（API key） | 每個 case 的 `originals=0` / `placeholders=N` |
| 3 | 其他 provider 的長歷史 replay | 同上，`E2E_PROVIDER=openai`、`E2E_TURNS=20` | 本人（API key） | `turnsDetail[].covered` 全為 true、`missingPlaceholders=0`、每輪 mainBytes、`originals=0` |
| 4 | `wireProtection: true` 對真模型 | 同上，`real-basic-wire` case（內建） | 本人（API key） | 該 case PASS |
| 5 | 長時間 soak、session 回收、記憶體 | `scripts/e2e/run-soak.mjs`（1 小時以上） | 本人（放著跑） | `rssKb.series`、`memory.measured=true`、`deletedSessionsGone` |
| — | 延遲與誤報（真實對話） | **無腳本**：需要真人使用感受 | 本人 | 主觀紀錄，不可由 agent 代填 |

WebSocket 重用（soak 裡的 WS reuse）**不在**目前 soak 覆蓋範圍：stand-in 是
HTTP，Anthropic 也是 HTTP Messages。要驗證 native Responses WS，需要一個
真的會開 WS 的 provider，另外記一筆。

LeakShield **自己的 mapping 釋放**也不在 soak 覆蓋範圍：腳本只觀察 host 端的
session 建立／刪除，看不到 plugin 內部的 mapping 計數，所以 `session.deleted`
訂閱壞掉時 soak 仍會過。那段契約由
`tests/opencode-transparent-capacity.test.ts` 覆蓋；要對長時間執行做同樣驗證，
需要 content-free 的 mapping 計數插樁，尚未實作。soak 的 `summary.reclamation`
把這一點寫成 `leakshieldMappingRelease: "not-verified"`。

## 前置

```bash
npm ci
npm run build
opencode --version        # 需要 v2；或 export OPENCODE_BIN=/path/to/opencode
```

憑證只放在**當前 shell 的環境變數**，腳本不複製、不落盤、不輸出：

```bash
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...        # 只有要跑 OpenAI 時
```

時間與費用粗估（依模型而異，僅供安排）：

| 步驟 | 時間 | 呼叫數 |
|---|---|---|
| 離線自檢 | < 2 分鐘 | 0（本機 stand-in） |
| Anthropic 三個 case | 3–5 分鐘 | 8 次（1 + 1 + 6 輪） |
| 長歷史 20 輪 | 5–10 分鐘 | 20 次 |
| soak 1 小時 | 60 分鐘 | 每輪 1 次，間隔可調 |

## 執行順序

### 0. 離線自檢（不需要憑證，先確認 harness 沒壞）

```bash
E2E_PROVIDER=capture node scripts/e2e/run-real-provider.mjs
E2E_SOAK=1 E2E_SOAK_MS=10000 node scripts/e2e/run-soak.mjs
node scripts/diagnostics/verify-keychain-persistence.mjs --simulated
```

三個都 PASS 只代表工具本身可用，**不算 #26 證據**。

### 1. Keychain（macOS 會跳授權）

```bash
node scripts/diagnostics/verify-keychain-persistence.mjs --real-keychain

# 只有當這台主機還沒有金鑰、而且你願意建立正式項目時：
node scripts/diagnostics/verify-keychain-persistence.mjs --real-keychain --allow-create
```

- 會讀正式 keychain 項目（service `leakshield`、account `sgp-mapping-key`）。
- **預設不建立**：項目不存在時以 exit 2 結束，提示先啟用 persistence 或加 `--allow-create`。
  重啟子程序也走唯讀 probe，項目在父子之間消失時會判失敗，不會自己補一把。
- `--allow-create` 才會建立（等同第一次啟用持久化）；此時 `createdProductionKey: true`。
- `keychainItemExistedBefore` 取自 key ladder 的**第一次讀取**；本次執行前不存在時為 `false`。
  （舊版腳本在 ladder 可能已建立之後才讀，所以該欄位恆為 `true`；已修正。）
- **不會刪除**任何 keychain 項目。DB 寫在暫存目錄，跑完刪除。
- 若 `keychainAvailable: false`，先看 `summary.error`：`keychain_item_absent` 表示
  這台主機還沒有項目（見上）；其他情況才檢查 `security` 與登入 keychain 是否解鎖。
- 若日後要移除這個項目（會讓既有持久化 mapping 無法解密，通常**不要**做）：
  `security delete-generic-password -s leakshield -a sgp-mapping-key`

通過條件：`source=os-keychain`、`restartFound=true`、`restartEntriesMatch=true`、`restartKeyIdMatch=true`。

### 2. Anthropic（勾 2 與 4）

```bash
E2E_REAL=1 E2E_PROVIDER=anthropic node scripts/e2e/run-real-provider.mjs
```

- `real-basic-hook`：hook-only 下原始值不外送。
- `real-basic-wire`：`wireProtection: true` 對真模型（勾 4）。
- `real-long-history`：6 輪逐輪累積歷史，每個 request 都不得含原值。

### 3. 長歷史與其他 provider（勾 3）

```bash
E2E_REAL=1 E2E_PROVIDER=openai E2E_OPENAI_MODEL=<你的模型> E2E_TURNS=20 \
  node scripts/e2e/run-real-provider.mjs
```

`E2E_OPENAI_MODEL` 沒有預設值：模型名稱變動快，故意要求明填。
判斷「長歷史」是否真的成立，看 `summary.json` 裡 `turnsDetail[]` 的 `covered`。
observer 會為每個出現過的 placeholder 記一個短 hash（不存 token 本身）。
**每一輪中所有帶使用者回合的 request**（`kind` 為 `primary` 或 `generate`，包含
重試）都必須仍帶著前面所有輪引入的 placeholder：`missingPlaceholders` 必須為 0。
挑「最大的那一個」不算，因為一個完整的大 request 會替同輪另一個缺漏的 request 遮掩。
最後一輪只要求重述、不再引入新值，所以 `introducedPlaceholders` 應為 0；其他輪則
應 ≥ 1。用「不同 hash」而不是出現次數，是因為 assistant 回覆會重複既有 placeholder，
用次數會被重複的舊值冒充成沒丟。未達標直接以 `history_not_replayed` FAIL；
`mainBytes` 與 `trace.bytesPerRequest` 提供成長趨勢。

### 4. Soak（勾 5）

```bash
E2E_SOAK=1 E2E_REAL=1 E2E_PROVIDER=anthropic E2E_SOAK_MS=3600000 \
  node scripts/e2e/run-soak.mjs
```

- 每輪：建立 session → 一次極短對話 → 刪除 → GET 確認**明確回報不存在** → 取 server RSS。
  host 對已刪除的 session 回 `_tag: "SessionNotFoundError"`，且 `sessionID` **必須完全
  等於**剛刪掉的那個 id；只有這個結構化回應才算「已回收」，訊息文字不參與判定。
  timeout、解析失敗、其他型別的 NotFound、id 只有前綴相同、或錯誤訊息裡剛好有
  「not found」都記成 `deleted_session_state_unknown` 並判該輪失敗。
- 費用與時長成正比；先用 `E2E_SOAK_MS=60000` 試一次再放大。
- 通過條件（腳本會自動判定）：`passes == iterations`、`deletedSessionsGone ==
  deletedSessionsChecked`、`memory.measured == true`（至少兩個 RSS 樣本）。
- **需要人看的部分**：RSS 曲線趨勢（`rssKb.series`；1 小時內 delta 應趨於平緩，
  沒有絕對門檻，腳本不會替你判定）。`summary.reclamation.memoryTrendAssessment`
  標成 `manual` 就是這個意思。

### 5. 延遲與誤報（真人）

這個勾沒有腳本。建議記下：模型、對話長度、你感覺到的延遲、以及有沒有
正常的文字被誤遮蔽。貼在 issue 留言即可。

## 記錄模板（跑完貼回 issue #26）

```
## #26 verification — <YYYY-MM-DD> — <OS / 版本>

- commit: <sha>
- opencode: <version>
- provider / model: <provider/model>
- 執行者：<name>

| 項目 | 結果 | 證據 |
|---|---|---|
| OS keychain 保管 | PASS / FAIL | source=…, restartFound=…, keyIdMatch=…, childReadOnly=… |
| Anthropic Messages | PASS / FAIL | requests=…, originals=…, placeholders=… |
| 長歷史 replay（20 輪） | PASS / FAIL | covered 全 true, missing=…, bytes 首/末=…, originals=… |
| wireProtection: true | PASS / FAIL | case real-basic-wire |
| soak（1h） | PASS / FAIL | iterations=…, rss 首→末=… KiB, memory.measured=…, gone=…/… |
| 延遲 / 誤報感受 | 主觀描述 | … |

備註（限制、異常、未覆蓋項目，例如 `leakshieldMappingRelease: not-verified`）：
```

## 安全邊界

- 腳本只輸出布林、計數、位元組數、RSS 與 placeholder 的短 hash；不寫 prompt、
  回覆、金鑰或 request body。stand-in provider 以 `CAPTURE_RECORD=0` 啟動：
  body 仍會解析以產生回覆，但不會落盤。
- 每個案例使用隔離的 HOME / XDG，不讀寫你的 OpenCode 設定。
- 暫時 session 在正常路徑跑完即刪除；刪除失敗不會讓已完成的判定翻盤，所以
  異常中斷時 workdir 與 session 可能殘留，落在 `$TMPDIR/opencode/sg-*`。
- 沒有實際跑過的勾**不要**標成 verified；capture / simulated 模式的 PASS 只是
  harness 自檢，不能當 #26 證據。
