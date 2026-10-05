# Provider／transport 參考實作研究：OpenCode hooks、SDK 初始化與可逆遮罩

研究日期：2026-10-05。範圍：指定三個 primary-source repos，另以 OpenCode 官方固定版本 source／migration docs 核對 host 行為。只讀 source、manifest、官方文件及測試程式；**沒有啟動 OpenCode、執行這些 SDK／plugin、安裝套件、讀取實際 credentials 或呼叫模型 API**。沒有使用 star 數或既有助理報告作為證據。

## 1. 結論與證據分級

**不能把這三個專案概括為「可直接用於此處 OpenCode v2.0.23 的全 provider 透明保護」。**

- **VibeGuard 是 Go HTTP(S) 攔截代理，不是 OpenCode plugin**。有 JSON prompt-like 欄位遮罩、JSON／SSE 回應還原，以及預設關閉的 WebSocket beta；不保證完整 provider 協定覆蓋，數個不支援／錯誤情況會原樣轉送。[VG-tree]、[VG-go]、[VG-req]、[VG-ws-enable]
- **Rehydra 有兩條不同的路徑**：`@rehydra/opencode` 是 V1 形狀的 messages／tools hooks；`rehydra/proxy` 則有 OpenAI **Chat Completions**、Anthropic **Messages** 的 JSON／SSE adapters。後者不是 Responses／WS 通用 adapter；前者也不能以「provider-agnostic」推論可在 V2 執行。[RH-pkg]、[RH-plugin-pkg]、[RH-hooks]、[RH-providers]、[RH-openai]、[RH-anthropic]、[OC2-migration]
- **opencode-vibeguard 0.1.0 是 V1 plugin**，沒有宣告任何 `@opencode-ai/plugin` 或 `@opencode/plugin` 相依版本；只有三個 hooks、沒有 wire transport adapter，也沒有 SDK/provider 名稱拒絕機制。[OV-pkg]、[OV-hooks]
- 本地 `src/opencode-transparent.ts` 與以上 V1 實作不同：它註冊 V2 四種 request kinds 及 HTTP hooks，**在實際 AI SDK 路徑的 `sdk`／`language` hooks 主動拋錯**，不是等 provider messages 序列化時才遮罩。OpenCode v2.0.23 host 的 `AISDK.language` 在取得／建立 SDK 與 language model 階段執行這些 hooks。[LOCAL-hooks]、[OC2-aisdk]

本文使用以下等級，避免把實作存在與實際可用混為一談：

| 等級 | 意義 |
|---|---|
| **S：source 已實作** | 固定 SHA 的直接程式碼存在對應分支；可以作為實作參考，不等於端到端可用。 |
| **T：測試 source 存在** | repo 中有相應測試／mock；本文沒有執行，不宣稱測試已通過。 |
| **D：官方文件宣稱** | 原作者文件的設計／使用說明；若比 source 範圍寬，採 source 的較窄範圍。 |
| **R：runtime verified** | 本次實際執行驗證；**本文沒有任何 R 結論**。 |

本文的「遮罩後可還原」在本地詞彙中屬可逆**假名化（pseudonymize）**，不是不可逆 redact；Rehydra API 雖名為 `anonymize`，session 本身要求有 PII map 的 `pseudonymize` mode。[LOCAL-language]、[RH-session]

## 2. 固定版本、套件與 repo 規則

GitHub API 解析研究當下各 repo 的 default branch HEAD，再以完整 SHA 讀 raw source；permalink 全部固定 SHA，不以移動中的 `main` 為證據。commit 日期是 GitHub 回傳的 committer 日期，不是研究日期。

| Repo／補充 host | 固定 commit SHA | Commit 日期（UTC） | Manifest／版本判讀 |
|---|---|---|---|
| [inkdust2021/VibeGuard](https://github.com/inkdust2021/VibeGuard/commit/12a46784a7ebca95f7765178edd8344a974da849) | `12a46784a7ebca95f7765178edd8344a974da849` | 2026-03-26 06:27:04 | Go module `github.com/inkdust2021/vibeguard`；Go 1.24.0、toolchain 1.24.3、`goproxy` 1.8.2；沒有 `package.json`。`internal/version/version.go` 的預設值是 `dev`／`unknown`，由 build ldflags 改寫，不能由此認定某發布 binary 的版本。[VG-go]、[VG-version]、[VG-tree] |
| [rehydra-ai/rehydra-sdk](https://github.com/rehydra-ai/rehydra-sdk/commit/5d4fb85bc1fbf63a4395aa10a11307806116ce6a) | `5d4fb85bc1fbf63a4395aa10a11307806116ce6a` | 2026-09-06 08:53:49 | root 套件 `rehydra` **0.14.0**；另有 `@rehydra/opencode` **0.14.0**，相依 `rehydra: ^0.14.0`；root exports 包含 `./proxy`、`./opencode-plugin`。[RH-pkg]、[RH-plugin-pkg] |
| [inkdust2021/opencode-vibeguard](https://github.com/inkdust2021/opencode-vibeguard/commit/f965b33468bafa27ac0654a04f5ed3c7c29c9b13) | `f965b33468bafa27ac0654a04f5ed3c7c29c9b13` | 2026-03-01 05:10:03 | `opencode-vibeguard` **0.1.0**，ESM，entry／exports `./src/index.js`；manifest 沒有 dependencies／peerDependencies／devDependencies。[OV-pkg] |
| OpenCode 官方 **v2.0.23**（補充） | `0fd7e2829449b052abf0078666669302923d77af` | 2026-10-05 05:24:37 | `packages/plugin/package.json` 是 **`@opencode/plugin` 2.0.23**。[OC2-pkg] |
| OpenCode 官方 **v1.2.10**（歷史 caller 對照，補充） | `296250f1b7e1ec992a3a33bee999f5e09a1697d0` | 2026-02-20 11:18:40 | `packages/plugin/package.json` 是 **`@opencode-ai/plugin` 1.2.10**。這是可重現的 V1 source 範例，**不是兩個第三方 plugin 的已知必需／相容版本**。[OC1-pkg] |

指定三個 repo 的完整 recursive tree（API `truncated: false`）均沒有找到 `AGENTS.md`／`CLAUDE.md`；不是忽略存在的規則。補充 OpenCode source 讀取相應 root／package／docs 規則；本地 root `AGENTS.md` 為空，另遵循 `CLAUDE.md`、`CONTEXT.md` 與 `docs/agents/domain.md`。沒有編輯符號、commit 或重建索引；此 session 沒有可呼叫的 GitNexus query/context 工具，因此本地補充核對只採指定檔案直接閱讀。[VG-tree]、[RH-tree]、[OV-tree]、[OC2-rules]、[OC2-plugin-rules]、[OC2-ai-rules]、[OC2-www-rules]、[OC2-docs-rules]、[OC1-rules]、[OC1-core-rules]、[LOCAL-rules]、[LOCAL-domain]

## 3. 真正的 hook 名稱與 OpenCode 世代

### 3.1 第三方 plugin 的精確 hook keys

下表只列程式實際回傳的 keys；README 的 `messages.transform`／`text.complete` 簡寫不能當 runtime 註冊名稱。

| 實作 | 實際 keys／入口 | OpenCode plugin 套件相依 |
|---|---|---|
| VibeGuard | 無 OpenCode hooks；`proxy.NewServer` → `Server.setupHandlers` 的 `OnRequest().DoFunc`／`OnResponse().DoFunc`。[VG-init]、[VG-req]、[VG-ws-enable] | 無 JS plugin manifest；它是代理。[VG-tree]、[VG-go] |
| Rehydra `createRehydraPlugin` | `experimental.chat.messages.transform`、`experimental.chat.system.transform`、`tool.execute.before`、`tool.execute.after`、`experimental.text.complete`。[RH-hooks]、[RH-tool-hooks] | types 是**自行宣告**「matches signatures from `@opencode-ai/plugin`」，刻意避免 hard runtime dependency；`@rehydra/opencode` entry 仍是 `(ctx) => Promise<Hooks>`。兩個 manifests 沒有 `@opencode-ai/plugin`／`@opencode/plugin` 版本約束。[RH-plugin-types]、[RH-plugin-entry]、[RH-pkg]、[RH-plugin-pkg] |
| opencode-vibeguard `VibeGuardPrivacy` | `experimental.chat.messages.transform`、`experimental.text.complete`、`tool.execute.before`；**沒有** `chat.message`、system hook、tool-after、compaction／title hook。[OV-hooks]、[OV-restore-hooks] | 沒有依賴任一 OpenCode plugin 套件；從 manifest **無法推導**使用的是哪個 host 版本。[OV-pkg] |

Rehydra `plugin.ts` 的範例仍出現 `@rehydra/opencode-plugin`，但此 SHA 實際 package 名稱及 README 安裝名稱是 **`@rehydra/opencode`**；core subpath 是 **`rehydra/opencode-plugin`**。採 manifest／entry，不把過時註解當已發布套件證據。[RH-plugin-types]、[RH-plugin-pkg]、[RH-plugin-entry]、[RH-plugin-doc]

### 3.2 V2 不只是改套件名稱

OpenCode v2.0.23 官方 migration docs 明說 **「V1 plugin implementations do not run in V2」**；V2 Promise API 是 default export `{ id, setup(ctx) }`，不是回傳 hook object 的函數。`PluginModule.load` 還直接驗證 default export 是否有 `id` 與 `effect` 或 `setup`，不符合時產生 `LoadError`。[OC2-migration]、[OC2-plugin-type]、[OC2-module]

因此，固定 SHA 的 **Rehydra plugin 與 opencode-vibeguard 均不能原封不動視為此處 V2 可用 plugin**。這是 source／官方契約不符的結論，不是本次實際啟動所得的 runtime 錯誤；VibeGuard 的外部代理路徑則不依賴這個 JS plugin 契約，但仍未驗證此環境代理、CA 或 protocol 實際可用。[RH-plugin-entry]、[OV-hooks]、[OC2-module]、[VG-init]

V2 對應關係如下，**是 migration destinations，不全是單純 rename**：[OC2-migration]

| V1 hook | V2 API／限制 |
|---|---|
| `chat.message` | `ctx.session.hook("prompt", ...)`；在 durable prompt admission 前，不是 final model boundary。 |
| `experimental.chat.messages.transform`／`experimental.chat.system.transform` | `ctx.session.hook("context", ...)` 修改 `event.messages`／`event.system`。 |
| `experimental.session.compacting` | `ctx.session.hook("compaction", ...)`。 |
| 全 model request 內容保護 | **分別**註冊 `context`、`compaction`、`generate`、`title`；只註冊 `context` 不涵蓋另外三種 caller。 |
| `experimental.text.complete` | 沒有可假定的一對一 V2 替代；官方要求依 V2 session/provider/model/event APIs 重新評估。 |
| Tool hooks | `ctx.tool.hook("execute.before", ...)`／`ctx.tool.hook("execute.after", ...)`。 |
| Transport hooks | `ctx.session.hook("http.request", ...)`／`"http.response"`；WS 是 `experimental.ws.handshake`／`send`／`receive`。 |

V2 `SessionModelRequest.prepare` 在 shaping hook 之後建立 `LLMRequest`，再處理 `model.request`（routing／headers），並用 HTTP／WS wrappers 連接 final transport。`primary` → `context`，其餘各自 trigger `compaction`／`generate`／`title`，source 已清楚分開。[OC2-request]

## 4. SDK 初始化拒絕，還是 messages 邊界處理？

| 路徑／版本 | 初始化行為 | 實際內容處理位置 | 能否說「在 LLM SDK/provider 初始化就拒絕」？ |
|---|---|---|---|
| VibeGuard @ VG SHA | `NewServer` 建 mapping manager、代理 transport、CA／WAL 相關資源；WAL key／初始化可能報錯。這不是模型 SDK 初始化。[VG-init] | client **已序列化**的 HTTP request body，`setupHandlers` → `RedactJSONBody`；回應在 client 消費前 restore。[VG-req]、[VG-response] | **不能**。代理不持有 OpenCode/provider SDK 初始化 hooks。 |
| Rehydra OpenCode plugin 0.14.0 | `createRehydraPlugin` 建 in-memory key/storage/anonymizer，`await anonymizer.initialize()` 後回傳 hooks；預設初始化會發現／讀 `.env*` 作辨識字典。這是在建**保護 SDK**，不是拒絕特定 LLM provider。[RH-plugin-init]、[RH-core-init] | `experimental.chat.messages.transform` 改 OpenCode message parts；並非先拒絕模型 SDK 名稱。[RH-hooks] | **沒有 provider 類別拒絕的 source**。保護 SDK 初始化本身可能因配置／NER 等失敗，但與「禁用所有 AI SDK route」不同。[RH-core-init] |
| Rehydra fetch/proxy 0.14.0 | `createRehydraFetch` 同步驗證 tool-loop 配置；第一個 wrapper fetch 呼叫執行 `ensureInitialized`，失敗回 503。provider 選擇是之後的 `detectProvider`。[RH-fetch-init]、[RH-providers] | 解析**已序列化** JSON → adapter 擷取字串 → session 假名化 → 重建 body → `JSON.stringify` → upstream `fetch`。[RH-fetch-request] | **不能**稱 LLM SDK init gate；是 request-time 保護 SDK／內容處理。未識別 provider 預設選 OpenAI，不拒絕。[RH-providers] |
| opencode-vibeguard 0.1.0 | `loadConfig`／patterns；`enabled=false` 回 `{}`，缺配置也會 no-op。[OV-init]、[OV-config] | OpenCode message parts，發生在 provider messages 的轉換／序列化前；另在 tool-before／text-complete 還原。[OV-hooks]、[OC1-main] | **沒有** SDK/provider 初始化 hooks；配置無效不是 fail-closed 保護。[OV-init]、[OV-config] |
| 本地 transparent guard | `createTransparentSessionGuard` 建 pseudonymizer，失敗回全拒絕 guard；正常模式仍令 `ctx.aisdk.hook("sdk")`、`"language"` 拋 `UNSUPPORTED_ROUTE_ERROR`。[LOCAL-init]、[LOCAL-hooks] | 另外在四種 request kinds 保護 snapshot、HTTP request 最終重遮罩、HTTP response 還原。[LOCAL-request]、[LOCAL-http] | **有，針對實際 AI SDK route**。V2 `AISDK.language` 的 `runSDK`／`runLanguage` 是 SDK/language 建立／解析階段，payload 沒有 messages。[OC2-aisdk]、[OC2-aisdk-type] |

**重要順序差異**：V1 host 範例的正常主流程先 `experimental.chat.messages.transform`，再 `MessageV2.toModelMessages` → `processor.process` → `LLM.stream`；`LLM.stream` 取得 provider language，後續交給 AI SDK。兩個 V1 plugins 的保護發生在這條 caller 路徑，不是在 provider 初始化時拒絕。[OC1-main]、[OC1-processor]、[OC1-llm]

**不要僅憑配置中看到 `@ai-sdk/openai` 就認定本地必然觸發 AI SDK 拒絕**：V2 `AISDKNative.rewrite`／`PACKAGES` 可以將一些舊 SDK specifiers 重寫為 `@opencode/ai/providers/*`；例如 OpenAI、Anthropic、OpenAI-compatible 都有 native 映射。要區分「配置字串」「解析後 model package／route」與「實際觸發的 hooks」；本文未解析或啟動本地實際模型配置。[OC2-native]、[OC2-aisdk]、[LOCAL-hooks]

## 5. Tools、assistant text 與未知 marker

### 5.1 opencode-vibeguard 0.1.0

- `VibeGuardPrivacy` 的 messages hook 逐一改 `text`（略過 `ignored`）、`reasoning`、tool `state.input` 的 string leaves，及 completed `state.output`／error `state.error`／pending `state.raw`。`redactDeep`／`restoreDeep` 只遍歷 Array／PlainObject **值**，不更名 object keys，也不處理數字。[OV-hooks]、[OV-deep]
- `tool.execute.before` → `restoreDeep(output.args, session)`，原地改參數供本機工具；**沒有** tool-after hook。工具輸出是在下一次 messages hook 重遮罩，不是 tool 執行後立即遮罩。[OV-restore-hooks]、[OV-hooks]
- Assistant 還原在 `experimental.text.complete` → `restoreText(output.text)`。V1 host 是 `processor` 的 `text-end` 才 trigger；不是每一段 streaming delta。不能據此宣稱串流途中 UI 已顯示原值，亦不會自動還原 reasoning/title。[OV-restore-hooks]、[OC1-text]
- marker 格式是 `__VG_<CATEGORY>_<HMAC12>__`，session 每次產生隨機 secret，mapping 以 OpenCode session ID 分開；有 TTL cleanup／容量 eviction。[OV-session]、[OV-init]
- **未知、已過期、被 eviction 或不符合 regex 的 marker 不會拒絕 tool call**：`restoreText` 使用 `session.lookup(ph) ?? ph`，未映射者留原樣；因此本機工具可能接到未還原字串。與本地 unknown-token fail-closed 不同。[OV-restore]、[OV-session]、[LOCAL-tool]
- 沒有 system／tools-schema／HTTP／WS hook；不能把源碼註解「provider 永遠看不到真值」擴張為涵蓋所有欄位、caller 或 transport 的保證。[OV-hooks]、[OV-restore-hooks]、[OC1-title]、[OC1-compaction]

### 5.2 Rehydra：OpenCode plugin 與 proxy 必須分開

**OpenCode plugin：**

- `createRehydraPlugin` 的 messages hook 以每則 message 的 `info.sessionID` 取得 session；保護任意 part 的 `.text`、tool input string leaves（建立新容器，不改 JSON keys）、tool error、completed tool output。這不是全 request JSON 遞迴掃描；file 的 binary/url、工具 schema、metadata、system 原文沒有由此自動得到覆蓋。[RH-hooks]
- `experimental.chat.system.transform` 只是 `hasAnonymized` 為真時 push PII 使用指示，**沒有遮罩原本 system 字串**；該旗標在 plugin instance 層，不是每個 session 一個旗標。[RH-plugin-init]、[RH-system]
- `tool.execute.before` → `deepRehydrate(output.args)`；`tool.execute.after` 對整個 output shape 深度還原，兼容 native `{title, output, metadata}` 與 MCP result 的 string values。這是**本地還原，不是出站遮罩**，後續再靠 messages hook 保護被 replay 的欄位。[RH-deep]、[RH-tool-hooks]、[RH-hooks]
- Assistant 在 `experimental.text.complete`，只處理帶 tag prefix 的 `output.text`；沒有 token-by-token response transport adapter。[RH-tool-hooks]、[OC1-text]
- Package README **直接承認 session title request 繞過 messages hook**；提議停用 title agent 是其 V1 文件處置，不是本文修改本地 V2 配置，也不是 V2 相容性證據。[RH-plugin-doc]

**Fetch/proxy：**

- `createRehydraFetch` 透過 content provider 擷取已知欄位；OpenAI 上行只遍歷 `messages[].content` 的字串／`type:"text"` parts，並未在初始 request adapter 遍歷 assistant `tool_calls[].function.arguments` 或 tools schema。Anthropic 額外處理 `system` 和 `tool_result.content` 的文字，但同樣沒有在這個初始 extraction 遮罩 `tool_use.input`。[RH-openai]、[RH-anthropic]
- 一般 JSON response：`rehydrateJSONResponseFromBody` 還原 assistant text，另以 provider `extractResponseToolCalls`／`rebuildResponseToolCalls` 還原 tools arguments；SSE：`rehydrateSSEResponse` 對 assistant text 與各 tool-call index 暫存跨片段 PII tags 再重建 provider events。[RH-fetch-response]、[RH-fetch-sse]、[RH-openai-tools]、[RH-anthropic-tools]
- **可選 `onToolCall` tool loop 是另一個範圍**：回呼前還原 args，回呼結果用 `session.anonymizeJson` 遮罩，並在下一次送模型前重遮罩 assistant tool-call args。不能把這個受控 loop 的保障移植成「任意外部 client 重播 tools args 都已保護」。[RH-fetch-loop]、[RH-json-walk]
- README 與 source 的 streaming tool-loop 實作是先 buffer 初始 stream、驗證完整 tools，continuation 用 `stream:false`，最後再發 provider-compatible SSE；有此能力不代表維持逐 token latency。[RH-readme]、[RH-fetch-stream-loop]

**未知 marker 有兩個不同情況：**

1. **PII map 存在，但特定 `type/id` 不存在**：`pipeline/tagger.rehydrate` 只在 `piiMap.get(key) !== undefined` 時替換，否則保留 marker，不因 marker 未知而拋錯；`strict` 是匹配模式，不是「unknown marker 必須拒絕」選項。[RH-rehydrate]
2. **整個 session map 不存在**：`AnonymizerSessionImpl.rehydrate` 會拋 `No PII map found for session`；解密／key 失敗也可能拋錯。Plugin tool/text hooks 沒有吞掉這個錯誤。相反，proxy SSE 的 lazy `getPiiMap` 在 map 缺失時回空 Map，讓未知 tags 留原樣。不能說 Rehydra 所有還原入口都 fail-open 或都 fail-closed。[RH-session]、[RH-deep]、[RH-tool-hooks]、[RH-fetch-sse]

### 5.3 VibeGuard @ VG SHA

- `NewServer` 建一個 `session.Manager` 供這個 proxy server 使用，**不是按 OpenCode session ID 分隔的 sessions map**；還原發生在 response／WS 下行、尚未交回 client 時。[VG-init]、[VG-response]、[VG-ws]
- `promptredact.RedactJSONBody` 主要辨識 `messages`／`input`／`contents` 下的字串、message `content`／`parts`／`text` 及 text parts。刻意保留 model/schema/metadata；`<system-reminder...></system-reminder>` text part 也有跳過分支。它不是任意 JSON string leaves 都遮罩。[VG-json]
- OpenAI tool result 若以 message `content` 字串出現會走此通路；**沒有專門的** `tool_calls.function.arguments`、Anthropic `tool_use.input`／nested `tool_result.content` 或 Responses `function_call.arguments`／`function_call_output.output` extractor。其完整 tools 往返不能視為支持已證實。[VG-json]
- JSON response 還原是 `restore.Engine.Restore(body)` 的 byte-level 替換，不只 assistant text；SSE 先拆 event，recognized delta 可跨 event 還原，其他 event fallback 為單 event 的 byte-level 還原。對 JSON 字串插入含引號／反斜線等原值的協定安全性，不能單憑這種替換宣稱已驗證。[VG-response]、[VG-sse]、[VG-restore]
- **未知 marker 留原樣**：`Engine.Restore` 只加入查表成功的 replacements；支援完整 prefix，也容忍丟失前導／尾端 underscores 的 marker 正規化。這與 opencode-vibeguard 的完整 regex 形式不完全相同。[VG-restore]、[OV-restore]、[OV-session]
- WS 下行會在工具執行之前先還原 frame 中已知 marker；它不是 local tool-before hook，不知道具體工具的 shell／schema 安全性。[VG-ws]

## 6. Transport／API 支持矩陣：只列 source 證實的子集合

**所有列的本次 R 狀態均為「未驗證」**。下表「S 已實作」不能讀成「完整協定／此 host 已可用」。

| 專案／路徑 | Chat Completions | Responses | Anthropic Messages | WebSocket |
|---|---|---|---|---|
| **VibeGuard @ VG SHA** | **S 部分**：`messages[].content` 上行；JSON 回應 generic restore。SSE `choices[].delta.content` 沒有專用跨 event extractor，不能宣稱完整 streaming 支持。[VG-json]、[VG-sse] | **S 部分**：`input` 的字串／content/text；SSE root string `delta`（名稱／type 含 delta）可跨 event 還原。這是 Responses-like text shape，不是完整 Responses API support。[VG-json]、[VG-sse] | **S 部分**：`messages[].content` text、SSE `delta.text`；top-level `system` 文字及 nested tools payload 沒有完整覆蓋。[VG-json]、[VG-sse] | **S＋T beta**：未壓縮 UTF-8 text frames，含 text fragmentation 重組；預設關閉，binary／control／RSV frames 透傳，壓縮／無可寫連線 fallback 透傳。[VG-ws]、[VG-ws-enable]、[VG-config]、[VG-ws-test] |
| **Rehydra fetch/proxy 0.14.0** | **S＋T**：OpenAI adapter 明確讀 `messages`／`choices`，JSON、SSE assistant content、tools arguments 有實作；初始 tool-history extraction 仍有上述界線。[RH-openai]、[RH-openai-tools]、[RH-fetch-response]、[RH-fetch-test] | **未有已證實 adapter**。OpenAI adapter 的輸入是 `messages`，不是 Responses `input`；不能因 URL 是 OpenAI 就算支持 Responses。[RH-openai]、[RH-providers] | **S＋T**：system、messages text、tool_result text；JSON text／tool_use input 還原、SSE text_delta／input_json_delta。初始 tool_use input 出站遮罩不是此 adapter 的已知能力。[RH-anthropic]、[RH-anthropic-tools]、[RH-stream-test] | **未證實**。所核對 wrapper 是 Fetch Request→Response／SSE，不是 WS frame／upgrade handler。[RH-fetch-init]、[RH-fetch-sse]、[RH-proxy] |
| **Rehydra OpenCode plugin 0.14.0** | 保護 host messages parts，沒有自己的 wire-format adapter。[RH-hooks] | 同左；不能用 plugin 的抽象層推導 Responses runtime。 | 同左；有無轉換取決於 host，且 caller 可繞過。 | 沒有自身 WS hooks／adapter；host transport 是否仍通過被保護 caller 未驗證。[RH-hooks]、[RH-tool-hooks] |
| **opencode-vibeguard 0.1.0** | 抽象 messages 層，沒有自身 Chat adapter。 | 沒有自身 Responses adapter。 | 沒有自身 Anthropic adapter。 | 沒有自身 WS adapter；沒有 runtime 證據。[OV-hooks]、[OV-restore-hooks] |
| **本地 transparent source 快照** | source 明確呼叫 `remaskChatCompletionsRequest`／`restoreChatCompletionsResponse`；本文未進一步驗證 adapter 或 endpoint／runtime。[LOCAL-http] | **不能列支持**：此次本地直接閱讀不證實 Responses adapter。 | **不能列支持**：此次本地直接閱讀不證實 Anthropic adapter。 | **source 明確拒絕**三個 WS hooks；AI SDK route 也拒絕。[LOCAL-hooks] |

### 6.1 為何「provider-agnostic」不等於通用 wire 保護

- Rehydra plugin／opencode-vibeguard 改的是 host message parts，**在設計上不需要知道 provider wire schema**；這不證明所有 callers 都經過 hooks、所有 payload 欄位都被保護、或 V2 相容。[RH-hooks]、[OV-hooks]、[OC1-main]、[OC2-migration]
- Rehydra proxy registry 的 built-ins **只有 OpenAI、Anthropic**；auto-detect 用 URL/header，不驗證每個 API endpoint。OpenAI 若 URL 含 `api.openai.com` 或 auth 以 `Bearer sk-` 起頭即匹配；Anthropic 以域名／`x-api-key`／`anthropic-version` 匹配；不匹配時反而 fallback OpenAI。**OpenAI 域名上的 Responses request 也可能被選成 OpenAI adapter，但那不是 Responses 支持**；缺 `messages` 的 body 會在其 `rebuildRequestBody` 遇到非可迭代值，位於 wrapper 的 request-time error handling 範圍，而非 SDK init 拒絕。[RH-providers]、[RH-openai]、[RH-anthropic]、[RH-fetch-request]
- VibeGuard generic proxy 的高層攔截不依賴特定 LLM SDK；但 HTTP masking 的 schema allowlist、SSE delta shapes、WS frame 限制都收窄了實際覆蓋。[VG-json]、[VG-sse]、[VG-ws]
- VibeGuard **不支援就原樣轉送**的例子包括未知 encoding、body 太大、解壓錯誤、非 UTF-8，以及遮罩導致 valid JSON 變 invalid JSON 的 rollback。其「能轉送某 API」不能當「該 API 已安全遮罩」證據。[VG-skip]、[VG-req]

### 6.2 測試證據的上限

- Rehydra `test/opencode-plugin/plugin.test.ts` 明寫直接以 **mock input/output** 呼叫 hooks；不是啟動真 OpenCode。`test/proxy/rehydra-fetch.test.ts` 建本地 echo HTTP server，驗證 Chat Completions JSON／SSE；streaming-tool-loop 測試用 `vi.stubGlobal('fetch')`。它們是 T，不是本次測試結果或真 upstream 的 R。[RH-plugin-test]、[RH-fetch-test]、[RH-stream-test]
- VibeGuard `transform_conn_test.go` 有 masked text／restore／JSON prompt-only 測試，JSON fixture 更明寫 `type:"response.create"` 與 `input_text`。這是 **Responses-like WS text frame 的直接測試 source**，不是完整 OpenAI Responses WS 協定或 OpenCode v2.0.23 E2E 證明。[VG-ws-test]
- opencode-vibeguard manifest 有 `node --test` script，但固定 SHA 的完整 tree 沒有看到測試檔；**有 script 不代表實際有覆蓋或通過**。[OV-pkg]、[OV-tree]

## 7. 哪些 callers 可能繞過：title／compaction

### 7.1 V1 host 的可重現證據（v1.2.10，不外推所有版本）

1. **主流程**：`SessionPrompt` 在 `prompt.ts:648` trigger `experimental.chat.messages.transform`，之後 `MessageV2.toModelMessages` 才送 `processor.process`。這是兩個第三方 V1 plugins 的主要保護邊界。[OC1-main]
2. **Title**：`ensureTitle` 在主 loop `step === 1` 時就被啟動；本身取得第一個 user/history，直接 `LLM.stream(...)`，沒有 messages transform。Title 處理也是讀 `result.text` 後 `Session.setTitle`，不經 `SessionProcessor` 的 text-complete 還原。Rehydra 現行 README 額外直接承認這項 limitation。[OC1-title-start]、[OC1-title]、[RH-plugin-doc]
3. **Compaction**：`SessionCompaction.process` 只 trigger `experimental.session.compacting`，再直接將 `MessageV2.toModelMessages(input.messages, model)` 交給 `processor.process`；兩個第三方 plugin 都沒有註冊此 hook。它**繞過 messages 遮罩**，但仍經 processor，故 text-end 的 `experimental.text.complete` 還可能執行。不能把「compaction 輸出可以還原」誤認成「compaction 輸入已遮罩」。[OC1-compaction]、[OC1-processor]、[OC1-text]、[RH-hooks]、[OV-hooks]
4. `LLM.stream` 仍會 trigger system transform；但 Rehydra 的 system hook只追加 placeholder 指示，不遮罩輸入，而 opencode-vibeguard 根本沒 system hook。故「title／compaction 繞過全部 hooks」也不精確：真正缺的是**messages 保護 hook**，不同 lifecycle hooks 的覆蓋不同。[OC1-llm]、[RH-system]、[OV-hooks]

沒有以「正常 chat 看似遮罩成功」推論 title 或 compaction 安全。若歷史訊息剛好已被先前 mutation 遮罩，那只是狀態相依，不能代替所有 caller 每次出站的保護。[OC1-main]、[OC1-title]、[OC1-compaction]

### 7.2 V2 host 要另外查，不沿用 V1 結論

v2.0.23 `SessionTitle.attempt` 呼叫 `context.request.title`，compaction `prepare` 呼叫 `requests.compaction`；`SessionModelRequest` 分別 trigger 各 request-kind hook。因此 V2 **不是沒有 title／compaction hook**；但只註冊 context 的 plugin 仍不涵蓋它們。[OC2-title]、[OC2-compaction]、[OC2-request]、[OC2-migration]

此外 v2.0.23 compaction source 自己指出：某 summary prompt 在 request hooks **之後** append，部分縮減歷史還會重建先前 summary，可能丟掉 compaction hook 的 edit。這更顯示 request-kind hook 不能被當成最後一個不可繞過的序列化邊界；若要宣稱 final wire 保護，還須驗證 transport adapter。[OC2-compaction-late]、[OC2-request]

代理方式（VibeGuard 或 Rehydra fetch/proxy）**不以 title 名稱決定保護**；只有當 title／compaction 真正經過該代理且 payload shape 受支援時才可能覆蓋。本文沒有驗證本地這兩種 caller 的 route／proxy 設定。[VG-req]、[RH-fetch-request]

## 8. 本地 `opencode-transparent.ts` 的直接對照

本地補充來源是研究當下 working tree，**不是上游固定 SHA 的一部分，也不是既有報告的摘要**：

- 工作目錄 HEAD：`b47ed0a792ddd1731d09ebbceb22228efbacea60`；`src/opencode-transparent.ts` 當時為 untracked。
- `src/opencode-transparent.ts` SHA-256：`c9ac30e7430958ccdbc8152cb370963815d483c89b6a52496189e371999058cf`。
- 本地 `package.json` SHA-256：`037920e906d78b601f290dc787ec4608997c5c19bb90f0f3f8c9909177032c85`。
- 因未提交檔案不存在可靠 public permalink，以下明確使用**本地路徑／行號＋內容 hash**，不偽造 GitHub permalink。

| 本地事實 | 精確 source |
|---|---|
| 使用 `import type ... from "@opencode/plugin"`，不是 `@opencode-ai/plugin`。 | `src/opencode-transparent.ts:39–54`。[LOCAL-import] |
| 本地 manifest 同時宣告 `@opencode-ai/plugin:^1.17.18`（dependencies）與 `@opencode/plugin:^2.0.19`（devDependencies）；直接讀 node_modules manifests 所得安裝值分別為 **1.17.18**、**2.0.19**。不是 v2.0.23；range 不等於 resolved version，也不證明 host 相容。 | `package.json`、`node_modules/@opencode-ai/plugin/package.json`、`node_modules/@opencode/plugin/package.json`（只讀）。[LOCAL-pkg]、[LOCAL-installed-v1]、[LOCAL-installed-v2] |
| 正常 guard 註冊 `context`／`compaction`／`generate`／`title`、HTTP request/response、三個 WS hooks、aisdk sdk/language、tool execute.before。 | `createTransparentSessionGuard().setup`，`src/opencode-transparent.ts:778–837`。[LOCAL-hooks] |
| `protectRequestKind` 保護 system/messages/options/tools 的 snapshot，結構檢查成功後才發布；不是 `session:prompt` admission 修改。 | `src/opencode-transparent.ts:561–625`；未註冊 hooks 的意圖也在 `29–33`。[LOCAL-request]、[LOCAL-comment] |
| `aisdk sdk`／`language` 的正常 callback 都直接 throw `UNSUPPORTED_ROUTE_ERROR`，WS 三個 callback 同樣拒絕；**未按不同 provider 設例外**。 | `src/opencode-transparent.ts:804–829`；錯誤文案在 `67–68`。[LOCAL-hooks] |
| SDK init 階段的對照：host 先 `runSDK`，再 `runLanguage`，然後才選 `result.language ?? sdk.languageModel(...)`，language cache hit 可直接 return。拒絕是相關 hooks 真正執行時的行為，不是每個已有 cached language 都必定重跑。 | OpenCode v2.0.23 `packages/core/src/aisdk.ts:314–358`。[OC2-aisdk] |
| `onHttpRequest` 最終重遮罩，WeakMap 記 request→session/kind；`onHttpResponse` 先核對 attribution 才呼叫 ChatCompletions response 還原函數。 | `src/opencode-transparent.ts:627–655`。[LOCAL-http] |
| `tool:execute.before` 在 token-bearing input 上還原，未知／malformed token 轉 refusal error；shell-like tools 另外限制 literal-argument 形式，不是任意字串替換。 | `toolRestoreError:80–83`、`restoreLeaf:665–680`、`onToolBefore:757–776`。[LOCAL-tool] |
| 故意不註冊 tool-after，讓本地原值在 outbound replay 才保護；source header 明寫 stage 1／offline mocks only。不能當本次 E2E 成功證據。 | `src/opencode-transparent.ts:1–36`。[LOCAL-comment] |

只憑上述本地 guard source，沒有進一步認定 HTTP adapter 支持 Responses／Anthropic、所有 restored assistant unknown markers 的策略、實際有載入此 guard、或「native route 因不走 aisdk hook 就必定可用」。這些都仍需各自的 final-wire／caller／runtime 證據。[LOCAL-http]、[LOCAL-hooks]、[OC2-native]

## 9. 可採取的判斷與尚未驗證事項

### 9.1 可操作結論（不修改本地配置）

| 目的 | 有直接 source 根據的選擇 | 不能承諾的部分 |
|---|---|---|
| 參考前序列化 messages／tool-local 邊界 | 兩個 V1 plugins 可提供實作思路：tools 真值執行、historical args/output 再遮罩、text-complete 還原。[OV-hooks]、[RH-hooks]、[RH-tool-hooks] | 不能直接安裝當 V2 plugin；需按官方 V2 `id/setup` 及各 kind hooks 移植。[OC2-migration]、[OC2-module] |
| 做 Chat Completions／Anthropic 的 HTTP JSON/SSE 參考 | Rehydra 0.14.0 有明確 provider adapters、response tool-args 還原與可選 tool loop，可作具體 adapter 參考。[RH-openai]、[RH-anthropic]、[RH-fetch-loop] | 不把既有 tools-history extraction、binary attachments、未知 markers 或 endpoints 推廣成全字段 fail-closed；Responses／WS 不在已證實 adapter 集合。[RH-providers]、[RH-rehydrate] |
| 做 Responses-like WS frame 參考 | VibeGuard 有 text-frame transformer 與 `response.create` fixture，可研究 frame masking／fragmentation 的實作。[VG-ws]、[VG-ws-test] | beta 預設關閉，有多種 pass-through；不宜作安全邊界已完備的背書。[VG-config]、[VG-ws-enable] |
| 評估本地 AI SDK 拒絕原因 | 對照實際 resolved route 與 `aisdk:sdk/language` hooks；source 的拒絕在 SDK/language resolution，不在 marker 還原或訊息內容判斷。[OC2-aisdk]、[OC2-native]、[LOCAL-hooks] | 不以 provider 名稱或配置套件字串猜測 hook 是否觸發；沒有本地 runtime 證據。 |
| 防止 title／compaction 漏出 | V1 要另外處理 caller；Rehydra 文件的停用 title 是 V1 workaround。V2 要分別保護四種 request kinds 並核對 final transport。[RH-plugin-doc]、[OC1-title]、[OC1-compaction]、[OC2-request] | 只使用 messages/context hook、或只見到 title output 還原，不足以證明 inputs 已遮罩。 |

### 9.2 明確未驗證

- **三個 repos 與此處 OpenCode v2.0.23 的實際端到端可用性：均未執行驗證。**其中兩個 V1 plugin 的原樣入口更已有官方 V2 契約不符證據。[OC2-module]、[RH-plugin-entry]、[OV-hooks]
- 此處正在使用的 OpenCode binary 是否精確對應官方 v2.0.23 SHA、實際載入的插件版本／配置、native／AI SDK／WS route 選擇、SDK/language cache、title/compaction 模型：未啟動／未讀真 credentials，故未確認。
- npm 已發布 tarball 是否與本文 SHA／manifest／build 相同、SemVer ranges 的實際下載結果，以及 VibeGuard 發布 binary／ldflags：未查驗發布 artifacts。[RH-plugin-pkg]、[OV-pkg]、[VG-version]
- Live OpenAI Chat Completions、Responses HTTP／WS、Anthropic upstream 的接受／回應行為、工具 side effects、跨 session／重啟／expired mapping、完整 streaming 順序、JSON escaping、二進位／壓縮附件：沒有 R 證據。
- Rehydra／VibeGuard 的現存測試**只閱讀 source**，沒有 run 或 CI passing 的結論；不把測試存在當成實際通過。[RH-plugin-test]、[RH-fetch-test]、[RH-stream-test]、[VG-ws-test]
- 未把「沒有在所核對 adapters 中找到」寫成所有未讀分支／所有未來版本永遠不支持；本文結論固定於上述 SHA 與列明的檔案／入口。

---

## 10. 精確來源索引（全部外部 source links 固定 SHA）

### VibeGuard — `12a46784a7ebca95f7765178edd8344a974da849`

[VG-tree]: https://api.github.com/repos/inkdust2021/VibeGuard/git/trees/12a46784a7ebca95f7765178edd8344a974da849?recursive=1
[VG-go]: https://github.com/inkdust2021/VibeGuard/blob/12a46784a7ebca95f7765178edd8344a974da849/go.mod#L1-L16
[VG-version]: https://github.com/inkdust2021/VibeGuard/blob/12a46784a7ebca95f7765178edd8344a974da849/internal/version/version.go#L1-L8
[VG-init]: https://github.com/inkdust2021/VibeGuard/blob/12a46784a7ebca95f7765178edd8344a974da849/internal/proxy/proxy.go#L93-L158
[VG-req]: https://github.com/inkdust2021/VibeGuard/blob/12a46784a7ebca95f7765178edd8344a974da849/internal/proxy/proxy.go#L422-L640
[VG-skip]: https://github.com/inkdust2021/VibeGuard/blob/12a46784a7ebca95f7765178edd8344a974da849/internal/proxy/proxy.go#L509-L596
[VG-response]: https://github.com/inkdust2021/VibeGuard/blob/12a46784a7ebca95f7765178edd8344a974da849/internal/proxy/proxy.go#L774-L925
[VG-json]: https://github.com/inkdust2021/VibeGuard/blob/12a46784a7ebca95f7765178edd8344a974da849/internal/promptredact/json.go#L13-L277
[VG-sse]: https://github.com/inkdust2021/VibeGuard/blob/12a46784a7ebca95f7765178edd8344a974da849/internal/stream/reader.go#L398-L646
[VG-restore]: https://github.com/inkdust2021/VibeGuard/blob/12a46784a7ebca95f7765178edd8344a974da849/internal/restore/engine.go#L27-L180
[VG-ws]: https://github.com/inkdust2021/VibeGuard/blob/12a46784a7ebca95f7765178edd8344a974da849/internal/wsproxy/transform_conn.go#L28-L267
[VG-ws-enable]: https://github.com/inkdust2021/VibeGuard/blob/12a46784a7ebca95f7765178edd8344a974da849/internal/proxy/proxy.go#L739-L760
[VG-config]: https://github.com/inkdust2021/VibeGuard/blob/12a46784a7ebca95f7765178edd8344a974da849/internal/config/config.go#L147-L155
[VG-ws-test]: https://github.com/inkdust2021/VibeGuard/blob/12a46784a7ebca95f7765178edd8344a974da849/internal/wsproxy/transform_conn_test.go#L16-L154

### Rehydra — `5d4fb85bc1fbf63a4395aa10a11307806116ce6a`

[RH-tree]: https://api.github.com/repos/rehydra-ai/rehydra-sdk/git/trees/5d4fb85bc1fbf63a4395aa10a11307806116ce6a?recursive=1
[RH-pkg]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/package.json#L1-L149
[RH-plugin-pkg]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/packages/opencode-plugin/package.json#L1-L37
[RH-plugin-entry]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/packages/opencode-plugin/index.js#L1-L10
[RH-plugin-types]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/opencode-plugin/plugin.ts#L28-L109
[RH-plugin-init]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/opencode-plugin/plugin.ts#L111-L232
[RH-hooks]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/opencode-plugin/plugin.ts#L233-L361
[RH-system]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/opencode-plugin/plugin.ts#L363-L371
[RH-deep]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/opencode-plugin/plugin.ts#L59-L91
[RH-tool-hooks]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/opencode-plugin/plugin.ts#L373-L431
[RH-plugin-doc]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/packages/opencode-plugin/README.md#L1-L110
[RH-core-init]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/core/anonymizer.ts#L335-L577
[RH-fetch-init]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/proxy/rehydra-fetch.ts#L90-L168
[RH-fetch-request]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/proxy/rehydra-fetch.ts#L170-L285
[RH-fetch-response]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/proxy/rehydra-fetch.ts#L330-L396
[RH-fetch-stream-loop]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/proxy/rehydra-fetch.ts#L288-L325
[RH-fetch-loop]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/proxy/rehydra-fetch.ts#L445-L572
[RH-fetch-sse]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/proxy/rehydra-fetch.ts#L579-L747
[RH-providers]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/proxy/providers/index.ts#L18-L57
[RH-openai]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/proxy/providers/openai.ts#L76-L167
[RH-openai-tools]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/proxy/providers/openai.ts#L169-L233
[RH-anthropic]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/proxy/providers/anthropic.ts#L56-L195
[RH-anthropic-tools]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/proxy/providers/anthropic.ts#L197-L275
[RH-proxy]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/proxy/rehydra-proxy.ts#L52-L143
[RH-session]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/storage/session-base.ts#L51-L173
[RH-json-walk]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/utils/json-walk.ts#L22-L59
[RH-rehydrate]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/src/pipeline/tagger.ts#L705-L744
[RH-readme]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/README.md#L130-L136
[RH-plugin-test]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/test/opencode-plugin/plugin.test.ts#L1-L127
[RH-fetch-test]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/test/proxy/rehydra-fetch.test.ts#L7-L187
[RH-stream-test]: https://github.com/rehydra-ai/rehydra-sdk/blob/5d4fb85bc1fbf63a4395aa10a11307806116ce6a/test/proxy/streaming-tool-loop.test.ts#L1-L65

### opencode-vibeguard — `f965b33468bafa27ac0654a04f5ed3c7c29c9b13`

[OV-tree]: https://api.github.com/repos/inkdust2021/opencode-vibeguard/git/trees/f965b33468bafa27ac0654a04f5ed3c7c29c9b13?recursive=1
[OV-pkg]: https://github.com/inkdust2021/opencode-vibeguard/blob/f965b33468bafa27ac0654a04f5ed3c7c29c9b13/package.json#L1-L35
[OV-init]: https://github.com/inkdust2021/opencode-vibeguard/blob/f965b33468bafa27ac0654a04f5ed3c7c29c9b13/src/index.js#L15-L41
[OV-hooks]: https://github.com/inkdust2021/opencode-vibeguard/blob/f965b33468bafa27ac0654a04f5ed3c7c29c9b13/src/index.js#L43-L121
[OV-restore-hooks]: https://github.com/inkdust2021/opencode-vibeguard/blob/f965b33468bafa27ac0654a04f5ed3c7c29c9b13/src/index.js#L123-L144
[OV-deep]: https://github.com/inkdust2021/opencode-vibeguard/blob/f965b33468bafa27ac0654a04f5ed3c7c29c9b13/src/deep.js#L1-L82
[OV-restore]: https://github.com/inkdust2021/opencode-vibeguard/blob/f965b33468bafa27ac0654a04f5ed3c7c29c9b13/src/restore.js#L1-L14
[OV-session]: https://github.com/inkdust2021/opencode-vibeguard/blob/f965b33468bafa27ac0654a04f5ed3c7c29c9b13/src/session.js#L22-L146
[OV-config]: https://github.com/inkdust2021/opencode-vibeguard/blob/f965b33468bafa27ac0654a04f5ed3c7c29c9b13/src/config.js#L34-L87

### OpenCode 官方 v2.0.23 — `0fd7e2829449b052abf0078666669302923d77af`

[OC2-pkg]: https://github.com/anomalyco/opencode/blob/0fd7e2829449b052abf0078666669302923d77af/packages/plugin/package.json#L1-L39
[OC2-migration]: https://github.com/anomalyco/opencode/blob/0fd7e2829449b052abf0078666669302923d77af/services/www/src/docs/content/build/plugins/migrate-v1.mdx#L5-L171
[OC2-plugin-type]: https://github.com/anomalyco/opencode/blob/0fd7e2829449b052abf0078666669302923d77af/packages/plugin/src/promise/plugin.ts#L26-L65
[OC2-module]: https://github.com/anomalyco/opencode/blob/0fd7e2829449b052abf0078666669302923d77af/packages/core/src/plugin/module.ts#L60-L116
[OC2-aisdk-type]: https://github.com/anomalyco/opencode/blob/0fd7e2829449b052abf0078666669302923d77af/packages/plugin/src/promise/aisdk.ts#L1-L22
[OC2-aisdk]: https://github.com/anomalyco/opencode/blob/0fd7e2829449b052abf0078666669302923d77af/packages/core/src/aisdk.ts#L301-L358
[OC2-native]: https://github.com/anomalyco/opencode/blob/0fd7e2829449b052abf0078666669302923d77af/packages/core/src/aisdk-native.ts#L19-L145
[OC2-request]: https://github.com/anomalyco/opencode/blob/0fd7e2829449b052abf0078666669302923d77af/packages/core/src/session/model-request.ts#L203-L412
[OC2-title]: https://github.com/anomalyco/opencode/blob/0fd7e2829449b052abf0078666669302923d77af/packages/core/src/session/title.ts#L48-L98
[OC2-compaction]: https://github.com/anomalyco/opencode/blob/0fd7e2829449b052abf0078666669302923d77af/packages/core/src/session/compaction.ts#L575-L592
[OC2-compaction-late]: https://github.com/anomalyco/opencode/blob/0fd7e2829449b052abf0078666669302923d77af/packages/core/src/session/compaction.ts#L285-L478
[OC2-rules]: https://github.com/anomalyco/opencode/blob/0fd7e2829449b052abf0078666669302923d77af/AGENTS.md
[OC2-plugin-rules]: https://github.com/anomalyco/opencode/blob/0fd7e2829449b052abf0078666669302923d77af/packages/plugin/AGENTS.md
[OC2-ai-rules]: https://github.com/anomalyco/opencode/blob/0fd7e2829449b052abf0078666669302923d77af/packages/ai/AGENTS.md
[OC2-www-rules]: https://github.com/anomalyco/opencode/blob/0fd7e2829449b052abf0078666669302923d77af/services/www/AGENTS.md
[OC2-docs-rules]: https://github.com/anomalyco/opencode/blob/0fd7e2829449b052abf0078666669302923d77af/services/www/src/docs/AGENTS.md

### OpenCode 官方 v1.2.10（歷史 caller 對照）— `296250f1b7e1ec992a3a33bee999f5e09a1697d0`

[OC1-pkg]: https://github.com/anomalyco/opencode/blob/296250f1b7e1ec992a3a33bee999f5e09a1697d0/packages/plugin/package.json#L1-L28
[OC1-main]: https://github.com/anomalyco/opencode/blob/296250f1b7e1ec992a3a33bee999f5e09a1697d0/packages/opencode/src/session/prompt.ts#L648-L677
[OC1-title-start]: https://github.com/anomalyco/opencode/blob/296250f1b7e1ec992a3a33bee999f5e09a1697d0/packages/opencode/src/session/prompt.ts#L327-L334
[OC1-title]: https://github.com/anomalyco/opencode/blob/296250f1b7e1ec992a3a33bee999f5e09a1697d0/packages/opencode/src/session/prompt.ts#L1888-L1959
[OC1-compaction]: https://github.com/anomalyco/opencode/blob/296250f1b7e1ec992a3a33bee999f5e09a1697d0/packages/opencode/src/session/compaction.ts#L140-L200
[OC1-processor]: https://github.com/anomalyco/opencode/blob/296250f1b7e1ec992a3a33bee999f5e09a1697d0/packages/opencode/src/session/processor.ts#L45-L55
[OC1-text]: https://github.com/anomalyco/opencode/blob/296250f1b7e1ec992a3a33bee999f5e09a1697d0/packages/opencode/src/session/processor.ts#L287-L335
[OC1-llm]: https://github.com/anomalyco/opencode/blob/296250f1b7e1ec992a3a33bee999f5e09a1697d0/packages/opencode/src/session/llm.ts#L59-L248
[OC1-rules]: https://github.com/anomalyco/opencode/blob/296250f1b7e1ec992a3a33bee999f5e09a1697d0/AGENTS.md
[OC1-core-rules]: https://github.com/anomalyco/opencode/blob/296250f1b7e1ec992a3a33bee999f5e09a1697d0/packages/opencode/AGENTS.md

### 本地 working-tree 快照（沒有 public permalink）

[LOCAL-rules]: ../../CLAUDE.md
[LOCAL-domain]: ../agents/domain.md
[LOCAL-language]: ../../CONTEXT.md
[LOCAL-pkg]: ../../package.json
[LOCAL-installed-v1]: ../../node_modules/@opencode-ai/plugin/package.json
[LOCAL-installed-v2]: ../../node_modules/@opencode/plugin/package.json
[LOCAL-import]: ../../src/opencode-transparent.ts#L39-L54
[LOCAL-comment]: ../../src/opencode-transparent.ts#L1-L36
[LOCAL-init]: ../../src/opencode-transparent.ts#L368-L409
[LOCAL-request]: ../../src/opencode-transparent.ts#L561-L625
[LOCAL-http]: ../../src/opencode-transparent.ts#L627-L655
[LOCAL-hooks]: ../../src/opencode-transparent.ts#L778-L837
[LOCAL-tool]: ../../src/opencode-transparent.ts#L665-L776
