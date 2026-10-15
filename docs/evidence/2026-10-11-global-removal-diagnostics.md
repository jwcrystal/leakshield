# 再次阻擋後：全域停用與 runtime 盤點

日期：2026-10-11。runtime 盤點：`2026-10-11T12:23:11.975Z`；最新日誌復查：`2026-10-11T13:57:31.460Z`。範圍：本機設定、既有服務的唯讀 API 與內容無關的日誌欄位。

## 結論

- **SG 保持停用。** 全域設定沒有 SG；兩個既有服務在兩個曾出錯的 location 的非空插件清單中，均沒有 SG。
- **未修復或重現原始阻擋原因。** 相同錯誤的最後日誌早於設定移除時間，不能據此認定移除後仍在阻擋，也不能宣稱日常實機問題已修好。
- 前兩次唯讀盤點沒有重新加入 SG、修改設定、重啟／停止服務、發送真實模型請求、啟用持久化或操作 Keychain。只更新此紀錄與驗證文件的狀態說明。
- **後續授權重測已重現同型阻擋。** SG 只在獨立服務載入；新短對話通過、既有長對話分叉失敗，測試服務已停止、全域設定未改。見 [實機長對話重測](2026-10-11-live-long-context-retest.md)。

## 1. 設定與使用者工作

| 檢查 | 結果 |
|---|---|
| `~/.config/opencode/opencode.json` 的 SG registration | 0 |
| 全域 package plugins | `opencode-cmd-provider`、`opencode-observer` 保留 |
| 設定檔權限 | `0600` |
| 全域檔最後修改 | `2026-10-11T08:16:05.170Z` |
| `OPENCODE_CONFIG` 指向的 OpenChamber managed config | 沒有 SG |
| 專案與祖先目錄的 direct／`.opencode` config 盤點 | 沒有找到 SG registration |

目前全域 JSON 與 `opencode.json.before-sensitive-guard-20261011` **不是完全相同**；語意差異僅在 `providers.mlx-serve`。本輪未改動或回復這項既有差異，不公開其設定值。先前紀錄中的「與備份一致」不能代表目前快照。

## 2. 執行中的插件，而不只看設定檔

本機有兩個不同的 OpenCode **v2.0.25** 服務：

| 服務 | PID | 當時 loopback endpoint |
|---|---|---|
| CLI 發現的共用服務，`serve --service` | 13902 | `127.0.0.1:49374` |
| OpenChamber 連線的服務，`serve --hostname … --port …` | 10248 | `127.0.0.1:57028` |

OpenChamber 的既有連線以程序 socket 盤點核對；指定該 endpoint 的 `/api/info` 也確認 PID。API 檢查使用既有認證環境，沒有輸出認證值。

對兩個曾出錯的 location，使用帶有 `location[directory]` 的 `/api/plugin` 檢查：

| 服務 | 本專案 location | 另一個出錯的 OpenChamber chat location |
|---|---|---|
| 共用服務 | 91 plugins；SG 0 | 91 plugins；SG 0 |
| OpenChamber 服務 | 91 plugins；SG 0 | 91 plugins；SG 0 |

四份清單的外部插件均為 active：`context-mode`、`orca-opencode-status`、`rtk`、`commandcode`、`opencode-observer`、`openchamber-agent-tool`。

部分第一次查詢返回空清單；這些結果沒有當成卸載證明。上表只採用後續的非空清單，並以 plugin ID／source 判定 SG，而不是對整份 JSON 做字串搜尋；location 路徑本身含有 `sensitive-guard`，會造成誤判。

這是這四個 service/location 組合的當時快照，不是對所有可能的服務、其他 location 或執行中舊 closure 的完整保證。沒有為驗證而重啟或 reload。

## 3. 相同錯誤的日誌

來源：`~/.local/share/opencode/log/opencode.log`。僅導出時間、錯誤常數、stack symbol 與歸屬資訊；沒有保存 prompt、工具內容或認證。

```text
Sensitive Guard transparent mode failed to protect a model request.
```

完整日誌中找到 3 筆 server ERROR：

- `2026-10-11T07:56:30.376Z`：OpenChamber chat location。
- `2026-10-11T07:56:55.067Z`：本專案 location。
- `2026-10-11T07:57:25.856Z`：本專案 location。

三筆 stack 均指向當時本地 `dist/opencode-transparent.js` 的 `protectRequestKind`，上層為 `SessionModelRequest.prepare`。日誌沒有可區分的底層 cause 或 guard reason，也沒有足夠資料確認當時載入的編譯版本。

之前的 WS 歸屬拒絕發生於 `2026-10-11T03:51:11.171Z`，錯誤常數不同；不能拿它推定本次準備階段失敗的原因。

最後一筆相同錯誤早於目前設定檔修改時間。最後盤點時沒有找到更晚的同型紀錄，但使用者回報缺少發生時間；尚無法把該回報唯一對應到某一筆日誌。

## 4. 可重查入口與未完成條件

既有 CLI：`/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode`。

```sh
opencode service status
opencode api get /api/info
opencode api get /api/info --server http://127.0.0.1:57028
opencode api get '/api/plugin?location%5Bdirectory%5D=<URL-encoded-directory>' --server http://127.0.0.1:57028
```

endpoint／PID 是暫時值；重查前必須重新核對既有服務與 OpenChamber 的連線。V2.0.25 的 `--server` 應放在 `api` 子命令之後；放在最外層會返回 usage／exit 1，不能當成 server 查詢結果。

在此時點的停用盤點中，**尚沒有會對使用者原始症狀變紅的可重跑案例**，因此沒有臆測底層原因或修改拒絕政策。後續經使用者授權，已用獨立服務的長對話分叉重現，見 [實機長對話重測](2026-10-11-live-long-context-retest.md)；具體底層 reason 仍缺失。任何進一步重新啟用或新增 runtime instrumentation，須另獲使用者授權。

本地 915 tests 與合成矩陣的結果仍只證明其測試範圍；見 [第一階段驗證](2026-10-11-experience-first-verification.md)。

## 5. 最新日誌復查：仍缺少底層拒絕原因

本次完整掃描兩份既有日誌，沒有啟動模型請求或新增 instrumentation：

- `~/.local/share/opencode/log/opencode.log`：復查時約 22.6 MB／78,526 行。
- `~/Library/Logs/OpenChamber/main.log`：復查時約 120 KB／1,577 行。

只用主日誌的 `message`／`cause` 欄位判定 SG 事件，排除命令參數、工具內容與本專案路徑的字串命中。共找到 4 筆：先前的 WS 歸屬拒絕 1 筆，以及本次模型請求準備失敗 3 筆。沒有更晚的同型準備失敗。

| 日期均為 2026-10-11，UTC+8 | 主日誌行號 | 訊號 |
|---|---|---|
| 15:56:30.376 | 68408 | `protectRequestKind` 準備失敗 |
| 15:56:55.067 | 68612 | 同上 |
| 15:57:25.856 | 68615 | 同上，最後一筆 |

三筆 `cause` 均只有通用 Error 與 stack，沒有巢狀原始 cause；前後各 25 行也沒有 guard reason／診斷代碼。可確認的 stack 位置為當時 `dist/opencode-transparent.js:977:27`、`protectRequestKind` 的 `:982:23`、callback 的 `:1214:25`，上層仍為 `SessionModelRequest.prepare`。這些位置不能單獨判定是何種資料、容量或掃描條件觸發失敗。

### OpenChamber 的補充紀錄不是同型拒絕

`main.log:1438–1454` 記錄 **16:16:33** 的 `Manual configuration reload requested`，隨後停止舊 OpenCode process。該 lifecycle 診斷的舊 PID 為 **79730**，`healthFailure: null`、`busySessionCount: 0`；其 `stderrTail` 是：

```text
[sensitive-guard] degraded: WS reply kept original after attribution or restoration failure; placeholders may remain literal
```

這是 WS 還原降級、保留原回覆的提示，不是 `failed to protect a model request`。stderr tail 沒有該事件本身的時間，不能把它當作 16:16 新發生的 WS 故障，或推定它造成先前三筆準備失敗。

日誌表明曾有手動重載流程，但不能單靠此紀錄識別觸發者；本次診斷沒有呼叫 reload／restart。先前的「未重啟」指本代理未執行該操作，不代表環境中從未發生重載。

**復查結論：已確認失敗位置與三次發生時間；仍無法從現有日誌取得底層原因，不能宣稱根因已定位。** 本節沒有重新驗證第 2 節的 runtime 快照。
