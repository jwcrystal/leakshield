# Native WebSocket（experimental）

> 🌐 [English](./websocket.md) | 繁體中文

[← README](../../README.zh-TW.md#opencode-plugin建議使用)

僅限 Responses-family。

支援 `/responses` 的 `ws:`／`wss:` 與 flat `response.create`，按協定形狀而非 OpenAI 品牌限制。出站共用 HTTP Responses masker；入站支援跨 frame 顯示文字還原，工具參數保留 token 給本機 tool gate，encrypted reasoning 與 continuation ID 不亂改。不同協定／extensions 不自動視為相容。

Host 沒有 connection ID，狀態按 session、請求種類、模型，再按 response ID 與內容 channel 隔離；新 handshake／模型切換、HTTP fallback、拒絕 frame 與 dispose 清除舊狀態，terminal 清除緩衝，並限制 frame／channel／總緩衝大小。若 provider 缺最後一個文字 delta，保留並還原 `.done` 完整欄位、顯示固定警告，不擅自改成 delta；只讀 delta 的 consumer 可能顯示不完整。未知顯示 token 保持 literal，不因此中斷回答；不安全或未知寫入映射仍拒絕。

原有 native OpenAI HTTP preference 為相容性保留，明確 WS 設定現在可走支援路線。這不是系統網路防火牆或所有 WS provider 的支援承諾。[驗證與限制](../evidence/2026-10-11-responses-ws-verification.md)。
