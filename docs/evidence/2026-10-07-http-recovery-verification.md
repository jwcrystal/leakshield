# HTTP 相容性恢復：本地驗證與剩餘限制

整理日期：2026-10-07。Host：OpenCode v2.0.24。

## 根因與修正界線

初次 C19 失敗不是已證明的 Responses stream 解析缺陷。隔離診斷取得的 nested cause 明確為 `experimental.ws.handshake` 拒絕；僅被 capture 的請求來自 title，不能證明主對話成功。

OpenCode 的 provider config 在外部 plugin transform 之後套用。初次 C19 明確配置 `transport: websocket`，覆蓋 plugin 的 HTTP preference；guard 正確拒絕了主對話。`model.request` 與 model settings 沒有已證明可用的 transport override，未使用延後註冊或臆造欄位繞過契約。

保留修法：transparent mode 為 native OpenAI provider 註冊可卸載 HTTP preference，不修改 endpoint／credential／持久化設定。**這不是強制覆寫：明確 WS config 仍優先，使用者需將該 provider 的 transport 改成 HTTP；本次未修改全域設定。**

## 本次變更

- `src/opencode-transparent.ts`：拒絕錯誤增加固定 hook identifier；WS 錯誤提供 HTTP 設定指引。不包含事件內容，沒有放寬拒絕。
- `src/opencode.ts`：保留 native OpenAI HTTP preference、cleanup／失敗 fallback；補明確 config 優先的限制。
- `scripts/e2e/run-boundary.mjs`：C19 必須有正常退出、帶 token 的主請求與顯示還原，不能以 title-only capture 或 `observe` 通過；分開明確 WS 拒絕與 built-in OpenAI identity 測試。
- `scripts/e2e/result-status.mjs`、`tests/e2e-result-status.test.ts`：assertion `fail` 與 runner `error` 均回非零；避免 CI 假綠。
- `tests/opencode-transparent.test.ts`：固定安全診斷與 Foundation／agenda 真實 request protection 管線回歸，另有 standalone NDA 正向控制。
- `tests/config.test.ts`：允許合法的空 NDA 陣列；既有缺省 fallback 測試仍驗證內建 NDA 值。

未更改回覆 adapter、mapping 儲存架構、其他協定或 proxy。

## 驗證結果

- 全套：**30 files、644 tests passed**。
- `npx tsc --noEmit`：通過。
- `npm run build`：通過；dist 已重建。未重啟使用者的背景服務。
- Reviewer 確认主失敗歸因與 config precedence；最終 diff review 指出的 runner-error gate 問題已修正並加測試。

隔離本地 capture E2E：

| 案例 | 結果 | 能證明的範圍 |
|---|---|---|
| C12-transparent-resume | pass，兩次 process invocation | 指定 fixture 的重啟續聊／重新遮罩成功；不能外推到所有含舊 token 的 history |
| C13-transparent-restore | pass | 本機 read tool 正確收到原始路徑 |
| C15-retry-cut-stream | pass，但 child exit 1 | 兩次主請求重試均遮罩；**不是完整回覆成功** |
| C17-reply-restore | pass | 指定文字回覆還原 |
| C18-anthropic-transparent | pass | Anthropic native fixture 往返 |
| C19-responses-transparent | pass，child exit 0 | HTTP Responses 主請求與顯示還原 |
| C19-ws-refused | pass，child exit 1（預期） | 明確 WS config 被識別並拒絕，無主請求外送 |
| C19-native-openai | pass，child exit 0 | built-in OpenAI identity、synthetic key／local endpoint 往返，不是真實帳號認證驗證 |

八案例 provider captures 均無 raw canary 洩漏，log canary hits 為零。本機 storage 包含原文 canary，符合已選「本機留原文」方向，不等同已證明所有 token／reasoning／tool parts 均正確持久化。

最終八案例原始 evidence：
`$TMPDIR/opencode/sg-stability-verification-1791302886162/out/evidence.json`

上述八案例是在最後的 runner-error exit helper 修正前執行；helper 隨後由五個單元案例驗證。測試使用隔離 work/output 路徑；原 repo 的舊 output 與失敗證據未被覆寫。Temp raw evidence 不保證永久保留，本文保存導出結論。

## 未完成驗收

1. 真實 OpenAI API key 與 ChatGPT 訂閱認證；不能以 local synthetic key 代替。
2. reasoning／工具參數／hosted tools 的完整 UI 與 history 還原因果追蹤。
3. history 曾含舊 token、檔案變動、provider continuation state、fork／revert 的無感重啟驗收。
4. 傳輸中斷重試後仍完成回覆，而不僅 request 遮罩。
5. AI SDK 全面拒絕是否過度：source 有受控 HTTP middleware，但未擴大支援或取消守門。

因此狀態是 **HTTP 本地恢復與驗收 gate 完成，完整穩定替代尚未完成**。後續按 [stability plan](2026-10-06-stability-fix-plan.md) 推進，不以 hooks-only 或靜默放行替代驗收。
