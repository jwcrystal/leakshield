# 體驗優先：SG 拒絕政策調整

日期：2026-10-11。狀態：**使用者已同意調整；第一階段 P0 回覆降級及 P1 有條件 hook-only 已實作於工作樹。其餘項目仍為後續方案。** [驗證與限制](../evidence/2026-10-11-experience-first-verification.md)。

> 後續使用者批准將 false 改為真正 hook-only，不再保留有條件出站傳輸 admission；見 [新契約與驗證](../evidence/2026-10-11-pure-hook-only-verification.md)。本方案保留作為第一階段決策紀錄，不能把其 false 守門規則當成現況。

## 結論

**建議調整，不維持目前所有守門都會中斷對話的行為。** 日常設定以 `wireProtection: false` 的相容性優先模式為目標；需要更完整的出站檢查時開 true。回覆側降級與工具安全不應跟著 wire 開關一起取消。

這不是承諾 false「完全不會擋」。不能安全遮罩的原值、跨 session 還原、危險或不完整的工具參數，仍不可悄悄放行。

目前全域 SG 仍停用。本輪修改程式、測試及文件；沒有重新安裝、重啟共用服務、讀寫真實 Keychain 或啟用持久化。

## 1. 建議的分工

| 職責 | false：體驗／相容性優先 | true：增加出站保護 |
|---|---|---|
| 已支援的 context／system／title／compaction 遮罩 | 保留 | 保留 |
| 最終出站 body／WS send 重新掃描 | 不做，維持 hook-first | 做，未知形狀或不能保護時拒絕 |
| 未知 endpoint／SDK transport | 符合下述前提時降為 hook-only，告知覆蓋有限 | 在可觀測的 admission／injected-fetch 檢查處拒絕不支援路線 |
| HTTP／WS 回覆歸屬或還原失敗 | 停止 SG 還原，讓 host 接續原始回覆 | 同樣降級；wire 不是「回覆一出錯就中止」的開關 |
| 工具參數還原 | 正確且安全才執行 | 同樣要求；不因 true／false 改變本地執行安全 |
| 附件、持久化 | 仍由各自明確選項控制 | 不自動隨 wire 改變 |

**遷移差異：** false 不再只表示「少一次 body 掃描」；未知 HTTP／WS 路線在同 session／kind／provider-model 的 host 準備 hook 遮罩成功後可採 hook-only。準備 hooks 不帶 kind，依註冊名稱建立作用域；失敗或換模型會使相應證明失效。未知 SDK 的 injected HTTP fetch 可套用此流程，但缺 fetch／不可安全替換的 fetch 設定仍拒絕，不能將初始化當成請求覆蓋證明。README 與目前阻擋清單已同步。

安裝範本可推薦明確設 false。省略選項目前等同 true；不必為了推薦體驗模式，順便悄悄改掉既有省略值的契約。不要新增 HTTP／WS 各一套相互矛盾的開關。

## 2. 優先調整：不讓 SG 中斷已收到的回覆

**P0：HTTP／WS 歸屬失敗改成「不還原」，而不是「不讓 host 讀回覆」。**

- 先修復正常 lifecycle 的歸屬追蹤；降級不代替根因修正。
- 歸屬不明時不查其他 session／model lane 的 mapping，不猜測 response ID。
- 保留 host 提供的原始回覆；無法還原的 placeholder 可以顯示為字面值。
- 不更改 session、kind、model 的路由，不將其他 lane 的內容拼進目前回答。
- 清理受影響的 SG 解析／tail 狀態，記錄一次不含內容的降級提示。
- 工具呼叫仍留給 tool-before 檢查，不在回覆降級時將未知 token 填入猜測的原值。

**P0：SG 自己的回覆解析／緩衝失敗也以降級為主。**

- 不支援的 frame／回覆 extension，不為了 SG 還原而新增一次串流中止。
- 達到 SG 解析上限時停止累積、停止還原，不能無限加大緩衝。
- HTTP 串流若已有部分內容送出，須保留未送出的原始片段及後續順序；不能回傳已消耗的 stream、重送已發出的文字或任意丟掉 frame。
- 不捏造 `response.completed`、成功回覆或工具成功；不吞掉 provider 自己的 error／abort。
- 壞掉的 provider 串流仍可能被 OpenCode 拒絕。目標是「SG 不額外打斷」，不是保證 host 能讀任何垃圾資料。

**安全取捨：** 降級可能讓使用者看到 placeholder，或無法完成後續工具還原；不等於保護及任務完成度沒有下降。正確歸屬時仍正常還原，歸屬不明時絕不跨 session 還原。

## 3. 第二優先：降低出站的相容性阻礙

### 未知 endpoint／SDK

false 可在已確認相關 host context 遮罩成功的模型流程中，接受未知 route，停止不適用的 final-wire／回覆 adapter，並標示「僅 hook 覆蓋」。不能僅憑 URL 像 OpenAI 或 SDK 初始化成功就宣稱受保護。

**保留限制／後續 seam：** SDK 初始化沒有 session 身分；目前缺 injected fetch 或其設定不可安全替換時，false／true 都拒絕初始化。若未來讓這類 SDK 在 false 初始化，必須先有可證明的 request-scoped host 遮罩／外送 seam，不能以初始化成功取代它。私有 transport 不因本輪政策自動獲准。

true 仍拒絕可觀測到的未知 route 或不成立的 injected-fetch 契約。自行繞過 fetch 的 socket、global fetch、子程序不在可保證的覆蓋內；開 true 也不會把 SG 變成網路防火牆。

false 的 `/alpha/generate` 在符合上述條件時不再只因 endpoint 名稱被拒；**沒有 legacy adapter，最終 body 不掃描，顯示回覆保持 placeholder。** 本地真實 host／實際 commandcode SDK 的 Go 與 403 fallback 已完成工具及 capture 驗證；不是線上帳號／所有 legacy 內容的安全證明。缺遮罩證明仍拒絕，沒有新增 URL／品牌白名單。

### 大內容、編碼與誤報

| 情況 | 建議調整 | 不建議的捷徑 |
|---|---|---|
| 大型工具輸出／長字串 | 增加有界分段掃描及占位符一致性；必要時將不能送出的文字片段替換為明確省略通知 | 只掃前 200,000 字後把其餘原值送出，或取消所有上限 |
| 編碼敏感值 | 在純文字欄位能確定完整編碼區間時，替換整個原始片段，mapping 保留原始編碼形式 | 僅遮罩解碼後的值，卻把原始 Base64／URL／Hex 字串照送 |
| ID、schema、數字的低可信命中 | 先修過廣規則與欄位判斷；結構欄位不得像一般 prose 任意改名 | 所有命中一律吞錯、把 number 強制改成 string |
| 遮罩不完整或明確秘密無法替換 | 能保留合法協定時省略受影響內容並告知；否則只拒絕該請求，給可操作的錯誤原因 | 默默退回未遮罩原值，或讓整個插件無提示停用 |

省略內容會降低模型可用資訊，不能把它記成「完整任務成功」。跨分段的敏感值與編碼片段不能漏掉；尚無正確 adapter 的結構欄位維持拒絕，不為了體驗亂改協定。

## 4. 維持工具安全，但改善完成任務的路徑

**維持：** 寫入／執行／網路工具的未知 mapping、跨 session token、注入風險、不可安全修改的結構，仍拒絕該次操作。這不是 final-wire 額外掃描，不能用 false 解除。

**調整：**

1. 回傳簡短、可重試的工具錯誤：要求重讀來源、取得本 session 的值，再重試；不要只給籠統的「blocked」。
2. 複雜 shell 的常見安全形式透過真正 parser／工具 adapter 逐項補支援。單靠取消 wrapper／管線檢查或做全字串替換不可接受。
3. 新工具優先用明確的非 shell schema adapter，避免只是名稱不在清單就被當 shell；不得因工具自稱唯讀就給未還原值無條件執行。
4. 真正唯讀操作可沿用 literal-placeholder 降級，但仍標示可能無匹配，不能假裝讀到了正確來源。
5. 持久化仍 opt-in，可減少重啟後的舊 token 問題；不預設存原值、不自動讀寫 Keychain、不開 keyfile fallback。也不能補回之前從未保存的 mapping。

## 5. 不建議變更的部分

- 不增加 NER／廣泛 PII 規則作為這輪重點。
- 不為了可用性而使用其他 session 的 mapping。
- 不照搬 EightDoor 工具還原失敗後吞錯、繼續執行的政策。
- 不自動改 `attachments: block` 為 allow；「體驗優先」不是授權把未掃描圖片或文件送出。
- 不取消容量上限；改進分段、降級及狀態回收，不無限留住所有 session。
- 不把初始化失敗變成無提示、原值外送的自動 fail-open。
- 不以省略內容、保留 placeholder 或 exit 0 冒充工具正確完成。

## 6. 實作與驗收順序

1. **已實作 P0：** 隔離 OpenCode v2.0.25＋native OpenAI，用遺失 send registration 的故障注入重現相同錯誤，再驗證回覆不被 SG 中止。這鎖住拒絕政策，不證明日常環境遺失歸屬的原因。模型切換、重握手、HTTP fallback、terminal／晚到 frame 另有 hook 回歸。
2. **已測 false／true：** 正常還原、歸屬／解析／容量降級、跨 session／model 不還原、provider error 即時傳遞、來源錯誤與取消不吞掉。HTTP SSE 共用有界交易／原始 bytes recovery。
3. **已分開驗收：** 對話完成、顯示還原、精確工具操作及無測試原值外送；unknown-token write／shell、既有注入反例仍拒絕。
4. **已實作 P1 的可觀測範圍：** 未知 HTTP／WS route 的 scoped hook-only、AI SDK injected-fetch 委派；本地八方案、兩種模型族、兩種 wire 及 403 fallback 驗證。缺 injected fetch 不在此降級內。
5. **後續：** 大內容有界分段、完整編碼區間遮罩、新工具 adapter；附件、持久化與 Keychain 不自動啟用。
6. **仍需另外授權：** 真實日常模型 smoke、重新安裝或共用服務重啟。載入既有 socket、真實 reconnect／cancel-resume 及長期使用尚無完整線上驗收。

## 依據與未解決問題

**已驗證：** [目前阻擋盤點](../evidence/2026-10-11-current-blocking-impact.md)、[三方比較](../evidence/2026-10-11-official-rehydra-v2-comparison.md)；SG 曾因 WS 缺歸屬阻斷回覆，EightDoor 回覆降級可參考，但其 system 原值外送與工具吞錯不可照搬。

**已驗證／未驗證要分開：** 本輪回覆降級及 scoped hook-only 有可重跑的本地證據；分段／編碼／新工具 adapter 未實作。真實 WS 故障的環境根因、線上 provider 及改善頻率未證明。WS 的單 frame 介面不能補發任意多 channel 尾段，不把它宣稱成 HTTP 的完整交易重播。

本輪擴充了「wire 只控制最終出站掃描」的契約，但未改省略值 true。回覆降級不由 wire 分流；三種 SSE adapter 共用 `src/opencode-transparent-stream.ts`，HTTP／WS hooks 不再把 SG 入站歸屬／解析失敗向 host 拋出。出站、初始化與工具拒絕不在該 catch 降級範圍內。
