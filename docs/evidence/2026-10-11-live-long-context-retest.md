# 使用者授權重新載入：實機短對話與長對話分叉

日期：2026-10-11。正式模型重測：`14:35:01.023Z–14:35:10.075Z`（UTC）。範圍：未提交工作樹、OpenCode v2.0.25、既有模型設定與認證。

## 結論

**已在獨立服務載入 SG 並重現同型阻擋。短對話通過，既有長對話的分叉失敗；全域 SG 沒有重新啟用。**

為避免現有對話再被中斷，先做獨立服務的載入與模型驗收，通過才寫回全域。模型測試失敗後，停止測試服務，未改全域設定或原對話；沒有重啟既有服務。SG production code 沒有修改，因此缺失的底層 reason 仍未補上。

## 1. 實際載入及模型

- Host：`/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode`，v2.0.25。
- 獨立服務 PID：**77910**；API 的 PID 與所啟動程序一致。
- 模型：**openai/gpt-6.1-sol#max**，與原對話設定相同；不是本地模型替身或合成 entitlement。
- `/api/plugin`：**92 plugins**，其中 `sensitive-guard` 為 **active**；未把空清單、設定檔有 entry 或 doctor 通過當成載入證明。
- SG 設定：`mode: transparent`、`wireProtection: false`、`attachments: block`、`persistence.enabled: false`。
- `configPath` 使用既有 `~/.config/opencode/sensitive-guard.yaml`；未改其 `max_chars: 200000`，未啟用持久化／Keychain。
- 編譯 guard SHA-256：`024906e8279291e37fdf783ff4fc8e1ad33743b5e27669645086b86bea4e5684`；前後一致。

明確設定檔保留 OpenChamber 原有 managed plugin entries，並追加 SG；全域 providers／plugins 與既有認證照常由 host 使用。沒有儲存認證值、原對話內容或模型原始輸出。

## 2. 模型測試結果

兩案都要求只回固定 marker，不用工具、不執行命令、不改檔案。長對話案使用 CLI 的 `--session … --fork`，不接續或修改原對話。

| 案例 | 驗收結果 | CLI exit | error events | tool events |
|---|---|---|---|---|
| 新短對話 | 精確 marker，通過 | 0 | 0 | 0 |
| 既有長對話的分叉 | 同型 SG 準備拒絕，未產生 marker | 1 | 1 | 0 |

本次正式命令約 **9 秒**，exit **1**。主日誌新增 1 筆同型拒絕，總數由 3 增為 4：

```text
2026-10-11T14:35:09.950Z
Sensitive Guard transparent mode failed to protect a model request.
```

即 UTC+8 的 **22:35:09.950**。編譯 stack 仍指向 `dist/opencode-transparent.js:977:27`，與舊錯誤相同；本次已確認實際載入版本。對照該編譯檔，這一行是 `pseudonymizer.protectJsonForModel(...)` 回傳 `ok: false` 後拋出通用 Error 的分支；對應 `src/opencode-transparent.ts:1024`。

底層結果有 typed `reason`，但這個分支沒有將它帶進 Error／日誌，仍無法得知本次實際原因代碼。**長對話失敗不代表已證明是長度超限；不得推定容量、歷史 token 或其他具體根因。**

這是可重跑的實機症狀，不是根因最小化案例，也不是修復後的 green。沒有新增 production instrumentation 或調整拒絕政策。

## 3. 載入入口的獨立問題

正式模型測試之前，兩次載入檢查均只得到 91 plugins、沒有 SG；未發送模型測試。WARN 明確為：

```text
configured plugin path must be a directory
target=.../sensitive-guard/dist/opencode.js
```

這確認 V2 的 `plugins[].package` 應指向 **`.../sensitive-guard/dist` 目錄**，而不是 `dist/opencode.js` 檔案。該目錄的 `index.js` 預設 re-export `./opencode.js`，不用改 SG source 或 build。

換成目錄後 SG 成為 active，才執行第 2 節的模型測試。檔案入口被忽略與模型請求準備失敗是不同問題；修正載入入口沒有修好長對話拒絕。初次 inline config 嘗試也未取得 SG active 的證明，不能單憑環境變數就認定已載入。

## 4. 可重跑入口

Runner：[`scripts/diagnostics/retest-installed-plugin.mjs`](../../scripts/diagnostics/retest-installed-plugin.mjs)。只新增測試 driver，不改 production guard。

本機明確 fixture：

`$TMPDIR/opencode/sg-live-retest-20261011T143100/opencode.json`

```sh
node scripts/diagnostics/retest-installed-plugin.mjs \
  --plugin-config /absolute/path/to/private/opencode.json \
  --source-session <existing-session-id> \
  --model 'openai/gpt-6.1-sol#max'
```

這條命令會使用既有認證、發送真實模型請求並建立具名測試對話；需要使用者授權。不要用 `--continue` 直接修改日常對話。

Runner 在取得 SG active 與獨立服務 identity 後才測試；檢查 marker、error／tool events 與同型拒絕，不只看 exit code。它只輸出安全 metadata，並在 finally 終止自己啟動的服務。正式失敗案例跑完後另收緊最終 verdict：編譯檔／全域設定前後一致、無新增準備拒絕、服務確實停止，都必須成立才可 pass；尚未因這項 verdict 收緊再次發送模型請求。

暫存 fixture 未封存；來源對話若繼續新增訊息，重跑 fork 的上下文也會變動。尚未固定歷史 message boundary 或完成最小化。

## 5. 最終狀態與限制

- 獨立服務 **77910 已停止**；測試 CLI 也已結束。
- 既有服務 **10248／13902** 仍在，未重啟或停止。
- 全域 SG registration **0**，檔案 mode **0600**、mtime 仍為 `2026-10-11T08:16:05.170Z`。
- 全域設定前後 SHA-256 都是 `a52a3f04dd81796a01b39999e90c71aafb739908ccf09fecc3c883064dcceea8`，既有 provider 差異與其他插件保留。
- 未宣稱日常環境已修好，也沒有因新短對話通過而重新全域啟用。
- 未驗證真實 Anthropic、其他方案、wire=true、工具還原或出站內容捕獲；本次是可用性重現，不是完整安全驗收。

後續應在這個 red-capable 回饋迴圈上取得安全 reason 並最小化，再談修復。先前唯讀日誌盤點見 [停用診斷](2026-10-11-global-removal-diagnostics.md)。
