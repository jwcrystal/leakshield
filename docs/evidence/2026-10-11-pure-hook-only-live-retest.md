# 純 hook-only 修正版：再次載入實機測試

日期：2026-10-11。使用者要求「加入 plugin 測試」。正式測試 `15:47:03.566Z–15:47:10.629Z`（UTC）。只在獨立服務載入 SG；未重啟共用服務。

## 結論

**修正版 SG 確實 active。新短對話通過；既有歷史分叉仍拒絕，但這次取得實際原因 `prepare.mask / operation_limit`。沒有寫回全域設定。**

這次確認的是「遮罩交易的操作預算拒絕」，不是 wire/transport admission、插件載入失敗或模型額度錯誤。原因代碼傳遞已生效；模式修正沒有自動解除這個 content-hook 限制。

`operation_limit` 同時用於深度、節點數及字串處理／輸出增長預算，現有代碼沒有再細分。本輪尚未最小化或判定具體哪項計數超限，不能只說「對話字數太長」。這個新結果也不能追溯證明之前所有同型錯誤都由同一原因造成。

## 載入與版本證據

- Host：OpenCode **v2.0.25**，獨立服務 PID **4086**；API 回傳 PID 與啟動程序一致。
- `/api/plugin`：**92 plugins**，`sensitive-guard` 狀態 **active**。
- Plugin entry：`<repo>/dist`，是 V2 可載入的目錄，不是 JS 檔案路徑。
- 編譯 guard SHA-256：`1f3573c204ffdee34b73af2d381305635c3ace3a8a480cff21d0721f62511b4e`，測試前後一致；含純 hook-only 註冊與安全 reason/stage 修正。
- 設定：transparent／wire=false／attachments=block／persistence=false；既有 guard YAML 未改，未啟用 Keychain。
- 本次模型：**openai/gpt-6.1-sol#high**，依測試前來源 session 的目前設定。上次歷史測試用 max；不是完全固定的版本／上下文 A/B。
- 使用既有全域 providers／認證與 managed plugins；只由明確暫存 config 在獨立服務追加 SG，不改它們。

## 模型測試

命令：

```sh
node scripts/diagnostics/retest-installed-plugin.mjs \
  --plugin-config $TMPDIR/opencode/sg-live-retest-20261011T143100/opencode.json \
  --source-session ses_ed95147f0ffelZl7Ao33U13pgU \
  --model 'openai/gpt-6.1-sol#high'
```

兩案都要求只回固定 marker，不使用工具、不執行命令、不改檔案。歷史案用 `--fork`，不接續或修改原 session。

| 案例 | exit | 精確 marker | SG 準備拒絕 | error events | tool events |
|---|---|---|---|---|---|
| short-new-session | 0 | 是 | 否 | 0 | 0 |
| source-history-fork | 1 | 否 | 是 | 1 | 0 |

- 短對話 session：`ses_ed45a9021ffekonqWGCXIHhleM`。
- 分叉 session：`ses_ed45a7cd3ffekIpiKsglVExIdS`。
- 整體 runner exit **1**；沒有把短對話通過當成整體成功。
- 新增準備拒絕 **1**，主 log 總數由 4 增至 5。
- Runner 的 `wsDegradationObserved=true` 是偵測通用 `[sensitive-guard] degraded:` prefix，不足以單獨證明 WS 失敗；不據此判定本次拒絕原因或完整還原能力。

## 安全錯誤訊號

主日誌 `~/.local/share/opencode/log/opencode.log` 在 **`2026-10-11T15:47:10.516Z`**（UTC+8：23:47:10.516）出現：

```text
Sensitive Guard transparent mode failed to protect a model request. [stage=prepare.mask reason=operation_limit]
```

Stack 指向目前編譯的 `opencode-transparent.js`。沒有巢狀原始 cause，也不需要原始 exception 才能確認這個受控 reason。只記錄時間／stage／reason／fingerprint，未保存 prompt、模型原始輸出、認證或偵測原值。

## 最終環境與範圍

- 獨立服務 **4086 已停止**，兩個測試 CLI 已結束。
- 共用服務 **10248／13902** 仍在；沒有 reload/restart/stop。
- 全域 SG registration **0**，設定 mode **0600**。
- 全域 JSON 前後 SHA-256 都是 `0a1b52cbe9d4548150486a243666393d5a8a0f6f5301a2d876a05d0f2a673eae`；本輪沒有改全域設定或其他插件。
- 原 session 歷史持續演進、分叉使用新 session 與新的 memory mapping；本輪只確認這次分叉的實際失敗代碼，不唯一還原最早症狀的全部環境。
- 沒有因這次結果調高限制、改拒絕政策或放行原文；沒有新增 production code／instrumentation、commit 或 push。
- 這是實機可用性重測，不是出站敏感值捕獲、完整工具還原、安全或所有 provider 的驗收。

下一步可沿這個實機 red 最小化操作預算問題，細分是哪個計數限制；不應直接取消限制或宣稱全域已可用。相關：[純 hook-only 修正與本地驗證](2026-10-11-pure-hook-only-verification.md)、[上次實機歷史 red](2026-10-11-live-long-context-retest.md)。
