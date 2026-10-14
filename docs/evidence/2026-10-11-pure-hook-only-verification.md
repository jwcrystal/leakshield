# 純 hook-only 修正與驗證

日期：2026-10-11。使用者以「OK 修正」批准 wire=false 的契約修正。範圍：目前未提交工作樹；全域 SG 維持停用，不是發布或日常環境通過的聲明。

## 結論

**`wireProtection: false` 已改為真正的 hook-only：保留 content 遮罩、工具安全還原、可選入站顯示還原；不再掛出站傳輸守門。true 與省略值保留 wire 保護。**

> 後續經使用者授權已再次實機載入修正版：短對話通過、歷史分叉仍拒絕，取得實際 `prepare.mask / operation_limit`。測試服務已停止，全域未重新啟用，見 [新實機重測](2026-10-11-pure-hook-only-live-retest.md)。以下「尚未重跑」敘述是本地修正完成時點的狀態。

與 EightDoor V2 對齊的是「content/tool hooks＋best-effort response hooks」的分層，不是照抄已知遮罩缺口或保證完全同等體驗。原始歷史分叉的 hook 遮罩拒絕仍是另一個問題，不能因模式測試通過就宣稱已修復。

## 契約與實作

| 項目 | false | true／省略 |
|---|---|---|
| context/title/generate/compaction 遮罩 | 保留 | 保留 |
| 工具安全還原 | 保留；未知 write/shell mapping 仍拒絕 | 同左 |
| HTTP request hook | 不註冊 | final-wire remask＋metadata/route 檢查 |
| WS handshake/send hooks | 不註冊 | 保留入場與 frame 檢查 |
| AI SDK admission／injected fetch 要求 | 不註冊、不要求 | 保留 |
| native OpenAI HTTP preference transform | 不註冊、不改 provider transport | 保留 |
| HTTP response／WS receive | 可選、best-effort；缺 hook 不停用 content/tool hooks | 保留既有 wire 模式註冊要求 |
| 初始化失敗 | content/tool fail-closed；不增加傳輸 hooks | 全套 fail-closed fallback |
| doctor | `PARTIAL`，明示無傳輸層覆蓋 | 保留安裝級狀態；不等於 live-session 驗收 |

入站還原仍要求同 session／named-kind／provider-model 的成功準備。**這個證明只用於選 mapping，不是出站放行條件。** HTTP 不再依賴 SG 的 Request object attribution；WS 由 host scope 與 `response.created` 建立有界 response/channel state，不要求 SG handshake/send。無法驗證或解析時留 literal，不跨 session/model 猜還原。

Hook 遮罩仍是原子交易；沒有原文 fallback。`protectJsonForModel` 的 typed failure 現在保留為：

```text
Sensitive Guard transparent mode failed to protect a model request. [stage=prepare.mask reason=<controlled-code>]
```

只有 core 的受控原因代碼，不含 prompt、檔案內容、偵測原值或原始 exception。這是診斷修正，不是解除所有 input 拒絕。

## Red → green 與單元驗證

新增 [`tests/opencode-transparent-hook-only.test.ts`](../../tests/opencode-transparent-hook-only.test.ts)。修改 production code 前，11 案有 **8 failed／3 passed**：捕捉仍要求 aisdk、出站守門、可選 hook 註冊拖垮 guard、無出站 registration 無法還原、reason 遺失等具體症狀。

之後另加 fail-closed fallback 與入口 provider-transform 回歸，先驗證兩案失敗再修正。最終新檔 **18 tests passed**，另有入口回歸；涵蓋缺 event.kind 的四種入站 scope、舊 WS frame 失效與跨 session mapping 隔離。大型合成歷史會得到 `operation_limit`，輸入未部分發布。測試不將「不拋錯」當作遮罩或工具正確性。

更新舊 false 測試為 host emission：沒有註冊的出站 hooks 留原事件，而不是偽造 admission callback；新測試直接斷言註冊集合與 false 不需 aisdk/provider API。true 的路線、metadata、SDK、工具防線回歸保留。

```sh
npx vitest run
npx tsc --noEmit
npx tsc
```

最終 **42 test files／933 tests passed**，TypeScript 與編譯通過；`git diff --check` 與文件本地連結檢查通過。未執行會清除整個 dist 的 clean/build 步驟；直接編譯，避免移除既有工作。

## Native OpenCode v2.0.25：合成 HTTP／WS 工具驗證

以現有 [`scripts/e2e/run-responses-ws.mjs`](../../scripts/e2e/run-responses-ws.mjs) 跑正常／遺失 WS send registration 兩組，均為 isolated HOME/XDG＋loopback 合成 provider，沒有真實認證或模型呼叫。每組 HTTP/WS × false/true，**共 8 案全通過**：

- 每案四個成功 primary requests，工具 continuation 存在。
- 所有 capture 不含測試 email/env 原值。
- write/read/quoted-shell 的產物符合精確 bytes；不是只看 exit 0。
- WS 每案使用同一連線，沒有報告 missing-attribution refusal。
- false 在缺 send hook 時仍還原顯示；true 的同型故障則保留 literal、完成工具流程，不假裝還原成功。

本機保存的結果：

- 正常：`$TMPDIR/opencode/sg-ws-tools-koQzvZ/summary.json`
- 故障：`$TMPDIR/opencode/sg-ws-tools-k0VBU9/summary.json`

Runner 的故障期待已更新：false 沒有 send hook 是正常模式，不再預期其顯示降級；true 仍測 send lifecycle fault。先前另跑同樣 8 案於暫存 sandbox 也通過，未重複計入不同覆蓋。

## 歷史拒絕：離線診斷訊號，不冒充根因已修好

本輪只讀既有服務的 `/api/session/<source>/context`，沒有續寫對話、fork 或模型派送。取得 52 個 stored context items，序列化約 786 KB；資料只在 subprocess 記憶體，不印出、不存入 repo。

把**stored context 原始結構**交給相同 core，得到 **`operation_limit`**。這支持操作預算是候選原因，但 stored SessionMessage 還帶 model/providerState/recent 等 metadata，**不是實際 context-hook 的 AI request 投影**，不能唯一對應先前那次失敗。沒有因此提高預算或放行原文。

一般 pipe 下 CLI 的大 JSON 輸出只收到 393216 bytes 而無法 parse，改用 PTY 收到完整 JSON；只以 parse 成功的資料做上述判別。沒有編輯資料庫或全域設定。

**尚未重新跑原始真實模型歷史分叉；未證明它 green。** 下一次經授權的派送才能從新 reason/stage 確認實際失敗條件，再最小化處理；既有 [實機 red](2026-10-11-live-long-context-retest.md) 仍是有效症狀證據。

## 環境與影響

- 本輪未寫入全域設定、未重新啟用 SG、未 reload/restart 共用服務、未啟用 persistence／Keychain，未 commit/push。
- 最終全域 SG registration **0**、mode **0600**；服務 **10248／13902** 仍在，啟動時間未變。
- 最後設定 hash 為 `0a1b52cbe9d4548150486a243666393d5a8a0f6f5301a2d876a05d0f2a673eae`，不同於先前歷史重測快照。變動來源未判定，本輪沒有回復或改寫這些使用者／外部變動。
- 影響盤點：guard 由 V2 setup 呼叫，影響透明模式的所有 content、HTTP/WS、SDK 與工具測試；provider/fallback 改動風險 HIGH，doctor 說明 LOW。GitNexus MCP/CLI/index 不可用，逐一嘗試 impact runner 失敗後採本地 upstream callsite 盤點，已先告知風險。
- README／中文 README／options／spec／doctor 同步新契約。前一階段 scoped outbound policy 是歷史快照，已被本輪契約取代。
