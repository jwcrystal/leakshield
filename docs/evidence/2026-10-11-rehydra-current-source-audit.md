# 官方 `@rehydra/opencode` 現況發布來源稽核

查核日：2026-10-11。只研究官方套件；EightDoor 的 `opencode-rehydar@0.14.3` 是另一比較對象，不混稱官方。
本輪是背景、唯讀來源研究：未安裝或執行第三方 package、未呼叫模型、未讀個人 auth/log/prompt；**V2 runtime 未重測**。

## 結論

- 官方插件 `latest` 仍為 **0.14.0**、`main: index.js`；其 `rehydra ^0.14.0` 目前最高相容穩定發布版也仍是 **0.14.0**，沒有比既有實測更新的 dependency。[R1][R2]
- 發布入口是 **V1 async plugin function**，不是 V2 `id/setup/effect` definition。V2 文件要求後者，且不自動翻譯 V1 hooks。[A] L1–10；[P] L71–72、324；[V2]
- 既有 OpenCode **v2.0.25** 隔離證據記錄載入失敗、chat 原值未遮罩；**這不是本輪重跑，也不能拿來證明官方 V1 引擎的遮罩／工具還原失敗**。[E] L3、21–44、72–74
- 失敗政策是混合的：env 檔讀取失敗略過、leak-scan 告警不拒絕、真正 anonymize/rehydrate 例外往上拋、未知 tag 可留 placeholder；不能概括成「全部 fail-open」或「完整 fail-closed」。[C] L254–267、286–373；[S] L23–101；[T] L523–543
- 插件預設本地偵測、記憶體 mapping/key；**不提供 provider HTTP/WS final-wire 防線、持久化 mapping，或逐 delta 串流還原**。SDK 有其他 API，不等於插件已採用。[P] L13–324；[DS][DST]

## Verified — source verified

### 來源固定與發布一致性

已核對兩份官方 npm tarball 的 SHA-512 與 registry integrity 相符。現有隔離 `0.14.0` 的 SDK 110 個 JS/README 檔與 tarball 逐檔相同；插件入口也與 npm `gitHead` 的 GitHub 檔案相同。兩套件 `gitHead` 都是 `5d4fb85bc1fbf63a4395aa10a11307806116ce6a`；GitHub 引文固定此 commit，**不是 main HEAD**。[R1][R2][A][G]
以下 P/C/S/T/N 行號均指 **npm `rehydra@0.14.0` tarball 發布 JS**；B 指插件 tarball README。現行網站文件未綁此版本，若與發布碼不同，以發布碼判定本套件行為。

### 實際覆蓋

| 面向 | 發布來源所能證明的行為／界線 | 證據 |
|---|---|---|
| 註冊 hooks | 恰有 `experimental.chat.messages.transform`、`experimental.chat.system.transform`、`tool.execute.before`、`tool.execute.after`、`experimental.text.complete`；都是 V1 hook 名稱。 | [P] L175–321 |
| messages | 處理 `part.text`；遞迴匿名化 tool `state.input` 的字串值、字串 `state.error`，以及 completed tool 的字串 `state.output`。不遞迴掃描所有 message metadata、物件鍵名或非文字附件。 | [P] L176–260 |
| system | `hasAnonymized` 曾設為 true 才 **追加** placeholder 使用指令；沒有掃描／遮罩原有 `output.system`。不是 system secret 防線。 | [P] L174、279–284 |
| options／tool schemas | 沒有 provider options、headers、工具定義／description／schema 的掃描或 transform；messages 中 tool input 的處理不能外推成 schema 覆蓋。 | [P] L13–324 |
| 工具還原 | before 深走 args 的陣列／物件**字串值**；after 深走輸出字串值；物件鍵名不還原。這是執行前／結果還原，不是工具 transport 攔截。 | [P] L31–52、285–311 |
| HTTP／WS final-wire | 插件沒有包裝 provider `fetch`、HTTP body 或 WebSocket `send`；只有上述 hooks。不能保證 hooks 外模型呼叫或 host 後續重組 payload 都受保護。 | [P] L13–324；[B] L7、42 |
| title 呼叫 | **發布 README 明示**：獨立 title LLM 呼叫跳過 messages hook，首訊 secrets 可能原值外送；這是發布文件界線，非本輪 V2 重測。 | [B] L27–42 |
| 串流 | 回應還原只掛 `experimental.text.complete`；沒有逐 delta／SSE／WS frame 還原。SDK 另有 sentence-buffer streaming API，但插件未接入。 | [P] L312–320；[DST] |
| session mapping | 以 OpenCode `sessionID` 找 `Map` 中的 session；anonymize 載入舊 map、合併並保存，已有映射可重用 ID。 | [P] L164–172、180；[S] L23–88；[T] L145–179 |
| 持久化／restart | 插件固定建立 `InMemoryKeyProvider`、`InMemoryPIIStorageProvider`，並在 advanced config 展開後覆寫這兩項；無磁碟 mapping/key。process restart 不保留它們，SDK 的 SQLite 能力不能套用成插件預設承諾。 | [P] L78–104；[DS] |

### 失敗政策：分清「沒有偵測到」、「告警」與「丟例外」

| 情況 | 發布碼行為 | 證據 |
|---|---|---|
| env 掃描 | 單一 env 檔讀取／解析 try 區塊失敗會被 catch 略過，可能少了 literal secret；檔案解析路徑 `resolveFiles` 在 catch 外，並非所有掃描錯誤都略過。 | [C] L254–267 |
| detector／redact 例外 | registry recognizer、NER predict、加密或 storage 的例外沒有在 message hook 中轉成「回傳原文」；Promise rejection 往上傳。**host 最終是否阻止請求，本輪未驗證**。 | [C] L286–373；[S] L23–88；[P] L176–278 |
| leak-scan／validation 未通過 | 預設 `enableLeakScan: true`，但只執行可選 warning callback；預設 callback 為 null，仍回傳結果／stats。不是強制殘餘原值拒絕閘門。 | [Y] L61–62；[C] L78、330–373 |
| rehydrate 缺 map／解密錯誤 | 缺整份 session map 明確 throw；解密錯誤也往上傳；插件沒有吞掉後原樣放行的 catch。 | [S] L90–101；[P] L31–52、285–320 |
| 未知／無對應 tag | **map 已存在**但 tag 找不到原值時保留 placeholder，不 throw；before hook 不檢查剩餘 tag，故可能把它交給工具。這與「整份 map 不存在」不同。 | [T] L523–543；[S] L101；[P] L285–296 |

### 本地、可選模型、效能與成本

- **預設**：regex／secret patterns＋env literal values；NER `mode: disabled`，semantic masking 也停用。插件預設 env glob 是專案下 `**/.env*`，值最短 4 字元、初始化讀一次；預設排除 URL／IP 偵測，`vcsIdentities` 要明確 opt-in。[P] L81–111；[C] L85、101、110–130、248–272；[B] L23–25、112–116
- **可選本地 NER**：文件說它補人名、組織、地點等 soft PII；OpenCode guide 明示會增加顯著延遲、不推薦預設使用。這是官方文件的定性描述，**不是本輪 benchmark**。[DN][DP]
- **可選 inference-server NER**：必須配置 backend／URL。發布 client 實際向 `${url}/v1/predict` POST `{text, confidence_threshold}`，而 core 在匿名化前傳入正規化全文；若 URL 是遠端，這段未匿名全文會送該服務。不是預設額外呼叫主 LLM。[N] L28–60；[C] L298–330；[DN]
- **文件差異**：現行 NER guide 寫「tokenized text／logits」，但 `0.14.0` 發布 client 傳的是 `text`、讀的是 entities；不可用文件的 tokenized 說法淡化遠端資料外送。[DN]；[N] L36–54
- 預設沒有遠端 NER 推論請求，不代表主 LLM 免費或零本地耗用；SDK 的 `processingTimeMs` 也不是整體 OpenCode 體驗耗時。吞吐量、p95、false positive/negative、provider token／金額差異：**未量測，沒有可引用的比較數字**。[C] L290、341–350；[P] L81–104

## Inferred — 推論，不冒充重測

- 對目前 V2 使用者，首先要比較的是**插件能否載入**，而不是把未遮罩的 baseline 當成「官方還原更順」。來源 ABI 與既有 V2.0.25 證據一致，但不證明所有 OpenCode 版本都不能用。[A][V2][E]
- 若在相容 host 成功跑 hooks，設計上能讓本地工具／完成文字取得原值；未知 placeholder 或上拋例外則可能妨礙工具操作。restart 後即使從歷史重建 mapping，也不能只憑此原碼保證舊 tag／ID 正確恢復。[P][S][T]

## Open — V2 runtime 未重測／未驗證

- 本輪沒有重新啟動 V2、安裝插件、做 chat／tool／provider 呼叫或 failure injection；既有載入錯誤原文為 `Plugin must export a default definition with an id and an effect or setup function`。[E] L35–42
- 成功載入後的 V1/V2 hook 排序、host 對 rejection 的政策、restart 舊 tag、串流期間 placeholder 是否可見、HTTP/WS 實際 wire 零外送：**本輪未驗證**，不得從 SDK 功能或來源意圖外推。
- 與 Sensitive Guard 的偵測準確率、延遲／成本、長上下文、fork/reorder 的量化體驗差異：此來源稽核**沒有新增比較實測**；應另引用相同 host／fixture 的證據。

## 原始來源索引

- R1：[@rehydra/opencode registry][R1]，含 latest、repository、dependency、gitHead、integrity；[官方插件 tarball][PT]。
- R2：[rehydra 完整版本 registry][R2]，用來查 `^0.14.0` 目前發布集合；[官方 SDK tarball][SDK]。
- A：[發布 commit 的 `packages/opencode-plugin/index.js`][A]；G：[同 commit `src/opencode-plugin/plugin.ts`][G]。
- P/C/S/T/N/Y：SDK tarball 的 `package/dist/opencode-plugin/plugin.js`／`core/anonymizer.js`／`storage/session-base.js`／`pipeline/tagger.js`／`ner/inference-server-client.js`／`types/index.js`；上文行號對應發布 JS。
- B：插件 tarball 的 `package/README.md`；[同發布 commit README][B]。
- DP/DN/DS/DST：官方現行 [OpenCode guide][DP]／[NER guide][DN]／[storage guide][DS]／[streaming guide][DST]，只作一手文件佐證，不視作版本綁定原碼。
- V2：[OpenCode V2 plugins guide][V2] 與 [plugin migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1)（definition 與 hooks 必須移植）；E：[既有隔離實測紀錄][E]，不是本輪重新執行。

[R1]: https://registry.npmjs.org/@rehydra%2fopencode
[R2]: https://registry.npmjs.org/rehydra
[PT]: https://registry.npmjs.org/@rehydra/opencode/-/opencode-0.14.0.tgz
[SDK]: https://registry.npmjs.org/rehydra/-/rehydra-0.14.0.tgz
[A]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/packages/opencode-plugin/index.js#L1-L10
[G]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/opencode-plugin/plugin.ts#L111-L431
[P]: https://registry.npmjs.org/rehydra/-/rehydra-0.14.0.tgz
[C]: https://registry.npmjs.org/rehydra/-/rehydra-0.14.0.tgz
[S]: https://registry.npmjs.org/rehydra/-/rehydra-0.14.0.tgz
[T]: https://registry.npmjs.org/rehydra/-/rehydra-0.14.0.tgz
[N]: https://registry.npmjs.org/rehydra/-/rehydra-0.14.0.tgz
[Y]: https://registry.npmjs.org/rehydra/-/rehydra-0.14.0.tgz
[B]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/packages/opencode-plugin/README.md
[DP]: https://docs.rehydra.ai/guides/opencode-plugin.md
[DN]: https://docs.rehydra.ai/guides/ner-detection.md
[DS]: https://docs.rehydra.ai/guides/sessions-storage.md
[DST]: https://docs.rehydra.ai/guides/streaming.md
[V2]: https://opencode.ai/v2/docs/build/plugins
[E]: ./2026-10-11-official-rehydra-v2-comparison.md
