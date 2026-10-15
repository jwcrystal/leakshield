# OpenCode wire 情境與 sensitive-guard 支援清單

日期：2026-10-06。基準：OpenCode **v2.0.24**，commit `e7a34f09bfd9134dfade5a8ddb843f7030bc9a69`。

用途：決定相容性與驗收範圍，不代表所有列出的能力都要立即實作。本文僅盤點 source／官方契約；未新增實際模型呼叫或 runtime 覆蓋證據。

更新：後續 [HTTP 本地驗證](2026-10-07-http-recovery-verification.md) 已通過 C19 與 built-in OpenAI identity 往返；真實認證、完整 history 恢復及新 wire 支援仍未完成。

2026-10-11 更新：此表為 v2.0.24 的歷史盤點，不是目前支援表。Responses-family WS、SDK injected HTTP fetch 及 [體驗優先回覆／hook-only 降級](2026-10-11-experience-first-verification.md)已新增；未知私有 transport 仍不在可保證覆蓋內。

## 1. 先分清三個軸

- **執行入口**：native driver 或 AI SDK。
- **Transport**：HTTP 或 WebSocket。
- **Wire 協定**：Responses、Chat Completions、Anthropic Messages、Gemini 等。

AI SDK 不是一種 wire 協定。相同 HTTP transport 可以承載不同協定；相同 Responses 協定也可以走 HTTP 或 WS。支援一個軸，不等於另外兩個軸已支援。

## 2. Transport／執行入口清單

| ID | OpenCode 情境 | 必須保護的位置 | Guard 現況／下一步 |
|---|---|---|---|
| T1 | Native HTTP 模型請求 | `http.request` 最終 body；`http.response` 消費前回覆 | 已有三種 wire adapters；GPT local capture 往返已通過，真實認證待驗 |
| T2 | AI SDK 使用 OpenCode 提供的 fetch | request-scoped HTTP middleware → 實際 fetch | **source 有接入機制**；目前 guard 在 SDK 初始化 hooks 全面拒絕。需驗證 middleware 覆蓋，不能僅據 SDK 名稱拒絕或放行 |
| T3 | AI SDK／custom provider 另用內部 transport | 實際外送點，不是單純 SDK 初始化 | 不保證使用 injected fetch；若要支援，須逐實作追蹤。不明路線仍拒絕 |
| T4 | Native WebSocket | `experimental.ws.handshake`、`send`、`receive` | HTTP hooks 看不到 WS frames；目前拒絕。優先評估導向已受保護 HTTP，而非立即新增 WS adapter |
| T5 | WS 重用連線、續接、失敗 fallback 到 HTTP | 每次 frame、狀態關聯，以及 fallback 的 HTTP request | 不能只掃 handshake；需獨立測試。官方契約說 HTTP fallback 仍執行 HTTP hooks |

**重要更正**：v2.0.24 `aisdk.ts` 保存 custom fetch，注入 `options.fetch`，並以 AsyncLocalStorage 取得當次 HTTP middleware。當 middleware 存在時，先經 `throughMiddleware` 再呼叫 underlying fetch。這推翻「AI SDK 必然完全繞過 HTTP hooks」的概括；但不是所有 SDK 呼叫／協定均已驗證的證明。[S2]

Native OpenAI 預設 transport 為 WebSocket；所以 native GPT 的拒絕可能是 WS 守門，不能從共用錯誤訊息直接斷言 AI SDK。[S3]

## 3. Wire 協定清單

下列是 v2.0.24 原生 protocol module 清單的分組，不把每個 provider 品牌當成新協定。模組存在不代表 CLI 每個流程都使用它，也不代表 guard 已驗證相容。[S1]

| ID | 協定／變體 | Wire 特徵 | Guard 狀態 |
|---|---|---|---|
| P1 | OpenAI Chat／OpenAI-compatible Chat Completions | `/chat/completions`，JSON／SSE，choices、tool calls | 已有 adapter；不同 provider extensions 仍需驗證 |
| P2 | OpenAI Responses | `/responses`，typed events、reasoning、tool output items；可有 WS route | HTTP local C19 已過關；真實 GPT 認證／完整迴路待驗，WS 未支援 |
| P3 | Anthropic Messages | `/messages`，system、content blocks、tool_use／tool_result、SSE | 已有 adapter；不能外推到所有 Anthropic-compatible 服務 |
| P4 | Open Responses／OpenAI-compatible Responses／xAI Responses | Responses 類結構，但 provider extensions、hosted tools、state 可能不同 | 不可只憑 `/responses` URL 宣稱支援；需 fixture 與 consumer 驗證。`OpenResponsesChannel` 是相關 WS channel 實作 |
| P5 | Gemini | `streamGenerateContent?alt=sse`，contents、parts、systemInstruction 等不同欄位 | 尚無對應 guard adapter |
| P6 | Google Interactions | `/interactions`，獨立 request／event schema | 尚無對應 guard adapter；不可混同 Gemini |
| P7 | Bedrock Converse | `/model/{modelId}/converse-stream`；AWS event-stream framing 與簽名認證 | 尚無對應 adapter；不是普通 SSE，改 body 時還要確認簽名順序 |
| P8 | Cohere Chat | `/chat`，獨立事件／內容結構 | 尚無對應 guard adapter |
| P9 | Mistral Chat | `/chat/completions`，SSE，但有獨立 protocol 實作 | URL 相同不等於完全相容；需驗證變體，不先宣称既有 adapter 全涵蓋 |
| P10 | 圖片／其他媒體模型路線 | 原生索引包含 OpenAI Images；另有媒體相關模組 | 屬延伸範圍，非文字聊天三協定保證；按實際使用需求另訂附件／二進位政策 |
| P11 | 其他 AI SDK provider 協定 | 可能走可攔截 HTTP，但 schema／framing 依 SDK 而定 | SDK 覆蓋不等於 payload 覆蓋，須逐一分類 |

## 4. 每個支援組合都要覆蓋的生命週期

這些不是新協定，而是可能再次發送內容的情境。

| 情境 | 驗收要求 |
|---|---|
| Primary 主對話／多輪 | 每次重播 history 都重新保護；不同 session 不混 mapping |
| Title | 自動標題請求也受保護，不因 small model 不同而漏掃 |
| Compaction | 摘要／壓縮請求與產物後續重播受保護 |
| Generate | plugin/API 暫態模型生成走相同保護邊界 |
| Retry | 斷流、timeout、重新序列化後每次外送仍保護；不能只掃第一次 |
| 路線切換／不同模型 | 若 host／設定觸發切換，要確認新 route／協定仍在支援矩陣中 |
| Tool loop | tool-call arguments、tool results、錯誤訊息、後續 replay 都有明確遮罩／還原策略 |
| Restart／resume／fork／revert | 檢查實際重播內容與 mapping 生命週期；不是僅驗 UI 行為 |

已選設計方向：本機保存原文、mapping 僅存記憶體，重啟後重播時重新遮罩。此方向仍須證明 history 不殘留依賴舊 mapping 的 token，且 provider-side continuation／opaque state 不破壞恢復；不能先宣稱無感接續已成立。

## 5. 每個 adapter 都必須處理的內容／串流情境

- Request：system、messages/input、工具 schema／描述、工具參數、tool results、provider options；結構 identifier 不可隨意改名。
- Response：普通 JSON、SSE 或協定特有事件；文字、reasoning、分段 tool arguments、完成事件、取消與錯誤。
- 串流邊界：token 跨 chunk／event、UTF-8 分割、尾段未完成、done 與 delta 重複資訊。
- 附件：base64、inline bytes、URL／file reference、image/audio/video/document；文字掃描不等於內容掃描。現有 omission／explicit allow 政策需明示。
- Provider state：previous response ID、encrypted reasoning、cache／續接狀態；不可當成普通可還原文字，也不能假設 host 重播了全部原文。
- 認證：API key、OAuth／訂閱、簽名請求分別驗證。認證 header 是正常授權資料，不能用泛用遮罩破壞；驗證 endpoint／credentials 保持正確並避免診斷 log 洩漏。

## 6. 模型 wire 以外的出口：另列，不混進全覆蓋承諾

| 出口 | 為何不同 |
|---|---|
| websearch／webfetch | query、URL、body 可能離開本機；不是模型 HTTP hooks 自動保護的範圍 |
| Remote MCP | tool arguments／結果經 MCP transport；須獨立出口政策 |
| Shell／scripts／外部 process | 工具可自行建立網路連線，模型 wire hook 無法覆蓋 |
| Provider-hosted tools | 在 provider 端執行；工具參數還原與外送政策不同於本機 tool-before |
| SDK 登入、token refresh、模型列表 | 是控制／認證流量，不一定屬模型 request；需隔離，不能全部重寫成對話 body |

本文仍以「OpenCode 模型對話邊界」為本次目標，不因此擴張為整機 DLP。

## 7. 建議支援順序

1. **T1 × P1/P2/P3**：先修通目前三協定，包括 GPT stream、工具與重啟恢復；明列 provider／認證／版本。
2. **T2 × 已驗證協定**：追蹤 SDK middleware 並做實際 capture，評估縮小過度拒絕；不要直接移除所有 SDK 守門。
3. **P4/P9 與實際需要的其他 HTTP 協定**：依實際模型需求逐一補證據，不按 provider 數量盲目擴張。
4. **T4/T5 WS**：若受保護 HTTP 已滿足需求，暫不做；若有必要，再獨立設計 frame 與 state 防護。
5. **媒體／工具外送**：另行定義產品範圍與安全保證，不默認本階段包含。

最終支援矩陣必須是 **入口 × transport × 協定 × 認證 × 生命週期**，不能寫成「加 AI SDK 就支援全部 OpenCode」。

## Source

- [S1] [v2.0.24 原生 protocol exports](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/ai/src/protocols/index.ts#L1-L14)
- [S2] [AI SDK fetch 注入與 HTTP middleware](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/core/src/aisdk.ts#L130-L223)
- [S3] [OpenAI transport 預設](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/core/src/plugin/provider/openai.ts#L259-L264)
- [S4] [Native package rewrite](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/core/src/aisdk-native.ts)
- [S5] [官方 v2 plugin hooks／HTTP／WebSocket 契約](https://opencode.ai/v2/docs/build/plugins)（線上文件，非固定版本 runtime 證据）
- [S6] [Gemini endpoint／SSE](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/ai/src/protocols/gemini.ts#L829-L833)
- [S7] [Bedrock AWS framing](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/ai/src/protocols/bedrock-converse.ts#L814)、[route 與 auth](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/ai/src/protocols/bedrock-converse.ts#L875-L890)
- [S8] [OpenAI-compatible Responses adapter](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/ai/src/protocols/openai-compatible-responses.ts#L9-L20)
- 本 repo 候選修法／失敗證據：GPT handoff（本機筆記，未收錄於 repo）

此盤點補充 [穩定性修正計畫](2026-10-06-stability-fix-plan.md)；不解除首次失敗後的 reviewer gate。
