# 透明模式容量與生命週期

> 🌐 [English](./capacity.md) | 繁體中文

[← README](../../README.zh-TW.md#opencode-plugin建議使用)

guard 每次遮罩／還原操作使用輸入＋輸出合計 8 Mi UTF-16 units、100,000 個 value nodes 的有限預算，不再把 standalone core 的 1 Mi-unit 小預算套在整份歷史。HTTP body／WS frame 仍限 4 MiB；scanner `max_chars`、深度 32、mapping entry 與總記憶體預算仍檢查。每個 guard 最多保留 4,096 個 session，不用 LRU 任意丟棄仍可續用的 mapping。

正式 V2 `session.deleted` 事件只回收該 session 的 RAM、回覆準備證明及 WS 緩衝；idle、完成或中斷不視為刪除。缺少／失敗的事件訂閱會保留 mapping 到 unload，因此不是無限期不限容量。刪除事件不抹除加密持久化資料，仍由 TTL／明確 `forget` 管理。

[本地驗證與實機限制](../evidence/2026-10-14-transparent-capacity-verification.md)。
