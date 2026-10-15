# 體驗優先第一階段：回覆降級與 scoped hook-only 驗證

日期：2026-10-11。範圍：**未提交工作樹**，不是已發布版本或全域已載入版本。

> 本文件保存第一階段快照。後續 false 的 scoped outbound admission 已由 [純 hook-only 修正](2026-10-11-pure-hook-only-verification.md) 取代；歷史分叉也已 [重現同型拒絕](2026-10-11-live-long-context-retest.md)，不再是「尚無 red」狀態。以下測試數／mode 行為只對應第一階段。

## 結論

- **已實作 P0：** HTTP／WS 的 SG 歸屬／還原／解析失敗停止還原，不再因此中斷 host 回覆；不猜 mapping、不跨 session／kind／model 還原。
- **已實作 P1 的可觀測範圍：** `wireProtection: false` 的未知 HTTP／WS route 在相應 host 準備遮罩成功後可採 hook-only；true 仍拒絕未知路線並檢查支援的最終出站內容。
- **工具防線保留：** unknown-token write／shell、注入、不能原子還原的參數仍拒絕，不把 placeholder 或 exit 0 當成正確操作。
- **41 test files／915 tests、TypeScript 檢查及 build 通過。** 本地 native HTTP／WS 正常及故障工具案例通過；commandcode 八方案／兩模型族矩陣通過，詳見下表。
- **目前全域 SG 停用；後續實機重新啟用曾失敗。** 使用者授權再次加入後，仍回報 `Sensitive Guard transparent mode failed to protect a model request.`，隨後要求移除。本地矩陣通過不代表日常使用已正常；最新設定與兩個服務的 scoped runtime 盤點見 [再次阻擋後的停用診斷](2026-10-11-global-removal-diagnostics.md)。原始阻擋原因仍未重現，沒有重啟共用服務或操作真實 Keychain。

## 1. 行為與遷移契約

| 職責 | false：體驗／相容性優先 | true：增加出站保護 |
|---|---|---|
| host system／messages／options／tools 遮罩 | 保留 | 保留 |
| 最終 HTTP body／支援的 WS 出站內容 | 不讀取／不再掃描 | 驗證並再遮罩 |
| 未知、可觀測的 HTTP／WS route | 同 session／kind／provider-model 的準備遮罩成功才 hook-only | 拒絕 |
| 非認證 headers／URL metadata | 敏感值仍拒絕 | 同左 |
| SG 回覆歸屬／JSON／SSE／WS 還原失敗 | 停止還原，接續原回覆 | 同左 |
| provider error、來源 stream error、consumer cancel | 保留原錯誤／取消，不捏造完成 | 同左 |
| 工具還原與注入防線 | 保留 | 同左 |
| 附件、持久化、Keychain | 各自明確 opt-in／policy | 同左 |

**這是 explicit false 的契約擴充，不只是少掃一次 body。** 舊 false 會拒絕未知路線；現在若具 scoped 證明可繼續，但 final body 與未知協定回覆沒有 adapter。後續 plugins／SDK lowering 新增的內容可能未遮罩，覆蓋仍為 `PARTIAL`。

**省略 wire 仍等同 true，預設 plugin mode 仍為 block。** 沒有新增互相矛盾的 HTTP／WS 開關，也沒有 URL／provider 品牌 allowlist。

SDK 必須遵守 injected `options.fetch`。false 只把未知 HTTP 路徑交給 host admission，沒有直接繞過它；缺 fetch、accessor／proxy／不可寫設定在兩種模式仍拒絕。SDK 初始化沒有 session 身分，不能豁免成未經遮罩的外送。忽略 injected fetch 的私有 socket、global fetch 或子程序不是可保證覆蓋範圍。

`doctor` 保持 false→`PARTIAL`，說明已同步 scoped hook-only、兩模式共用回覆降級及缺 fetch 的限制；不再宣稱所有未知路線在 false 也一律拒絕。這是安裝級說明，不是 live-session 覆蓋證明。

## 2. Red → green：native WS 拒絕症狀

使用實際 OpenCode **v2.0.25**：`/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode`。模型是 loopback 替身，HOME／XDG、合成認證與工作目錄全部隔離。

`E2E_LOST_WS_SEND=1` 用明確的 test-only plugin fixture 略過 WS send callback；context／tool 等 hooks 仍使用 production SG。這模擬歸屬 registration 遺失，不宣稱已重現使用者環境中遺失 registration 的原因。

| 同一故障案例 | false／true 的結果 | 主工具請求 | 操作正確 | 捕獲到測試原值 |
|---|---|---|---|---|
| 修正前 WS | `Failed to read openai/openai-responses stream`，底層 `blocked a WebSocket frame without matching request attribution` | 各 1 | 否 | 0 |
| 修正後 WS | 對話完成、保留 literal placeholder；沒有該 SG 拒絕 | 各 4 | write/read/quoted-shell 正確 | 0 |
| 同次 HTTP 對照 | 正常完成並精確顯示還原 | 各 4 | 正確 | 0 |

最終編譯版本的正常 native HTTP／WS 四案也全部通過；WS 主流程各重用 1 個連線。對話完成、顯示還原、工具檔案精確 bytes、續接 tool results 與 capture 無原值各自檢查，不只看 CLI exit code。

## 3. Scoped admission 的真實 host 差異

第一輪 Go false 案例仍在外送前被拒。內容無關的暫時診斷確認：**context/title/compaction/generate 準備 events 不帶 kind，HTTP events 才帶 kind**。四個不含 event.kind 的回歸測試先紅，再改為依註冊 hook 判定：context→primary，其餘→同名 kind。

證明只在遮罩及安全發布全部成功後建立；下一次同 scope 準備失敗先撤銷，換 model 取代舊證明。請求仍核對 session、kind、provider/model ID。診斷 instrumentation 已移除，沒有將 prompt、token、認證或例外內容寫入降級提示。

這修正的是新的 compatibility proof lifecycle，不是先前線上 WS 失去歸屬的根因證明。

## 4. 八方案及兩種模型族矩陣

SDK：實際隔離安裝的 **opencode-cmd-provider@2.2.6**，未修改 SDK；方案是本地 pins。模型 `gpt-6.1`／`claude-sonnet-4-5` 在 runner 中只是合成 model IDs，分別走 OpenAI-compatible／Anthropic-compatible 路線，不是真實生成。

| 組別 | 案數 | 驗收結果 |
|---|---|---|
| SDK 直接路由 probes：八方案×兩模型族 | 16 | 16 通過；本地預期 401 結束 probe，不是對話成功 |
| 七個非 Go 方案×兩模型族×兩 wire | 28 | 對話、正常顯示還原、工具 bytes、出站測試原值缺席均通過 |
| Go／403 fallback 的 false | 4 | scoped hook-only 對話與工具成功；顯示 placeholder，未知 body／回覆未套 adapter |
| Go／403 fallback 的 true | 4 | 預期本地拒絕；沒有 legacy 外送或工具檔案副作用 |

共 **36 個 host 矩陣案例**通過各自預期，**32 個精確工具流程、4 個安全拒絕**；不是「36 次操作全部成功」。全部捕獲均無合成 email／env secret 原值；沒有逾時。403 已外送的標準 request 也納入 leak check。

方案涵蓋 go、goat、pro、prolegacy、max、max20、teampro、provider；另外測 goat 的 provider 403 後 fallback。只核對 primary 的模型族路由，仍檢查所有 auxiliary/title capture，避免把 title 的 OpenAI 路由誤算為 Anthropic 主模型失敗。

**本地結果不能證明各方案真實 entitlement／認證，也不證明任意 SDK、未知 route 或 legacy envelope 都安全。**

## 5. HTTP 串流的有界降級

三種 SSE adapter 共用 `src/opencode-transparent-stream.ts`；每次改寫保留尚未交付的原始 event bytes。token tail 未完成時暫不提交這批改寫結果；一旦 SG 失敗，只按順序釋出尚未送出的原始 events，然後 bypass 後續 bytes。不 tee 第二條無界 stream，也不重播已送出的內容。

- 原始 retention／改寫結果各最多 **1 MiB**，片段 bookkeeping 最多 **4096**；先檢查再累積。原始 single upstream chunk 由來源決定，不能宣稱 SG 限制了來源自己的配置。
- 解析超限、malformed JSON／UTF-8、channel／terminal 不一致、未完成 placeholder 的邊界均降級；不丟原始 tail、CRLF 或無效 UTF-8 bytes。
- provider error event 即使前方有 held text、upstream 尚未 close 也立即交付，不等 EOF、不變成合成成功。
- source `reader.read()` 的錯誤不當成 SG parser 結論；保留原錯誤。Consumer cancel 仍取消原 reader，降級本身不取消健康 upstream。
- 正常完整 token／跨 chunk token 仍在確定 session 歸屬下還原；工具 arguments 不提前改成原值。

新 recovery 測試有 **53 案**：兩 wire、三 HTTP 協定、missing/mismatched attribution、model mismatch、JSON 保留、UTF-8／CRLF／交錯 channel、EOF／terminal、byte／fragment caps、provider error 即時交付、source error／取消、WS 下一 request 恢復及 unknown mapping 工具拒絕。舊測試不是只移除拒絕斷言，而是改驗證 literal、順序、無原值還原或無副作用。

## 6. WS 與剩餘限制

WS hook 只能取代 **一個** frame、沒有實體 connection ID。歸屬／解析失敗會讓當次 response 的 SG 還原失效；新 send 可在已驗證 handshake 上建立下一 response，不中途重啟失敗回覆的還原。

已保留的文字 prefix 只有在目前 frame 可確認為同 response／同文字 channel 時，才以 literal 加回該 delta。不可解析的 frame、不同 response 或多 channel 的未完成尾段，無法靠此 API 安全補發；清除這些 SG 狀態，不把其他 channel／session 的文字拼入目前回覆。完整 `.done` 欄位仍保留，delta-only consumer 可能顯示不完整。不能把 WS 宣稱為 HTTP 的任意原始事件重播。

仍未解決／本輪未做：

- 真實環境的 WS 歸屬根因、載入時已有 socket、真實 reconnect／cancel-resume 及長期降級頻率；本地故障 injection 不替代它們。
- 真實 Anthropic 生成失敗、線上模型 smoke 及全域舊服務是否都已卸載；沒有共用服務重啟授權。
- 大內容分段、完整編碼片段遮罩、新工具 adapter、缺 injected fetch 的新安全 seam；現有 context／工具容量拒絕仍保留。
- 附件 allow、持久化、真實 Keychain 不自動啟用。省略值及其他既有配置不變。

## 7. 重跑及原始證據

```sh
npm run build
npm test
OPENCODE_BIN=/absolute/path/to/opencode node scripts/e2e/run-responses-ws.mjs
E2E_LOST_WS_SEND=1 OPENCODE_BIN=/absolute/path/to/opencode node scripts/e2e/run-responses-ws.mjs
E2E_PROVIDER_PACKAGE=/absolute/path/to/isolated/opencode-cmd-provider OPENCODE_BIN=/absolute/path/to/opencode node scripts/e2e/run-commandcode-plan-matrix.mjs
```

設定 `E2E_WORK_ROOT` 可指定預先存在的外部 temp 父目錄；runner 產生唯一隔離目錄與 capture／summary，預期斷言失敗 exit 1。安裝依賴是既有 lockfile／隔離 SDK，不要為測試重啟共用 host 或讀取真實 credentials。

此機器的證據父目錄：`$TMPDIR/opencode/`。

- 修正前故障：`sg-ws-tools-Q0RNF6/summary.json`。
- 最終編譯正常 native：`sg-ws-tools-3aiMSp/summary.json`。
- 最終編譯故障 native：`sg-ws-tools-HIc8oJ/summary.json`。
- 最終編譯八方案矩陣：`sg-plans-BmzJc4/summary.json`；前一輪 `sg-plans-XzB4Ff/summary.json` 也全部通過。

暫存 capture 不是永久封存；本文件保存導出結論及可重跑入口。GitNexus 工具／索引不可用，本輪以 TypeScript upstream callsites 確認 impact：guard 由 `src/opencode.ts` 接入，共用 SSE helper 影響三種 HTTP adapter，屬高風險 transparent 入口變更。沒有 commit／push 或宣稱已完成發布。
