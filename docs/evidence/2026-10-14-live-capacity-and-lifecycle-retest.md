# 容量修正版：實機長歷史與 native 刪除回收重測

日期：2026-10-14。使用者已授權真實模型分叉重測；不續寫原對話，不改全域設定，不重啟共用服務，不 commit／push。

**後續更新（同日）：** opaque integrity 已在 hook 層修正：`src/opencode-transparent.ts` 的 `withOpaqueProviderState` 在遮罩交易前後以 sentinel 保留 assistant 訊息中 reasoning／compaction 的 `encrypted`，以及 `providerMetadata.<provider>` 的 `reasoningEncryptedContent`／`encryptedContent`／`signature`／`redactedData`／`thoughtSignature`；限定位置之外，還要求單一 base64(url) 片段且解碼後可列印比例 ≤ 75%，readable 或 base64 編碼的明文仍照常掃描。新回歸 `tests/opencode-transparent-opaque-state.test.ts`（9 案，修正前 6 red）；`npm test` 44 files／955 passed（`web.test.ts` 需在沙盒外綁本機 port）；`verify-opaque-reasoning-integrity.mjs` exit 0。真實 OpenCode v2.0.28 host＋本地模型替身（`OPENCODE_BIN=/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode node scripts/e2e/run-responses-ws.mjs`）HTTP／WS × hook／wire 四案 PASS、exit 0。

**真實模型重測（同日，使用者授權）：PASS。** 同一 fixture、來源 session 與 model，`retest-installed-plugin.mjs` exit 0：short-new-session `ses_ec6434aa6ffePiIBTFPg6OGygM`、source-history-fork `ses_ec6433c81ffes3pCWXGJWre0cM` 皆精確 marker、error／tool events 0、準備拒絕 0；私有服務 PID **58843** 已停止，全域設定與 compiled guard（SHA-256 `cc1499410400ffe8e6e664fbccce9fa615f0933e135a3fee843ab6a4ff003d5b`）前後一致。`invalid_encrypted_content` 未再出現，支持 opaque 改寫為先前失敗原因，但仍是單次、單 provider／model 的結果。`wsDegradationObserved=true` 為通用 WARN prefix 偵測，未據此判定問題。Runner 需配合目前 host 的 server 認證：已改為與 lifecycle runner 相同的隨機 `OPENCODE_SERVER_PASSWORD`／`OPENCODE_PASSWORD`，否則在 `server-start` 階段以 Unauthorized 失敗、不送出任何模型請求。下文保留修正前的紀錄。

## 結論

**Native 刪除回收通過；原長對話分叉仍未通過。**

- 真實 OpenCode v2.0.28 的 `session.deleted` delivery、mapping 回收、容量重用及另一 session 的 WS 緩衝保留，兩次隔離驗證均通過。
- 真實模型短對話通過；原長歷史分叉失敗。本次沒有再觀察到先前的 `prepare.mask / operation_limit`，新錯誤為 provider `invalid_encrypted_content`，狀態 **400**。
- 進一步離線檢查發現 encrypted reasoning state 的 byte-integrity 風險：77 個既有加密欄位逐一測試，有 1 個被當成 `API_KEY` 改寫。用不含任何真實密文的合成資料，在公開 `session:context` hook 也可重現原生 reasoning `encrypted` 欄位被改寫。
- **新增的 opaque integrity 診斷仍是 red，尚未修正。** 不能把 946 unit tests green 或先前四組本地模型 E2E green 當成長歷史已恢復，更不能直接把這次錯誤歸咎於 provider。

這次實機沒有捕獲真實出站密文的逐位 before/after，因此「本次 provider 拒絕的唯一原因就是那一段改寫」仍未成立。既有 ciphertext 的帳戶／model 綁定、歷史 replay 或 host 序列化問題也尚未排除。

## 1. 真實模型 availability 重測

### 條件與隔離

- Host：OpenCode **v2.0.28**；獨立服務 PID **39711**，測試後已停止。
- 來源 session：`ses_ed95147f0ffelZl7Ao33U13pgU`。
- 測試前唯讀確認來源 model：`openai/gpt-6.1-sol#high`；本次沿用。
- SG：`active`，共 95 plugins；使用修正後的 `dist`。
- Guard SHA-256：`7d621101a223497a17f7340746b283c6318ddd2566c958068cac6142e8177d3a`，前後不變。
- Options：transparent、wire=false、attachments=block、persistence=false；沿用既有 guard YAML，沒有使用真實 Keychain。
- 暫存 fixture：`$TMPDIR/opencode/sg-live-capacity-20261014/opencode.json`。
- V2 permissions 設 action/resource `*` deny，另加 test-only `execute.before` 拒絕所有工具操作；不移除 tool schema，以免改變需要驗證的 request 結構。
- 兩案僅要求精確回固定 marker，不續做開發、不執行工具。Fork 保留為本機驗證對話；沒有修改原 session 的歷史。

```sh
OPENCODE_BIN="$(command -v opencode)" \
node scripts/diagnostics/retest-installed-plugin.mjs \
  --plugin-config $TMPDIR/opencode/sg-live-capacity-20261014/opencode.json \
  --source-session ses_ed95147f0ffelZl7Ao33U13pgU \
  --model 'openai/gpt-6.1-sol#high'
```

### 結果

| 案例 | exit | 精確 marker | 準備拒絕 | error events | tool events | 結果 |
|---|---|---|---|---|---|---|
| short-new-session | 0 | 是 | 否 | 0 | 0 | PASS |
| source-history-fork | 1 | 否 | 否 | 1 | 0 | FAIL |

- 短對話：`ses_ec676c419ffeTaYWZceSo1Vs3o`。
- 歷史分叉：`ses_ec676a44cffe86NQrH9M2hh0Nq`；其 fork metadata 指回上述來源。
- Runner 整體 exit **1**，沒有把短對話成功當成整體通過。
- 新增準備拒絕數 **0**；未觀察到新的 stage/reason 準備拒絕。
- 唯讀檢查分叉 stored error，取得 `invalid_encrypted_content`／400；不保存原始 provider error、密文或模型全文。
- `wsDegradationObserved` 為通用 WARN prefix 偵測，不能單靠它判定 WS 根因。

來源歷史持續演進，stored context 本次為 109 items、約 1.39 MB；不是 10 月 11 日完全固定的 message-boundary A/B，也不是實際 content-hook request 投影。不能單用 stored context 的大小判定 operation budget 或真實 request token 數。

## 2. Native host 的正式刪除回收

新增可重跑的 credential-free runner：

```sh
node scripts/diagnostics/verify-native-session-lifecycle.mjs
```

Test-only plugin：`scripts/diagnostics/session-lifecycle-plugin/`。Runner 使用唯一私有暫存目錄、隔離 HOME／XDG、隨機本機服務認證及 localhost；不繼承使用者 provider 憑證、OPENCODE_DB 或全域設定。

### 驗證 seam

- 實際 host API 建立 **3 個**本輪測試 session，實際 `ctx.session.remove` 刪除其中一個。
- Guard 使用修正版 `dist` 及真正的 `ctx.event.subscribe`；直接呼叫已註冊的 guard content／tool-planning／WS callbacks 注入合成資料，不呼叫 prompt/generate 或真正的 tool executor。
- 用合成 hook scopes 填滿 4,096-session guard capacity，而不是建立 4,096 個 host DB sessions。
- 同時緩衝兩個 session 的 split WS placeholder；刪除一個後確認只清該 lane，另一個仍完整還原。

| 驗收 | 結果 |
|---|---|
| Session ceiling 有效，超出時拒絕 | PASS |
| 真實 `session.deleted` delivered | PASS |
| 刪除 session 的 memory-only mapping 不再還原 | PASS |
| 其 WS lane／held prefix 清除，其他 session 保留 | PASS |
| 刪除後能使用釋出的容量，不 evict live mapping | PASS |
| 本輪 3 個 host test sessions 清理完成 | PASS |
| Model dispatch／實際 tool execution | 0／0 |
| 私有服務停止、compiled guard 前後一致 | PASS |

第一次 driver 因立即檢查 plugin list、未等待載入而得到 `verification_plugin_inactive`；加入 bounded readiness polling 後通過。這是 runner readiness 問題，不冒充 production guard 的修正。

成功結果：

- `sg-native-lifecycle-snGVHl/summary.json`，PID **43226**，exit 0。
- 再次驗證：`sg-native-lifecycle-lht4Hl/summary.json`，PID **46871**，exit 0。
- 兩個目錄都位於批准的 `$TMPDIR/opencode/`。

這補足的是實際事件 delivery 與回收 seam，不是長期壓力測試、所有 model 的 lifecycle，或真實 model tool execution 全矩陣。

## 3. 新的 opaque reasoning integrity red

### 私有資料的離線檢查

只在 subprocess 記憶體處理分叉 stored context，取出 77 個已知 encrypted-state 欄位；沒有輸出或寫入密文／原文。

- Stored encrypted fields 本身沒有 placeholder prefix。
- 相同 scanner profile 的 core 逐欄 probe：76 個 unchanged、1 個 changed、0 refused。
- 公開 content-hook 的離線 reasoning-metadata 投影也得到相同 1 個 `API_KEY` 改寫結果。這個投影不是當次 real dispatch snapshot，所以不據此斷言唯一實機根因。

### 不含真實密文的可重跑最小 probe

```sh
node scripts/diagnostics/verify-opaque-reasoning-integrity.mjs
```

這個 script 只建立合成 encrypted-state-shaped bytes，插入會誤匹配 detector 的合成 span；**不是經認證的真實 ciphertext，也不提交給 provider**。透過公開 `session:context` hook 驗證 native reasoning `encrypted`、provider metadata 應保持完整，並以合成 email 確認 plaintext 仍應遮罩。

原生欄位來源已核對已安裝 SDK：`@opencode/ai/dist/schema/messages.d.ts` 的 `ReasoningPart` 定義具有 `type: reasoning`、`text`、`encrypted` 與 `providerMetadata`。

目前結果：

| 斷言 | 結果 |
|---|---|
| 原生 `encrypted` byte-preserved | **FAIL** |
| Provider metadata encrypted state preserved | **FAIL** |
| Plaintext canary masked | PASS |
| Model dispatch／實際工具執行 | 0／0 |

Script exit **1**；已重跑確認 deterministic red。它不包含在 `npm test` 的既有 unit suite 中，因此 **946 unit tests passed 不等於本輪所有驗收通過**。

### 建議下一步

1. 在正確的 trusted provider-state／native reasoning seam 建立正式 failing regression，再修正 opaque state 的完整性處理。
2. 不能只因 key 叫 `encrypted`／`encrypted_content` 就跳過任意內容掃描；需限定可信的 provenance、protocol position 與 shape，並測試假冒 opaque state、混合 plaintext、reasoning／compaction 等情境。Plaintext protection 與安全拒絕仍須成立。
3. 本地 native／AI SDK／HTTP／WS 路徑先 green，再用受保護的原歷史分叉重測。不要用關閉 SG、放行原文或刪除原歷史來製造 green。
4. 若 opaque integrity 修正後 real fork 仍 `invalid_encrypted_content`，再檢查 provider/account/model binding 與 host replay／serialization；不要預先把任一候選當成根因。

本輪止於驗證與最小 red-capable probe，**沒有擅自新增 opaque bypass 或改動 production 保護政策**。

## 4. 環境與檢查

- 全域設定前後 SHA-256：`13c9ba6fc3078a3251ccaddd38f8850deab52e72ab64a04567db58659125a765`；SG 全域 registration 仍為 0。
- Guard 編譯 SHA-256 同前；本輪未改 production code、build 或部署。
- 私有 PIDs **39711／42712／43226／46871** 均已停止；沒有停止或重啟共用服務。
- `npm test`：**43 files／946 tests passed**。
- `npx tsc --noEmit`、diagnostic JS syntax checks、`git diff --check` 通過。
- Opaque integrity probe **仍 red**，須與 unit-suite green 分開看。
- 沒有 commit／push，沒有真實 Keychain／新的 persistence opt-in。

診斷 artifact 只記 metadata／counts／static codes；沒有額外封存 prompt、模型全文、密文或 auth。OpenCode 的本機測試分叉仍使用正常 session-history 儲存機制，不是「完全不落盤」的宣告。
