# Coding agent 攔截能力調查：hook adapter 與 local proxy adapter 的選型依據

> **狀態：研究紀錄，尚未實作。** 這份文件只是選型依據；Sensitive Guard 目前只支援 OpenCode（plugin），不支援文中其他 agent。文中的 adapter 構想若要做，會另開 `docs/plans/` 的計畫。

研究日期：2026-10-15。範圍：Claude Code、OpenAI Codex CLI、Google Gemini CLI、Cursor（editor＋Cursor CLI）、pi coding agent、Command Code CLI。只讀官方文件站與官方 repo source（固定 commit SHA）；**沒有安裝或執行任何 agent、沒有啟動 proxy、沒有呼叫模型 API**。本文所有結論等級為 **D（官方文件宣稱）** 或 **S（source 已實作）**，沒有 **R（runtime verified）** 結論；等級定義沿用 `2026-10-05-provider-transport-reference-research.md`。

## 1. 結論

六個 agent 分成三類。**第一類**有完整的 in-process 改寫面，可以做到接近 OpenCode V2 的 transparent mode：pi（`before_provider_request` 可直接替換 provider-native payload，另有 `context`、`tool_call`、`tool_result`）、Command Code 的 mods（`transformContext`、`beforeToolCall`、`afterToolCall`），以及 Claude Code 的 mods（`prompt.submit`、`prompt.section`、`session.append`、`tool.call`）。**第二類**的 shell hooks 只能改寫工具輸入和輸出，改不了 user prompt、system/context files 和對話歷史，所以 hook-only 擋不住使用者自己貼進來的秘密：Claude Code 的 command hooks 屬於此類，Codex（工具輸出只能用 `decision:"block"` 的 feedback 間接替換）和 Gemini CLI（`BeforeModel` 只能改文字 parts，碰不到 `functionResponse`／`functionCall`／`systemInstruction`）更弱。**第三類**是 Cursor：所有請求都經 Cursor 後端組裝 prompt，BYOK 也一樣，所以本地 proxy 在結構上無法在資料離開本機前遮罩；hooks 也只能改工具輸入，只有 MCP 工具能改輸出，只適合 guard（阻擋）模式。把 base URL 指到 local proxy 的方式對 Claude Code（`ANTHROPIC_BASE_URL`，連 claude.ai subscription 登入也有效）、Codex（`openai_base_url`，ChatGPT 登入時同樣套用）、pi（`models.json` `baseUrl`）、Command Code BYOK（`providers.json` `baseURL`）都可行，而且 SG 現有的 Anthropic Messages／Responses（含 WS）／Chat Completions remaskers 可以直接重用。Gemini 的 wire 是 Gemini API 或 Code Assist `v1internal`，SG 目前沒有對應的 remasker。**建議第二個 adapter 做 Claude Code 的 local proxy adapter**：文件明確支援 subscription 經 gateway，wire 只有 Anthropic Messages 一種，可以整套重用 `remaskAnthropicMessagesRequest`／`createAnthropicSseRestoreStream`；背景 Haiku 呼叫（摘要、title、WebFetch 摘要）也走同一個 base URL，proxy 能涵蓋，hooks 不能。Codex proxy（Responses HTTP＋WS）排第三；pi 的 in-process adapter 成本最低，可以並行。

## 2. 比較表

縮寫：「阻擋」＝可拒絕或中止；「附加」＝只能附加 context；「改寫」＝可替換內容。

| 問題 | Claude Code | Codex CLI | Gemini CLI | Cursor | pi | Command Code |
|---|---|---|---|---|---|---|
| Q1 改寫送往模型的內容 | command hooks：prompt 只能阻擋＋附加，不可改寫[^cc1]；**mods** 可改寫 prompt、system prompt sections、首訊息 context、對話列[^cc2] | 只能阻擋＋附加（`UserPromptSubmit`）；沒有 model request hook[^cx1] | `BeforeModel` 可改寫 messages 的**文字 parts**；碰不到 tool call/result parts 和 system instruction[^gm1][^gm2] | `beforeSubmitPrompt` 只能阻擋[^cu1] | 可改寫：`input`、`before_agent_start.systemPrompt`、`context`、`before_provider_request`（整個 payload）[^pi1][^pi2] | hooks：不可（只有 context 注入）[^cm1]；**mods**：`transformInput`、`transformContext`（每次呼叫、ephemeral）、`appendSystemPrompt`（只能附加）[^cm2] |
| Q2 pre-tool 改寫工具輸入 | 可：`hookSpecificOutput.updatedInput`，所有工具（含 MCP）[^cc3] | 可：`updatedInput`（Bash／`apply_patch` 要 `command` 字串；MCP／function tools 用參數物件）[^cx2] | 可：`hookSpecificOutput.tool_input`（merge override）[^gm3] | 可：`preToolUse` `updated_input`（所有工具）[^cu2] | 可：in place mutate `event.input`（bash／read／edit／write／custom）[^pi3] | hooks：不可[^cm1]；mods：`beforeToolCall` 回傳 `input`[^cm2] |
| Q3 post-tool 改寫工具輸出 | 可：`updatedToolOutput`（所有工具）[^cc4] | 正式欄位不支援（`updatedMCPToolOutput` 會 fail open）；`decision:"block"`＋`reason` 會用 feedback **取代**工具結果[^cx3] | 不能直接改寫；`decision:"deny"`＋`reason` 會**取代**工具結果，另有 `tailToolCallRequest`[^gm3] | 只有 MCP：`updated_mcp_tool_output`；其他工具只能附加[^cu2] | 可：`tool_result` 回傳 `content`／`structuredContent`[^pi3] | hooks：只能附加／advisory[^cm1]；mods：`afterToolCall` 可改寫結果[^cm2] |
| Q4 base URL 與 wire | `ANTHROPIC_BASE_URL`；Anthropic Messages `/v1/messages`（SSE）；另有 Bedrock／Vertex 格式[^cc5] | `openai_base_url` 或 `model_providers.<id>.base_url`；只支援 Responses（HTTP SSE＋WS `/responses`）[^cx4] | `GOOGLE_GEMINI_BASE_URL`／`GOOGLE_VERTEX_BASE_URL`／`CODE_ASSIST_ENDPOINT`；Gemini `streamGenerateContent`（`alt=sse`）[^gm4] | 有「OpenAI-compatible base URL override」，但請求一律經 Cursor 後端；local proxy 不可行[^cu3] | `models.json` `providers.<id>.baseUrl`；`openai-completions`／`openai-responses`／`anthropic-messages`／`google-generative-ai` 等[^pi4] | BYOK `providers.json` `baseURL`；`openai-completions`／`openai-responses`／`anthropic-messages`[^cm3]；預設 plan endpoint 能否 override 未確認 |
| Q5 擴充機制 | command／http／mcp_tool／prompt／agent hooks（JSON stdin/stdout）；plugins；mods（JS in-process）[^cc6] | command／`mcp_tool` hooks（JSON）；plugins（skills＋MCP）[^cx5] | command hooks（JSON）；extensions（`gemini-extension.json`＋`hooks/hooks.json`＋MCP）[^gm5] | command／prompt hooks（JSON）；plugins；MCP[^cu4] | TypeScript extensions（jiti，in-process）、packages、SDK[^pi1] | command hooks（4 個事件）；TypeScript mods（jiti）；MCP；skills[^cm1][^cm2] |
| Q6 主要 caveat | subscription＋base URL 可用；cloud sessions 不讀本機設定；WebFetch 預檢會把 hostname 送給 Anthropic；hooks 會在 subagent 觸發[^cc7] | ChatGPT 登入同樣套用 base URL；`memories/trace_summarize`、analytics、hosted WebSearch 不走 hooks[^cx6] | compression 走 `BaseLlmClient`，不觸發 `BeforeModel`；Code Assist endpoint 文件標為測試用[^gm6] | 經後端組 prompt＋暫存檔案；Tab 不走 BYOK；cloud agents 只跑 project hooks[^cu5] | `before_provider_request` handler 丟錯會被吞掉（fail open）；沒有內建 subagent[^pi5] | BYOK 下背景任務全部用 session model；預設 plan 的背景任務走 Command Code[^cm4] |

## 3. 各 agent 詳細

### 3.1 Claude Code（Anthropic）

讀取：`code.claude.com/docs/en/*.md`，2026-10-15；mods reference 自稱「as of v2.1.290」。[CC-hooks]、[CC-mods-ref]

**Q1 改寫模型內容。** Hooks reference 列出「可以 rewrite 而非只 allow/block」的事件只有 `PreToolUse`（`updatedInput`）、`PermissionRequest`（`updatedInput`）和 `PostToolUse`（`updatedToolOutput`），並寫明 `UserPromptSubmit`「can't replace the prompt; it only injects `additionalContext` alongside it」，建議 redaction 在 `PreToolUse`／`PostToolUse` 做。`InstructionsLoaded` 沒有 decision control，不能改 CLAUDE.md 的載入內容。`PreCompact` 只能阻擋壓縮。`MessageDisplay` 的 `displayContent` 只改畫面，transcript 和送給 Claude 的內容維持原樣（可以用來還原顯示文字）。[CC-hooks] 因此 hook-only adapter 遮不到使用者 prompt、CLAUDE.md、system prompt 和既有歷史。

**Mods（JS in-process）的能力強很多**：`prompt.submit` 可以 `next({ ...e, text })` 改寫 prompt；`prompt.section` 逐段改寫或移除 system prompt section；`prompt.context` 改寫首訊息 context；`prompt.attachment` 改寫 reminder；`session.append` 在存入前改寫每一列的 text blocks 和 `tool_result` content；`tool.call` 可以改參數，也可以 `await next(e)` 之後改寫結果；`turn.step` 文件只列出換 model／effort 或直接回答，沒有改 messages 的能力。[CC-mods-ref]、[CC-mods-events] 「`session.append` 改寫的列是否就是下一次送給模型的內容」文件沒有直接寫明，列入待驗證。

**Q2／Q3。** `PreToolUse` 適用所有工具名（`EndConversation` 除外），包括 MCP（`mcp__.*`）；`updatedInput` 要搭配 `permissionDecision:"allow"`。`PostToolUse` 的 `updatedToolOutput`「Replaces the tool's output … before it is sent to Claude」，值必須符合該工具的 output shape；`updatedMCPToolOutput` 只適用 MCP。[CC-hooks]

**Q4。** `ANTHROPIC_BASE_URL`「Override the API endpoint to route requests through a proxy or gateway」。[CC-env] Gateway 協定只有 Anthropic Messages（`/v1/messages?beta=true`、可選 `/v1/messages/count_tokens`）、Bedrock InvokeModel（`ANTHROPIC_BEDROCK_BASE_URL`）、Vertex rawPredict（`ANTHROPIC_VERTEX_BASE_URL`）；串流是 SSE（`text/event-stream`，需保留 `ping`），Bedrock 是 binary eventstream。[CC-gw-proto] Proxy 必須原樣轉送 `anthropic-beta`／`anthropic-version`，否則會出現 400 或功能靜默失效。[CC-gw-proto]

**Q6 caveats。**
- **Subscription**：只設 `ANTHROPIC_BASE_URL` 而沒有 gateway credential 時，「Requests still route through the gateway, but a saved claude.ai login remains the active credential」，gateway 必須轉送 OAuth 相關的 `anthropic-beta`。所以 Pro/Max 使用者也能走 local proxy。[CC-gw]
- `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` 一旦設定，會忽略設定檔裡的 `ANTHROPIC_BASE_URL`（嵌入式 host 情境）。[CC-env]
- 背景用量：resume 用的對話摘要、部分指令會在背景呼叫模型，`ANTHROPIC_DEFAULT_HAIKU_MODEL` 也用於「background functionality」；內部 agent（prompt suggestions、`/btw`）也會觸發 `SubagentStop`。[CC-costs]、[CC-env]、[CC-hooks] 這些都不經 `UserPromptSubmit`，不過理應走同一個 base URL（未實測）。
- WebFetch domain safety check 會把 hostname（不含 path）送到 `api.anthropic.com`，不受 provider 和 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 影響；`skipWebFetchPreflight: true` 可以關閉。Metrics 宣稱不含 code、prompts、file paths。[CC-data]
- Cloud sessions 不讀本機 `~/.claude/settings.json`。[CC-hooks]
- **Subagent**：settings、managed、plugin hooks 會在 subagent 內觸發，輸入帶有 `agent_id`／`agent_type`；mods 的 `tool.call` 也涵蓋 subagent 的呼叫。[CC-hooks]、[CC-mods-events]

### 3.2 OpenAI Codex CLI

讀取：`developers.openai.com/codex/*.md`（308 轉址到 `learn.chatgpt.com/docs/*`），2026-10-15；source `openai/codex` main `3ee47c10513f1bb57d869ea650aba28638e3d11c`（2026-10-15），最新 release `rust-v0.162.1`（2026-10-09）。

**Q1。** Hook 事件有 `PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`UserPromptSubmit`、`SubagentStart/Stop`、`Stop`、`Interrupt`、`SessionStart/End`，沒有 model request 事件。`UserPromptSubmit` 只能 `additionalContext`（developer context）或 `decision:"block"`。[CX-hooks]

**Q2。** 「To rewrite a supported tool call without blocking, return `permissionDecision: "allow"` with `updatedInput`」；Bash 和 `apply_patch` 的 `updatedInput` 必須含字串 `command`，MCP 和其他 local function tools 則是替換整個參數物件。涵蓋表：shell、`exec_command`、`apply_patch`、MCP、其他 function tools 都支援 Pre/Post；hosted tools（例如 `WebSearch`）不支援；`write_stdin` 不會再觸發 `PreToolUse`。[CX-hooks] Source：`codex-rs/hooks/src/events/pre_tool_use.rs` 的 `latest_updated_input`（多個 hooks 時「last completed updated input wins」）。[CX-pre]

**Q3。** `PostToolUse` 的 `updatedMCPToolOutput` 和 `suppressOutput`「parsed but not supported yet」，回傳時該 hook 被標為失敗並 fail open；source 的 `unsupported_updated_mcp_tool_output_fails_open` 測試證實這點。不過 `decision:"block"` 會讓 Codex「replaces the tool result with that feedback」，也就是說可以把**重新遮罩後的輸出放進 `reason`** 間接替換，但模型看到的會是 feedback 文字而不是原本的工具格式（非正式用法，未實測）。[CX-hooks]、[CX-post]

**Q4。** `openai_base_url` 覆寫內建 `openai` provider；自訂 provider 用 `model_providers.<id>.base_url`。`wire_api` 只支援 `responses`（`"chat"` 會報錯 `CHAT_WIRE_API_REMOVED_ERROR`）。`supports_websockets` 控制 Responses WebSocket，內建 openai provider 預設為 `true`；有 WS→HTTP fallback metric（`transport.fallback_to_http`）。[CX-cfgref]、[CX-cfgadv]、[CX-mpi] Source `to_api_provider()`：只要設定了 `base_url` 就一律使用，沒設才依 auth mode 選 `https://chatgpt.com/backend-api/codex`（ChatGPT 登入）或 `https://api.openai.com/v1`。**所以 ChatGPT subscription 登入時 `openai_base_url` 仍然生效**，proxy 的上游要轉送到 ChatGPT backend。[CX-mpi] HTTP 路徑是 `/responses`，WS 由 `websocket_url_for_path("/responses")` 推導。[CX-ws] 安全限制：project-local `.codex/config.toml` 會忽略 `openai_base_url`、`model_provider(s)`，必須寫在 user-level `~/.codex/config.toml`。[CX-cfgadv]

**Q5。** Hooks 支援 command 和 `mcp_tool` handler，非 managed hooks 必須先經使用者 review／trust；plugins 由 skills 和 MCP 組成。[CX-hooks]、[CX-plugins]

**Q6。**
- 同一個 provider 上還有 `memories/trace_summarize` endpoint（`codex-rs/codex-api/src/endpoint/memories.rs`），會把 trace 送去摘要；proxy 必須處理或擋下這個非 `/responses` 路由，hooks 完全看不到。[CX-mem]
- Analytics 送到 `{base_url}/codex/analytics-events/events`；payload 是否含內容未確認。[CX-analytics]
- 有 remote compaction（`compact_remote_v2.rs`）；endpoint 細節未逐行確認。[CX-tree]
- Subagent：`SubagentStart` 可以注入 context；`Interrupt`／`SessionEnd` 不在 subagent 執行；文件說 `continue:false`「doesn't stop the subagent」，可見 hooks 會在 subagent 情境下執行，但 subagent 內工具呼叫是否觸發 `PreToolUse` 未逐條確認。[CX-hooks]
- 文件提醒 tool hooks「a useful guardrail, not a complete enforcement boundary」，部分特殊工具路徑可以不走 hook。[CX-hooks]

### 3.3 Google Gemini CLI

讀取：`google-gemini/gemini-cli` main `06d329873703ddabe8a842d962342ac4ad779e83`（2026-10-14），release `v0.64.0`（2026-10-13）；docs 取自同一 SHA 的 `docs/`。

**Q1。** `BeforeModel` 收到 `llm_request`（`model`、`messages`、`config`），回傳 `hookSpecificOutput.llm_request` 可以覆寫部分欄位，也可以回傳合成的 `llm_response`。[GM-hooks] 但 stable API 註明「Non-text parts are filtered out for hooks」。Source `hookTranslator.ts` 的 `fromHookLLMRequest` 把 hook 改過的文字合併回原本的 contents，**完整保留 `functionCall`／`functionResponse`／`inlineData` 等非文字 parts**；沒有文字的 content 原樣保留；`config` 只往返 `temperature`／`maxOutputTokens`／`topP`／`topK`。[GM-translator] 推論：工具結果（`functionResponse`）、工具參數（`functionCall.args`）和 `systemInstruction` 都**無法透過 hook 改寫**。`BeforeAgent` 只能附加或阻擋；`PreCompress` 是 advisory。`AfterModel` 可以逐 chunk 替換回應（可以用來還原顯示文字，但會影響存回歷史的內容）。[GM-hooks] Wiring 見 `geminiChat.ts` 的 `fireBeforeModelEvent` 和 `modifiedContents`。[GM-chat]

**Q2。** `BeforeTool` 的 `hookSpecificOutput.tool_input`「merges with and overrides the model's arguments before execution」。[GM-hooks]

**Q3。** `AfterTool` 沒有正式的輸出改寫欄位；`decision:"deny"` 時 `reason`「replaces the tool result sent back to the model」，exit 2 時 stderr 取代結果。可以用來替換成重新遮罩的輸出，但會以 deny 語意呈現（未實測模型反應）。`tailToolCallRequest` 會讓另一個工具的結果取代原結果。[GM-hooks]

**Q4。** Auth types：`oauth-personal`（Login with Google → Code Assist）、`gemini-api-key`、`vertex-ai`、`compute-default-credentials`、`gateway`（只要設了 `GOOGLE_GEMINI_BASE_URL` 就會被選中）。`GOOGLE_GEMINI_BASE_URL`／`GOOGLE_VERTEX_BASE_URL` 只對 API key／Vertex 生效，非 localhost 必須是 HTTPS。[GM-cg]、[GM-config] OAuth 走 Code Assist：`https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent`（`alt: 'sse'`），可用 `CODE_ASSIST_ENDPOINT` 覆寫，但文件標註「useful for development and testing」。[GM-ca]、[GM-config] Wire 是 Gemini `generateContent`／`streamGenerateContent` SSE（Code Assist 另外包一層 request envelope），**SG 目前沒有這種 remasker**。

**Q5。** Hooks 是 command（JSON stdin/stdout）；extensions 透過 `gemini-extension.json`（MCP、`contextFileName`、settings）加上 `hooks/hooks.json` 打包。[GM-hooks]、[GM-ext]

**Q6。**
- Compression 透過 `config.getBaseLlmClient().generateContent()`（`chatCompressionService.ts`），`baseLlmClient.ts` 裡沒有任何 hook 呼叫，所以 **compression 等 utility 呼叫不經 `BeforeModel`**。它們理應用同一個 content generator（同一個 base URL），proxy 可以涵蓋，但沒有逐路徑確認。[GM-compress]、[GM-base]
- Subagent：`local-executor.ts` 為 subagent 建立 `new GeminiChat(...)`，推論 `BeforeModel` 會觸發（未實測）。[GM-local]
- 遙測：OTEL telemetry 預設關閉、target `local`；`logPrompts` 預設 `true`（只在啟用 telemetry 時有意義）；另有可 opt-out 的 Usage Statistics 送往 Google。[GM-tel]、[GM-tos]

### 3.4 Cursor（editor＋Cursor CLI）

讀取：`cursor.com/docs/*.md`、`cursor.com/help/*.md`、`cursor.com/data-use`，2026-10-15。

**Q1。** `beforeSubmitPrompt` 在「before backend request」執行，只能 `continue: false` 阻擋；`beforeReadFile` 拿得到完整檔案內容，但只能 allow／deny；`preCompact` 只能觀察；`afterAgentResponse`／`afterAgentThought` 沒有輸出欄位。[CU-hooks]

**Q2。** `preToolUse` 適用所有工具（Shell、Read、Write、MCP、Task 等），`updated_input`「Modified tool input to use instead」。`beforeShellExecution`／`beforeMCPExecution` 只回傳 permission。[CU-hooks]

**Q3。** `postToolUse` 的 `updated_mcp_tool_output`「For MCP tools only: replaces the tool output seen by the model」；其他工具只有 `additional_context`。`afterShellExecution`／`afterFileEdit` 只能觀察。[CU-hooks]

**Q4。** BYOK 支援 OpenAI、Anthropic、Google、Azure、Bedrock；「all requests are routed through Cursor's servers for final prompt building」，Tab 繼續使用 Cursor 自家模型；BYOK 時不適用 ZDR。[CU-byok]、[CU-datause] 企業文件提到「custom model reached via an OpenAI-compatible base URL override」。[CU-gov] 推論：base URL 是由 Cursor 後端去連線，localhost proxy 連不到；即使 proxy 架在公網，原始內容也已經先到了 Cursor 後端，**不符合 SG 想在資料離開本機前遮罩的目的**。

**Q5。** Hooks：command 和 prompt-based；project 層 `.cursor/hooks.json`、user 層 `~/.cursor/hooks.json`、MDM／cloud（Enterprise）；plugins 可以打包 rules、skills、agents、commands、MCP、hooks。也會載入 Claude Code 格式的 hooks。[CU-hooks]、[CU-plugins] Cursor CLI 的 changelog 記錄了 hooks 支援（stdin payload、`afterAgentResponse`、讀取並合併 Claude Code `settings.json` hooks、plugin hooks）。[CU-cli-cl]

**Q6。** Cloud agents 只跑 command-based 的 project／team／enterprise hooks，不跑 user hooks，也沒有 `beforeMCPExecution`／`afterMCPExecution`；read-only 階段的早期 turns 不跑 hooks。[CU-hooks] 後端會暫存加密的檔案內容。[CU-datause] Instant Grep 在本機建索引，「does not upload file paths or code to build a search index」。[CU-search] `subagentStart/Stop` 存在，但 subagent 內的工具呼叫是否觸發 `preToolUse` 沒有明文。Fail-open：除了 schema 不符之外，crash、timeout、非 2 的 exit code 預設放行，需要設 `failClosed: true`。[CU-hooks]

### 3.5 pi coding agent

**身分確認**：`github.com/badlogic/pi-mono` 經 GitHub API 解析為 `earendil-works/pi`（描述「AI agent toolkit: unified LLM API, agent loop, TUI, coding agent CLI」）；`packages/coding-agent/package.json` 是 `@earendil-works/pi-coding-agent` 1.2.0，`author: "Mario Zechner"`。可以確認就是 Mario Zechner 的 pi，repo 已遷到 earendil-works org。讀取 SHA `eddebaeebf8168dfc31d6712b7a021e4df3b4e6a`，release `v1.2.0`（2026-10-12）。[PI-pkg]、[PI-readme]

**Q1。** `src/core/extensions/types.ts` 的事件與回傳型別：
- `input` → `{ action: "transform", text }` 改寫輸入。
- `before_agent_start` → `systemPrompt`「Replace the complete system prompt for this turn」。
- `context` → `{ messages }` 改寫訊息（不含 system，之後由 pi 還原）；`context_with_system` 則擁有包含 system 的完整 transcript。
- **`before_provider_request`**：「Fired before a provider request is sent. Can replace the payload.」Runner 只要 handler 回傳值不是 `undefined` 就替換 `currentPayload`。[PI-types]、[PI-runner]、[PI-ext] 這表示 SG 可以在 process 內把現有的 wire remaskers 直接套在 provider-native JSON 上，不需要另起 proxy。
- `message_end` 可以替換定稿訊息（role 不變）；`provider_stream_event` 是唯讀的。[PI-types]、[PI-ext]

**Q2／Q3。** `tool_call`：「To modify arguments, mutate `event.input` in place」，涵蓋 bash、powershell、read、edit、write、grep、find、ls 和 custom tools；`tool_result` 回傳 `content`／`structuredContent`／`isError` 替換結果，型別註解提醒「Handlers that redact `content` should also replace this」。[PI-types]

**Q4。** `models.json` `providers.<id>.baseUrl`＋`api`；`KnownApi` 包括 `openai-completions`、`openai-responses`、`azure-openai-responses`、`openai-codex-responses`、`anthropic-messages`、`bedrock-converse-stream`、`google-generative-ai`、`google-vertex` 等。[PI-models]、[PI-ai-types] OAuth 登入（`/login`）的 subscription provider 加上 `baseUrl` override 是否仍有效，未確認。

**Q5。** TypeScript extension（jiti 載入，免編譯），放在 `~/.pi/agent/extensions/` 或 project 目錄，與 pi process 同權限執行；也可以透過 packages／SDK／RPC 使用。[PI-ext]

**Q6。** `emitBeforeProviderRequest` 會 catch handler 的錯誤並繼續送出未修改的 payload（fail open），SG 必須自己確保不會丟錯，或另外加 fail-closed 機制。[PI-runner] README 寫明 pi「skips features like sub-agents」，沒有內建 subagent。[PI-readme] `PI_TELEMETRY` 控制 install/update telemetry 和 provider attribution headers，`PI_OFFLINE` 關閉自動網路活動。[PI-env] Compaction 的模型呼叫是否經過 `before_provider_request` 未確認。

### 3.6 Command Code CLI

**身分確認**：`commandcode.ai/docs/llms.txt` 寫明「Command Code is a frontier coding agent…」，安裝方式 `npm i -g command-code`，執行指令 `cmd`，「Taste profiles are stored locally in `.commandcode/taste/`」，和本 repo 的 `.commandcode/taste/taste.md` 吻合。npm `command-code` latest `1.82.3`，description「Command Code, coding agent that continuously learns your coding taste」。[CM-llms]、[CM-npm] 本 repo 的 `scripts/e2e/run-commandcode-plan-matrix.mjs` 使用 `createCommandCode({ apiKey, baseURL, plan })`（一個 AI SDK provider 套件），只能當線索，不當作產品證據。CLI 原始碼是否公開沒有確認：讀取 GitHub `CommandCodeAI/command-code` 的請求在本 session 被權限拒絕；mods 文件提到該 repo 有 `mods/registry.json`。

**Q1。** Hooks 只有 `PreToolUse`、`PostToolUse`、`Stop`、`SessionStart` 四個事件，工具只有 shell、read、write、edit；只有 command handler。`PreToolUse` 只能 allow／deny＋`additionalContext`，沒有 `updatedInput`；`PostToolUse`「No (advisory)」，只有 `decision:"block"`（advisory retry）和 `additionalContext`。[CM-hooks] **Mods**（TypeScript，jiti）：`transformInput`（只攔截真正打字輸入，不含 automated turns 和帶圖 prompt）、`transformContext`（「messages threaded mod→mod; result is EPHEMERAL - used for this call only」）、`appendSystemPrompt`（只能附加）。[CM-mods]

**Q2／Q3。** Mods 的 `beforeToolCall` 回傳 `{block?, input?, additionalContext?, terminate?}`；`afterToolCall` 可以「rewrite a result」。[CM-mods] Hooks 兩者都不行。[CM-hooks]

**Q4。** BYOK `~/.commandcode/providers.json`：`baseURL`＋`api`（`openai-completions` 預設 `/chat/completions`、`openai-responses` → `{baseURL}/responses`、`anthropic-messages` → `/v1/messages`）。[CM-byok] 預設的 Command Code plan「routes through your plan」；公開的 Provider API 是 `https://api.commandcode.ai/provider/v1/{chat/completions,responses,messages}`，但 CLI 預設 plan 實際使用哪個 endpoint、能否 override，文件都沒有寫。[CM-byok]、[CM-provider] ChatGPT/Codex subscription「Requests run locally from the CLI over your subscription」。[CM-byok]

**Q6。** 「all the side tasks default to the session model while a BYOK model is active」（compaction、summarization、sub-agents、title generation），所以 BYOK 加 proxy 能涵蓋這些背景呼叫；預設 plan 下，title、permission prompt descriptions、compaction 會用低成本 open models。[CM-byok]、[CM-faq] `settings.featureModels` 可以為 `titleGeneration`、`compaction`、`toolDescription`、`tasteOnboarding`、`tasteLearning`、`branchSummarization` 分別指定模型。[CM-settings] Telemetry 宣稱匿名、不含檔案內容，可用 `telemetry:false` 或 `DO_NOT_TRACK` 關閉。[CM-tel] 有 subagent 和 background agents；hooks 和 mods 是否在 subagent 內觸發未確認（mods 有 `subagent_start/stop` 觀察事件）。[CM-agents]、[CM-mods]

## 4. 建議

### 4.1 每個 agent 的 adapter 型式

| Agent | 建議 | 理由 | 殘留缺口 |
|---|---|---|---|
| Claude Code | **proxy adapter（主）**，可選搭配 hooks | `ANTHROPIC_BASE_URL` 連 subscription 都適用；單一 Anthropic Messages wire；背景呼叫也經過 proxy | Bedrock／Vertex 模式要用不同 wire；cloud sessions 不適用；WebFetch hostname 預檢；本機 transcript 存的是原文（proxy 只保護 wire）；mods 路線待驗證 |
| Codex CLI | **proxy adapter** | Hook 改不了 prompt 和 AGENTS.md，工具輸出只能用 block hack；`openai_base_url` 在 ChatGPT 登入時同樣適用；SG 已有 Responses HTTP＋WS remasker | 必須轉送到非公開文件的 `chatgpt.com/backend-api/codex`；`memories/trace_summarize` 等非 `/responses` 路由要處理或阻擋；analytics 內容不明；hosted WebSearch 在 server 端執行 |
| Gemini CLI | 短期 **hook adapter（受限）**，長期 proxy 需要新 wire | `BeforeModel` 能改文字 parts，`BeforeTool` 能還原工具參數；proxy 需要新寫 Gemini／Code Assist remasker | `functionResponse` 改不了（工具輸出只能用 deny＋reason 取代）；`systemInstruction` 改不了；compression 等 `BaseLlmClient` 呼叫不經 hook；OAuth 模式的 proxy 只靠「測試用」的 `CODE_ASSIST_ENDPOINT` |
| Cursor | **transparent 模式不可行**；只做 guard 模式（hooks 阻擋） | 請求一律經 Cursor 後端組 prompt；hooks 只能改工具輸入和 MCP 輸出 | 遮不了 prompt、檔案內容和 shell 輸出；Tab 和 cloud agent 另有路徑 |
| pi | **in-process extension adapter**（不需 proxy） | `before_provider_request` 可以替換 provider-native payload，直接重用三種 wire remasker；`tool_call`、`tool_result`、`message_end` 能完成還原／重新遮罩 | handler 錯誤 fail open；OAuth 加 base URL 未確認；compaction 路徑未確認 |
| Command Code | **mods adapter** 或 **BYOK＋proxy adapter**；hooks 不足 | mods 有 `transformContext`、`beforeToolCall`、`afterToolCall`；BYOK 的三種 wire 都是 SG 已支援的 | 預設 plan 的 endpoint 無法確認是否可 override；`appendSystemPrompt` 只能附加，system prompt 本體改不了；taste learning 的資料流沒有逐項確認 |

### 4.2 第二個 adapter：Claude Code local proxy

1. **wire 重用度最高**：只需要 `remaskAnthropicMessagesRequest`、`createAnthropicSseRestoreStream`、`restoreAnthropicMessagesResponse`（`src/opencode-transparent-http.ts`）。Codex 雖然也能重用 Responses 和 WS adapter（`remaskResponsesRequest`、`createResponsesSseRestoreStream`、`createResponsesWebSocketAdapter`），但要同時處理 HTTP 和 WS 兩種 transport，以及 memories 等額外路由。
2. **官方明文支援**：subscription 經 gateway 是官方文件記載的情境，header 轉送規則也寫得很清楚；Codex 的 ChatGPT backend 沒有公開協定文件。
3. **涵蓋面**：proxy 看得到完整 request（system、CLAUDE.md、所有 messages、tool results），response 中的 tool_use input 會在 proxy 端還原，所以 `PreToolUse` 還原和顯示還原都可以在 proxy 完成。不過 shell-safety 檢查必須移到 proxy 的 restore 階段，或保留一個 `PreToolUse` hook 做第二道檢查。
4. **建議並行**：pi 的 in-process adapter 和 OpenCode 一樣是 TS／in-process 架構，成本最低，可以作為「第二個 in-process host」驗證 `TransportMaskingService` 介面的 host 無關性。

**proxy 型式共通的殘留缺口**：本機 state（transcript、session 檔、checkpoint）存的是原文；不經 base URL 的旁路（vendor telemetry、WebFetch 預檢、hosted tools、cloud sessions）不受保護；新的 wire 欄位或路由（例如 `count_tokens`、`memories/*`）必須 fail closed，不能預設放行。

## 5. 未確認／待驗證

1. Claude Code mods 的 `session.append` 改寫是否就是下一次送給模型的內容，以及 mods 是否為 GA。驗證：寫一個最小 mod，改寫 `tool_result`，再用 proxy 比對下一個 `/v1/messages` 的 body。
2. Claude Code 背景呼叫（resume 摘要、title、WebFetch 摘要、prompt suggestions）是否全都走 `ANTHROPIC_BASE_URL`。驗證：local capture proxy 加上 `/resume`、WebFetch 測試。
3. Codex：subagent 內工具呼叫是否觸發 `PreToolUse`／`PostToolUse`；`decision:"block"`＋`reason` 替換輸出後模型的實際行為；remote compaction 的確切 endpoint；analytics payload 是否含內容；proxy 轉送到 `chatgpt.com/backend-api/codex`（含 WS）是否被接受。驗證：本地 capture proxy 加上 `codex exec` 情境測試。
4. Gemini：compression 等 `BaseLlmClient` 呼叫是否用同一個 base URL；subagent 是否觸發 `BeforeModel`／`BeforeTool`；`CODE_ASSIST_ENDPOINT` 指向 local proxy 時 OAuth 是否可用。驗證：`GOOGLE_GEMINI_BASE_URL=http://localhost:…` capture 加上 `/compress`。
5. Cursor：subagent 內是否觸發 `preToolUse`；Cursor CLI 是否支援 BYOK 或 base URL；「OpenAI base URL override」的連線起點是否確實是 Cursor 後端（推論，未實測）。
6. pi：OAuth subscription provider 加上 `baseUrl` override 是否有效；compaction 和 branch summary 呼叫是否經過 `before_provider_request`；`openai-codex-responses` 是否使用 WS。驗證：寫一個 extension 記錄 `before_provider_request` 加上 `/compact`。
7. Command Code：預設 plan 的 CLI endpoint 和 override 方式；CLI 原始碼是否公開（`CommandCodeAI/command-code` 未讀到）；hooks／mods 是否在 subagent 和 background agents 內觸發；taste learning 是否把內容送上雲；`transformContext` 是否涵蓋 compaction 和 title 呼叫。驗證：BYOK `baseURL=http://localhost:…` capture，並寫一個 mod 記錄 `model_request_start`。
8. 所有 agent：本文沒有任何 runtime 驗證；所有「proxy 可涵蓋」的說法都要靠 capture proxy 實測確認。

## 6. Sources

讀取日期一律為 2026-10-15。

Claude Code
- [CC-hooks] https://code.claude.com/docs/en/hooks.md
- [CC-mods-ref] https://code.claude.com/docs/en/plugins/mods/reference.md（「as of v2.1.290」）
- [CC-mods-events] https://code.claude.com/docs/en/plugins/mods/events.md
- [CC-env] https://code.claude.com/docs/en/env-vars.md
- [CC-gw] https://code.claude.com/docs/en/llm-gateway.md
- [CC-gw-proto] https://code.claude.com/docs/en/llm-gateway-protocol.md
- [CC-costs] https://code.claude.com/docs/en/costs.md（Background token usage）
- [CC-data] https://code.claude.com/docs/en/data-usage.md

Codex CLI（source SHA `3ee47c10513f1bb57d869ea650aba28638e3d11c`）
- [CX-hooks] https://developers.openai.com/codex/hooks.md（→ https://learn.chatgpt.com/docs/hooks）
- [CX-cfgref] https://developers.openai.com/codex/config-reference.md
- [CX-cfgadv] https://developers.openai.com/codex/config-advanced.md
- [CX-plugins] https://developers.openai.com/codex/plugins.md
- [CX-pre] https://github.com/openai/codex/blob/3ee47c10513f1bb57d869ea650aba28638e3d11c/codex-rs/hooks/src/events/pre_tool_use.rs
- [CX-post] https://github.com/openai/codex/blob/3ee47c10513f1bb57d869ea650aba28638e3d11c/codex-rs/hooks/src/events/post_tool_use.rs（L413–434）
- [CX-mpi] https://github.com/openai/codex/blob/3ee47c10513f1bb57d869ea650aba28638e3d11c/codex-rs/model-provider-info/src/lib.rs（L80、L100、L427–444、L526–561）
- [CX-ws] https://github.com/openai/codex/blob/3ee47c10513f1bb57d869ea650aba28638e3d11c/codex-rs/codex-api/src/endpoint/responses_websocket.rs（L464）
- [CX-mem] https://github.com/openai/codex/blob/3ee47c10513f1bb57d869ea650aba28638e3d11c/codex-rs/codex-api/src/endpoint/memories.rs（L32–34）
- [CX-analytics] https://github.com/openai/codex/blob/3ee47c10513f1bb57d869ea650aba28638e3d11c/codex-rs/analytics/src/client.rs（L154）
- [CX-tree] https://github.com/openai/codex/tree/3ee47c10513f1bb57d869ea650aba28638e3d11c/codex-rs/core/src（`compact_remote_v2.rs` 等）

Gemini CLI（SHA `06d329873703ddabe8a842d962342ac4ad779e83`，簡寫為 `G`＝`https://github.com/google-gemini/gemini-cli/blob/06d329873703ddabe8a842d962342ac4ad779e83`）
- [GM-hooks] G/docs/hooks/reference.md
- [GM-ext] G/docs/extensions/reference.md
- [GM-config] G/docs/reference/configuration.md（L2735–2749、L2831）
- [GM-tel] G/docs/cli/telemetry.md；[GM-tos] G/docs/resources/tos-privacy.md
- [GM-translator] G/packages/core/src/hooks/hookTranslator.ts（`toHookLLMRequest`、`fromHookLLMRequest`）
- [GM-chat] G/packages/core/src/core/geminiChat.ts（L1077–1135）
- [GM-cg] G/packages/core/src/core/contentGenerator.ts（L64–98、L286–345）
- [GM-ca] G/packages/core/src/code_assist/server.ts（L73–74、L479、L524–531）
- [GM-compress] G/packages/core/src/context/chatCompressionService.ts（L595）
- [GM-base] G/packages/core/src/core/baseLlmClient.ts
- [GM-local] G/packages/core/src/agents/local-executor.ts（L1115）

Cursor
- [CU-hooks] https://cursor.com/docs/hooks.md
- [CU-plugins] https://cursor.com/docs/plugins.md
- [CU-byok] https://cursor.com/help/models-and-usage/api-keys.md
- [CU-datause] https://cursor.com/data-use
- [CU-gov] https://cursor.com/docs/enterprise/privacy-and-data-governance.md
- [CU-search] https://cursor.com/docs/agent/tools/search.md
- [CU-cli-cl] https://cursor.com/docs/cli/changelog.md

pi（SHA `eddebaeebf8168dfc31d6712b7a021e4df3b4e6a`，簡寫為 `P`＝`https://github.com/earendil-works/pi/blob/eddebaeebf8168dfc31d6712b7a021e4df3b4e6a`）
- [PI-pkg] P/packages/coding-agent/package.json；[PI-readme] P/packages/coding-agent/README.md
- [PI-ext] P/packages/coding-agent/docs/extensions.md
- [PI-types] P/packages/coding-agent/src/core/extensions/types.ts（L885–901、L1184–1188、L1443–1500、L1597–1664）
- [PI-runner] P/packages/coding-agent/src/core/extensions/runner.ts（L1368–1397）
- [PI-models] P/packages/coding-agent/docs/models.md；P/packages/coding-agent/docs/providers.md
- [PI-ai-types] P/packages/ai/src/types.ts（L61–73）
- [PI-env] P/packages/coding-agent/docs/environment-variables.md

Command Code
- [CM-llms] https://commandcode.ai/docs/llms.txt
- [CM-npm] https://registry.npmjs.org/command-code（latest 1.82.3）
- [CM-hooks] https://commandcode.ai/docs/hooks
- [CM-mods] https://commandcode.ai/docs/mods
- [CM-byok] https://commandcode.ai/docs/byok
- [CM-provider] https://commandcode.ai/docs/provider
- [CM-settings] https://commandcode.ai/docs/settings
- [CM-faq] https://commandcode.ai/docs/troubleshooting/faqs
- [CM-tel] https://commandcode.ai/docs/troubleshooting/telemetry
- [CM-agents] https://commandcode.ai/docs/agents

[^cc1]: [CC-hooks]「`UserPromptSubmit`: can't replace the prompt」
[^cc2]: [CC-mods-ref]、[CC-mods-events]
[^cc3]: [CC-hooks] PreToolUse decision control
[^cc4]: [CC-hooks] PostToolUse decision control
[^cc5]: [CC-env]、[CC-gw-proto]
[^cc6]: [CC-hooks]、[CC-mods-ref]
[^cc7]: [CC-gw]、[CC-data]、[CC-hooks]
[^cx1]: [CX-hooks] UserPromptSubmit
[^cx2]: [CX-hooks] PreToolUse、Tool coverage；[CX-pre]
[^cx3]: [CX-hooks] PostToolUse；[CX-post]
[^cx4]: [CX-cfgref]、[CX-cfgadv]、[CX-mpi]、[CX-ws]
[^cx5]: [CX-hooks]、[CX-plugins]
[^cx6]: [CX-mpi]、[CX-mem]、[CX-analytics]、[CX-hooks]
[^gm1]: [GM-hooks] BeforeModel、Stable Model API
[^gm2]: [GM-translator]
[^gm3]: [GM-hooks] BeforeTool／AfterTool
[^gm4]: [GM-config]、[GM-cg]、[GM-ca]
[^gm5]: [GM-hooks]、[GM-ext]
[^gm6]: [GM-compress]、[GM-base]、[GM-config]
[^cu1]: [CU-hooks] beforeSubmitPrompt
[^cu2]: [CU-hooks] preToolUse／postToolUse
[^cu3]: [CU-byok]、[CU-datause]、[CU-gov]
[^cu4]: [CU-hooks]、[CU-plugins]
[^cu5]: [CU-byok]、[CU-datause]、[CU-hooks]
[^pi1]: [PI-ext]
[^pi2]: [PI-types]、[PI-runner]
[^pi3]: [PI-types] ToolCallEventResult／ToolResultEventResult
[^pi4]: [PI-models]、[PI-ai-types]
[^pi5]: [PI-runner]、[PI-readme]
[^cm1]: [CM-hooks]
[^cm2]: [CM-mods]
[^cm3]: [CM-byok]
[^cm4]: [CM-byok]、[CM-faq]
