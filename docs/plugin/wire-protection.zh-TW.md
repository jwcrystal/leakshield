# Wire 保護

> 🌐 [English](./wire-protection.md) | 繁體中文

[← OpenCode plugin](../opencode.zh-TW.md)

## Hook-only

新 transparent 安裝可使用 [hook-first 範本](../../config/opencode.hook-first.example.json)，明確設 `wireProtection: false`。保留 system/messages/options/tools 遮罩與工具安全還原；**不註冊出站 HTTP request、WS handshake/send 或 AI SDK admission hooks**，不檢查 transport metadata、不改 provider transport 設定。未知路線與 SDK 私有傳輸不會因 LeakShield 傳輸門檻被擋。

選擇性入站 HTTP／WS hooks 依同 session/kind/model 的成功準備還原支援的顯示文字；缺 hook 或還原失敗只保留 literal，不停用輸入保護。後續新增內容／附件可能未遮罩，`doctor` 仍顯示 `PARTIAL`。**Hook 內無法遮罩的輸入仍拒絕該次請求**，並附安全的 `[stage=prepare.mask reason=…]`；不是靜默放行原文。

[本輪驗證](../evidence/2026-10-11-pure-hook-only-verification.md)。

## Final wire 保護

設定 `wireProtection: true` 會額外驗證／重新遮罩最終的 HTTP 請求 body 或支援的 WS 出站 frame 內容；未知路線與未知或混合的 body 形狀會在送出前拒絕。兩種層級的工具安全與回覆端復原相同。只有 hook-first 範本明確選擇 false。此選項僅在 transparent 模式有效。

true 增加 final-wire 與傳輸守門；省略 wire 仍為 true，所以 v2 預設（`mode: "transparent"`、不設 `wireProtection`）就是這個較強的層級。

## AI SDK provider

true 要求 SDK 使用 OpenCode 注入的 `options.fetch`，以 request-scoped HTTP hooks 提供歸屬與 wire 保護，不依 provider 品牌設 allowlist。Wrapper 檢查 HTTP／HTTPS、支援路徑；缺 fetch、accessor／proxy 或不可寫設定拒絕。false 不註冊 SDK wrapper，不要求 injected fetch，只保留 content/tool hooks 與可選入站還原。

私有傳輸不在 final-wire 覆蓋內，也不保證被擋。Commandcode 的 Go／403 fallback `/alpha/generate` 在 false 不受 LeakShield 傳輸守門，true 仍拒絕；沒有 legacy 回覆 adapter。參數、abort 與真實 provider 錯誤維持 host 行為。

## Wire 拒絕

Wire 模式的 wrapper 把自身拒絕表示為 **本地 HTTP 400 錯誤回覆**，附 `error.code: "leakshield_transport_refusal"` 與不含原值的 WARN；被拒請求不外送。Hook-only 沒有此 wrapper 或傳輸 admission。真正網路錯誤、abort 與 provider 回覆不改，也不捏造 provider 成功。

Responses easy-input 可省略 `type: "message"`，不擅自補 type。

## 回覆端復原

兩種層級共通。

LeakShield 的歸屬、JSON／SSE／WS 還原或解析失敗會停止 LeakShield 改寫，不再因此阻斷 host 回覆；不猜其他 session／model 的 mapping。SSE 以有界交易保留尚未送出的原始 events，失敗後按原順序釋出並接續原 bytes，不重送已發內容、不丟 held tails。Provider error event 立即傳遞，來源錯誤與 consumer cancel 仍生效。

使用者可能看到 placeholder，壞掉的 provider 資料仍可能被 OpenCode 拒絕。WS 只能取代單一 frame，不能重播多 channel；限制見 [降級驗證](../evidence/2026-10-11-experience-first-verification.md)。工具防線不隨回覆降級解除。

## Native OpenAI 傳輸

wire 模式保留 native OpenAI provider 的 HTTP 偏好；明確的 provider 設定優先。Hook-only 不轉換 provider 傳輸。支援的 Responses-family WS 入站可在不註冊 LeakShield handshake／send 的情況下還原顯示 delta，從同一 session／kind／model 範圍內通過驗證的 `response.created` 開始。

不會變更 endpoint、憑證或持久設定。真實訂閱驗證與完整重啟復原，不在本機擷取證據的涵蓋範圍內。
