# SG 與官方 Rehydra：目前差異與日常體驗

> **已被取代（2026-10-14）：** 本文是純 hook-only 前的快照，其中「既有對話分叉被阻擋」已解決，現況見 [三方重測](2026-10-14-three-way-comparison.md) 與 [容量與刪除回收重測](2026-10-14-live-capacity-and-lifecycle-retest.md)。

日期：2026-10-11。使用比較表，分開「在你的 V2 環境實際發生什麼」與「程式設計提供什麼」。

> 本比較是純 hook-only 修正前的快照。後續使用者批准並已實作 false 不掛出站傳輸／SDK 守門、不改 provider transport，保留入站 best-effort 還原；見 [最新契約與驗證](2026-10-11-pure-hook-only-verification.md)。這個模式修正不代表原始歷史遮罩拒絕已解決。

## 結論

**目前不能把官方 Rehydra 的「對話沒被擋」當成比 SG 好的受保護體驗：官方套件在既有 OpenCode V2.0.25 測試中沒有成功載入。SG 能載入並介入請求，但這段既有對話的分叉仍被阻擋，尚未達成你要的「有效保護、盡量不中斷」。**

本次比較不重新安裝、不重啟、不發送模型請求。全域 SG 維持停用。

## 1. 比較版本與證據

- **SG：**目前未提交工作樹的編譯版本，不是已發布版本或已證明日常可用的全域安裝。最新實機重測使用 `mode: transparent`、`wireProtection: false`、附件 block、持久化關閉。[S1]
- **官方：**`@rehydra/opencode@0.14.0`。本輪重新查詢 npm `latest`，版本仍為 0.14.0；`rehydra ^0.14.0` 目前最高相容發布版也是 0.14.0。兩份 tarball 與既有隔離 source 已核對；引用的是發布內容，不是 GitHub main HEAD。官方的 V2 runtime 結果引用先前同日隔離測試，本輪沒有重新執行。[R1][R2][R3]
- **不混入 EightDoor：**`opencode-rehydar@0.14.3` 是另一個 fork。它能在 V2 操作，不代表官方套件也能，更不代表已完整保護。[R2]

## 2. 你目前環境的實際體驗差異

| 情境 | SG，目前實測 | 官方 `@rehydra/opencode`，既有 V2 實測 |
|---|---|---|
| 插件確實生效 | 獨立服務列出 SG active；共 92 plugins | 載入失敗；不是有效的 V2 plugin definition |
| 新短對話 | 真實 `openai/gpt-6.1-sol#max` 回固定 marker，通過 | 既有合成對照可完成對話，但插件未生效；不是公平的受保護成功 |
| 這段既有對話 | 分叉後在準備階段被拒絕；沒有 marker | 沒有有效 V2 插件下的同一段對話結果，不能宣稱更順 |
| 測試敏感值有沒有遮罩 | 既有本地矩陣有遮罩／工具 bytes 斷言；最新實機重測只驗可用性 | 既有 title／primary capture 含測試原值，與無插件對照一致 |
| 出錯時使用者看到什麼 | `failed to protect a model request`，OpenCode 停止該次回覆；底層 reason 被捨棄 | host 日誌指出 default export 不是 `id/setup/effect` definition；對話可繼續但沒有該插件保護 |
| 今天能否直接作為無感保護方案 | 尚不能：這段歷史已重現拒絕 | 尚不能：此 V2 相容性未成立 |

來源：[S1] 的真實短對話／歷史分叉、[S2] 的本地合成矩陣、[R2] 的官方隔離對照。不是同一模型、同一上下文、同時進行的完整 A/B 效能測試。

**短對話通過，不代表所有長對話都會失敗或都能成功。** 本次只證明「帶入這段既有歷史的分叉」會觸發 SG 拒絕；沒有證明是長度超限。分叉會產生新 session，且獨立服務的 mapping 生命週期與日常原服務不完全等價；因此這是同型症狀重現，不是原始根因已唯一確認。[S1][S3]

## 3. 機制與政策差異：不只是哪個比較會擋

下表官方欄是 **0.14.0 發布來源已驗證的 V1 設計**，不是「在你的 V2 host 已成功執行」。SG 欄是目前 source／既有測試的能力，不保證所有 SDK 或資料都能成功。[S2][S3][S4][R3]

| 面向 | SG | 官方 `@rehydra/opencode` |
|---|---|---|
| host 入口 | 有 V2 `id/setup`；最新獨立服務確實載入 | V1 async plugin function 與五個 V1 hooks；沒有合格 V2 definition |
| system／title | 真正遮罩準備中的 system；另有 title／generate／compaction hooks | system hook 只追加 placeholder 指令，不掃原 system；發布 README 明示獨立 title 可跳過 messages hook而漏首訊 secrets |
| messages／模型 options／工具定義 | 原子保護 system/messages/options/tools 的 JSON 投影，並保留協定結構 | 匿名化 message text 與 tool state 的字串值；不涵蓋全部 metadata、物件鍵、provider options、工具 description／schema |
| 最終出站 | true 可檢查支援的 HTTP body／WS 出站內容；false 不做 final body scan，仍檢查必要 metadata | 只有 V1 hooks，沒有包裝 provider fetch／HTTP body／WS send；不是 final-wire 防線 |
| 殘餘敏感值／不安全資料 | 遮罩交易的失敗結果、殘餘值、結構與容量等問題可使準備拒絕 | leak-scan／validation 不通過不形成強制拒絕閘門；預設 warning callback 是 null，仍可能回傳结果／stats |
| 真正的例外 | 準備失敗會停止該次請求；回覆側 SG 解析／歸屬／還原失敗已改為降級 | detector、匿名化、解密、缺整份 map 等真正例外仍往上拋；不是全部 fail-open。相容 host 最後怎麼處理，這輪未測 |
| 工具參數 | 特別檢查未知 mapping、結構與 shell literal 還原；不安全 write／shell 拒絕 | 深走 args 的字串值做還原；map 已存在但 tag 無對應時可留下 placeholder，沒有 SG 等價的工具／shell 門檻 |
| 串流顯示 | 支援 JSON／有界 SSE／Responses WS 還原；SG 失敗可保留 literal，不等於所有尾段都能補回 | 插件只掛 text-complete 還原；SDK 有 streaming API，但此插件沒接逐 delta／SSE／WS frame 還原 |
| mapping 與重啟 | 預設 memory-only；另有 opt-in 加密持久化，目前沒啟用 | 插件固定使用 memory mapping/key，advanced config 也不能把 SDK SQLite 能力直接變成插件的持久化承諾 |
| 預設偵測 | 本地規則、設定字典／env 值與編碼／Unicode 檢查；不依靠遠端 NER | 本地 regex／secret patterns 與初始化 env literal；NER、semantic masking 預設停用，URL／IP 預設排除 |

**不能說官方「任何錯誤都把原文放行」。** 它會略過部分 env 檔讀取問題，對 leak-scan 不通過不設硬閘門，但真正匿名化／還原例外仍會傳上來。未知 tag 留 literal 與缺整份 map 拋例外，也必須分開。[R3]

**「更少拒絕」不等於「操作更正確」。** 未還原的 placeholder 被交給工具時，工具可能找不到檔案、沒有結果，或使用錯誤參數；這是來源可推論的體驗風險，不是本輪新增的官方 runtime 測試。[R3]

### 效能與可選 NER

兩者預設都不需把文字送額外的遠端 NER 來做偵測。官方可 opt-in 本地 NER，官方 guide 定性指出延遲顯著；這不是本輪量測。[R3]

若官方 NER 選 inference-server 且 URL 是遠端，0.14.0 發布 client 會在匿名化前把那段原始全文 POST 至該服務。這不是預設行為，也不能混稱成預設多叫一次主 LLM；選擇本地服務與遠端服務的信任邊界不同。[R3]

沒有同 host、同有效保護、同上下文的延遲／誤判率 benchmark，**不排名誰比較快、誰偵測比較準**。SG 掃描與檢查面較廣，不代表準確率或端到端安全已勝出。

## 4. SG 本輪已改善什麼，仍缺什麼

| 項目 | SG 現況 | 對體驗的影響 |
|---|---|---|
| 回覆還原失敗 | HTTP／WS 的 SG 解析、歸屬、還原失敗改為停止還原、接續原回覆 | 比先前直接停止對話溫和；可能顯示 placeholder，不保證每種 WS 尾段完整 |
| 模型輸入保護失敗 | `protectJsonForModel` 回傳失敗仍會拒絕請求 | 這次分叉就是此路徑；上面的回覆降級修正不能解決它 |
| `wireProtection: false` | 不掃描最終 wire body；未知可觀測路線須有同 session／kind／model 的準備遮罩證明 | 增加相容性，但不是「不擋模式」，覆蓋為 `PARTIAL` |
| `wireProtection: true` | 保留支援協定的最終出站檢查與未知路線拒絕；省略值仍等同 true | 多一層防線，也會多出拒絕條件；不是所有 SDK 私有傳輸都可覆蓋 |
| 工具操作 | unknown mapping 的 write／shell、注入、不安全參數還原仍拒絕；支援完整 literal quoting 與受限靜態重導向 | 能防止錯誤／危險執行，但部分 shell／失效 placeholder 需要改寫或重新讀取 |
| 持久化 | encrypted mapping store 為 opt-in；目前關閉 | 不能承諾重啟後舊 placeholder 無感續用；真實 Keychain 沒有驗證 |
| 診斷 | 此準備失敗分支只丟通用 Error，沒有帶上 typed reason | 使用者無法知道應修哪一項；這是目前明確的診斷缺口 |

以上為程式／既有測試已驗證的行為，不是全場景安全保證。[S2][S3][S4]

## 5. 怎麼判斷「比較好用」

- **已驗證：**SG 的請求、工具與傳輸檢查會增加實際拒絕條件。最新實機失敗不能被 915 tests 或短對話成功抵銷。[S1][S2]
- **已驗證：**官方插件在這個 V2 host 沒生效時，不會因其 hooks 中斷對話；同時也沒有完成其遮罩工作。[R2]
- **推論：**只看對話能否繼續，未載入的插件看起來更無感。但那是在比較「有 guard」與「沒有該 guard」，不是在比較兩個有效保護方案。
- **未驗證：**兩者在有效且等價環境下的額外延遲、誤判率、長對話成功率、相同真實模型下的工具成功率。不能給出公平排名或百分比。

**依你「體驗優先」的要求，SG 目前仍不宜恢復全域啟用；官方套件也不是這個 V2 環境的已驗證安全替代品。** 最小下一步是把安全 reason／stage 帶到診斷訊號，再重跑同一個歷史分叉；先判斷本次拒絕是否必要，而不是一律放行或再換安裝入口。

## 來源

- [S1] [最新實機長對話重測](2026-10-11-live-long-context-retest.md)：SG active、真實短對話通過、歷史分叉同型拒絕、全域未改。
- [S2] [第一階段回覆降級與 scoped hook-only 驗證](2026-10-11-experience-first-verification.md)：915 tests、合成矩陣、P0／P1 邊界。其早期「尚未重現」狀態已由 S1 更新。
- [S3] [`src/opencode-transparent.ts`](../../src/opencode-transparent.ts)：模型準備 970–1058，reason 捨棄 1023–1025，工具還原與 hooks。
- [S4] [`src/plugin-options.ts`](../../src/plugin-options.ts)、[`src/opencode.ts`](../../src/opencode.ts)、HTTP／WS／SDK adapters：預設值、V2 入口、協定與 injected fetch 限制；詳細盤點見 [阻擋影響](2026-10-11-current-blocking-impact.md)，舊全域／重現狀態以 S1 為準。
- [R1] [官方 npm latest metadata](https://registry.npmjs.org/@rehydra%2fopencode/latest)：本輪確認 0.14.0、repository 與相依版本。
- [R2] [先前同日官方／SG／EightDoor 隔離比較](2026-10-11-official-rehydra-v2-comparison.md)：官方 V2 載入失敗與捕獲原值；SG 拒絕政策是 P0／P1 調整前快照，不能代表目前 SG 全部行為。
- [R3] [官方 0.14.0 發布來源稽核](2026-10-11-rehydra-current-source-audit.md)：版本集合、tarball integrity、實際五個 hooks、system/title 缺口、混合失敗政策、memory-only 與 NER 邊界；內附 npm／固定 gitHead／一手文件來源與發布檔行號。本輪沒有執行官方 package 或新增模型比較測試。
