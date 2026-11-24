# Agent hook 設計與遮罩還原對照
[← README](../README.md)

> 這頁是 host hook API 的參考整理，不是 LeakShield 的覆蓋宣告；實際覆蓋以 [host capability matrix](host-capabilities.md) 和各 adapter 頁面為準。
> 對象：OpenCode、pi coding agent、Claude Code。
> 驗證版本：OpenCode plugin API 1.17.x／2.0.19、pi 1.6.0（earendil-works）、Claude Code 2.1.330；最後確認 2026-11-24。
> 這頁講的是各 host 的 hook／extension API 本身，以及哪些攔截點能做遮罩與還原；LeakShield 目前採用的位置見最後一節。hook API 會隨版本變動，升級 host 後需要重驗。

## 先定義：遮罩／還原需要哪些攔截點

三個 host 的 hook 不是同一種東西，但可以用同一組「位置」比較：

| 攔截點 | 方向 | 典型內容 |
|---|---|---|
| 使用者輸入 | 遮罩 | prompt、貼上的內容、附件 |
| 對話歷史／system | 遮罩 | messages、system prompt、tool 定義 |
| 模型請求 payload | 遮罩 | provider 專屬 JSON、headers、WS frame |
| 模型輸出（串流） | 還原 | SSE delta、WS frame、最終訊息 |
| 畫面顯示 | 還原 | 助理文字、工具結果的呈現 |
| 工具邊界 | 雙向 | 參數要還原，結果要遮罩 |
| 背景請求 | 遮罩 | compaction、title、summary、subagent |

原則是：**遮罩最好只有一個攔截點（wire）；還原只能發生在本地 sink（工具執行前、畫面）。** 用 hook 拼出來的方案，通常是在沒有 wire hook 的 host 上做的妥協。

## Claude Code：外部程序 hook

### 設計

hook 是跑在 host 外面的程序（或 HTTP endpoint），由 settings 宣告。三層結構：`事件 → matcher group → handler`。同一個事件的多個 hook 平行執行；handler 有五種 `type`：`command`、`http`、`mcp_tool`、`prompt`、`agent`。

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash|Read|Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "/path/to/leakshield-hook restore-args",
        "timeout": 10,
        "onFailure": "block"
      }]
    }]
  }
}
```

### API 協議

- 輸入：事件 JSON 從 stdin 進來，共通欄位有 `session_id`、`transcript_path`、`cwd`、`permission_mode`、`hook_event_name`，再加上各事件的 `tool_name`、`tool_input`、`tool_response` 等。
- 輸出：exit 0 加 stdout JSON，或 exit 2 表示阻擋（在支援阻擋的事件上；stderr 給 Claude 看）。
- JSON 共通欄位：`continue`、`stopReason`、`systemMessage`；事件專屬的放在 `hookSpecificOutput`，必須帶 `hookEventName`。
- 失敗預設是 fail-open：command 逾時或掛掉，動作照樣進行；要 fail-closed 得設 `onFailure: "block"`（v2.1.295+）。`UserPromptSubmit` 逾時還會直接丟棄 hook 輸出、prompt 照送。

### 可用於遮罩／還原的 hook

| 事件 | 可改寫的欄位 | 能做的事 | 限制 |
|---|---|---|---|
| `PreToolUse` | `hookSpecificOutput.updatedInput` | **還原**工具參數中的佔位符 | 整個 input 物件被替換，未改欄位也要帶上；改完會重跑權限規則；auto mode 可能拒絕「hook 改過的呼叫」 |
| `PermissionRequest` | `decision.updatedInput`（僅 allow） | 在權限核准路徑上還原參數 | 只適用 allow；改完會重新評估 deny／ask 規則 |
| `PostToolUse` | `hookSpecificOutput.updatedToolOutput` | **遮罩**工具結果後才給模型 | 值必須符合該工具的輸出 shape（例如 Bash 是 `{stdout,stderr,interrupted,isImage}`），所以要遞迴走訪所有字串欄位，不能直接換成一個字串；`async: true` 的 hook 不能改寫結果 |
| `PostToolUseFailure` | 只有 `additionalContext` | 補充說明 | 錯誤字串本體照樣進模型，**不能遮罩** |
| `UserPromptSubmit` | 只能加 `additionalContext` | 加政策說明、擋掉 prompt | **不能替換 prompt**，所以這裡無法遮罩使用者輸入 |
| `MessageDisplay` | `displayContent` | **還原**畫面上的助理文字 | 只影響顯示；transcript 與模型看到的仍是原文；verbose 模式顯示原文；每批文字呼叫一次，預設 10 秒逾時 |
| `PreCompact` | stdout 當摘要指示 | 引導 compaction | 不能改寫被摘要的內容；只能 block 或加指示 |
| `SessionStart`／`UserPromptExpansion` | `additionalContext` | 補 context | 不能改寫既有訊息 |

**關鍵缺口**：Claude Code **沒有模型請求／回應層的 hook**。`PreModelSwitch`／`PostModelSwitch` 只管模型選擇，不碰 payload。所以要遮罩 prompt、system、assistant 回覆本體，只能走 `ANTHROPIC_BASE_URL` proxy（或 gateway）；Bedrock／Vertex 更是完全繞過 base URL。

**結論**：hook-only 模式在 Claude Code 只能做到「工具參數還原 + 工具結果遮罩 + 畫面文字還原」，做不到使用者輸入與模型輸出的全面遮罩。LeakShield 目前用 proxy，把 `surfaces.toolArgs` 留成 `unknown`（#91）；現在 `updatedInput`／`updatedToolOutput` 已經讓那條路可行，但必須處理 shape 與 auto mode 的限制。

## OpenCode：程序內 plugin，兩代 API

### v1 plugin（`@opencode-ai/plugin`）

> LeakShield 只支援 v2；v1 列在這裡是為了說明 API 的演進。

```ts
export const LeakShield: Plugin = async () => ({
  "chat.message": async (_in, out) => { /* 遮罩 out.message / out.parts */ },
  "tool.execute.before": async (_in, out) => { out.args = restore(out.args); },
  "tool.execute.after": async (_in, out) => { out.output = mask(out.output); },
  "experimental.text.complete": async (_in, out) => { out.text = restore(out.text); },
});
```

hook 以 `(input, output)` 形式拿到可變的 `output`；在 hook 裡 throw 會中止該操作（LeakShield 的 fail-closed 就靠這點）。這一代**沒有 raw transport hook**，只能改 host 暴露出來的高階欄位。

| Hook | 可改 | 用途 |
|---|---|---|
| `chat.message` | `output.message`、`output.parts` | 遮罩使用者輸入／附件 |
| `experimental.chat.messages.transform` | `output.messages` | 遮罩歷史訊息 |
| `experimental.chat.system.transform` | `output.system[]` | 遮罩 system prompt |
| `tool.definition` | `description`、`parameters` | 遮罩工具 schema／描述 |
| `tool.execute.before` | `output.args` | **還原**工具參數 |
| `tool.execute.after` | `output.output`、`title`、`metadata` | **遮罩**工具結果 |
| `experimental.text.complete` | `output.text` | **還原**助理最終文字 |
| `experimental.session.compacting` | `prompt`、`context` | 引導 compaction，不能改摘要本體 |
| `chat.params`／`chat.headers`／`permission.ask`／`shell.env` | 參數／headers／權限／環境 | 不是內容遮罩點 |

限制：高階 hook 只覆蓋它暴露的欄位，provider 專屬 payload（cache 標記、特殊 content block、非 chat 請求）不在內；`experimental.*` 沒有穩定保證。

### v2 plugin（`@opencode/plugin`）

```ts
export default {
  setup: async (ctx) => {
    await ctx.session.hook("http.request", (e) => { e.request = maskRequest(e.request); });
    await ctx.session.hook("http.response", (e) => { e.response = restoreResponse(e.response); });
    await ctx.tool.hook("execute.before", (e) => { e.input = restore(e.input); });
  },
};
```

`ctx.session.hook(name, fn)` 回傳可 dispose 的註冊。可用名稱：

- 內容層：`prompt`、`context`、`compaction`、`generate`、`title`
- 傳輸層：`http.request`、`http.response`、`experimental.ws.handshake`／`send`／`receive`、`model.request`（baseURL／headers）、`retry`
- 工具層：`ctx.tool.hook("execute.before"／"execute.after")`
- SDK 層：`ctx.aisdk.hook("sdk"／"language")`

這是三者中**唯一在 hook API 裡直接給你可替換 `Request`／`Response` 與 WS frame 的 host**，等於一個 in-process proxy，是完整的遮罩／還原攔截點。LeakShield 的 OpenCode adapter 就是用這組：內容 hook 做遮罩、`http.request`／`http.response` 做 wire 遮罩與還原、WS hook 做 Responses 家族、`tool.execute.before` 做參數還原。

## pi（earendil-works/pi，本專案驗證 1.6.0）：程序內 extension

### 設計

extension 是 `export default function (pi: ExtensionAPI)`，用 `pi.on(event, handler)` 訂閱；不同事件的改寫語意不同：有的是**就地修改**（`event.input`、`event.headers`），有的是**回傳替代值**（`before_provider_request` 的 payload、`message_end` 的 message、`tool_result` 的 patch、`input` 的 transform）。另外有 `pi.registerTool()`、`pi.registerProvider()`、`pi.registerCommand()`。

```ts
export default function (pi: ExtensionAPI) {
  pi.on("input", (event) => ({ action: "transform", text: mask(event.text) }));
  pi.on("before_provider_request", (event) => maskPayload(event.payload));
  pi.on("tool_call", (event) => { event.input = restore(event.input); });
  pi.on("tool_result", (event) => ({ content: maskContent(event.content) }));
  pi.on("message_end", (event) => ({ message: restoreMessage(event.message) }));
}
```

### 可用於遮罩／還原的 hook

| 事件 | 語意 | 用途 | 限制 |
|---|---|---|---|
| `input` | 回傳 `{action:"transform"}` | 遮罩使用者輸入 | 在 skill／template 展開**之前**執行，展開注入的內容不經過此 hook |
| `context` | 回傳 `{messages}`，不含 system | 遮罩歷史 | 每次 LLM 呼叫前 |
| `context_with_system` | 回傳完整 messages（含 system） | 遮罩完整 transcript／prompt | 必須保留 index 0 的 system |
| `before_provider_request` | 回傳新 payload | **遮罩整個 provider 請求** | provider 若只送增量（Codex WS、Anthropic thread），只涵蓋新增部分 |
| `before_provider_headers` | 就地改 `event.headers` | 認證／路由 | 不碰 body |
| `after_provider_response` | 只有 status／headers | 觀察 | **不能改 body**；串流前才觸發 |
| `provider_stream_event` | read-only | 觀察 | 明確不可修改 |
| `message_end` | 回傳 `{message}` | **還原**最終助理訊息 | `message_update` 只能看不能改，串流期間畫面仍是佔位符 |
| `tool_call` | 就地改 `event.input`，可 block | **還原**工具參數 | 改完不重新驗證 schema |
| `tool_result` | 回傳 patch（content／details…） | **遮罩**工具結果 | 換 `content` 沒帶 `structuredContent` 會丟掉結構化內容 |
| `session_before_compact`／`session_before_tree` | 只能 `{cancel:true}` | 拒絕不可保護的摘要 | 不能改寫摘要內容 |
| `pi.registerProvider(name, {streamSimple})` | 自接 wire | 完整遮罩／還原 | 等於自己寫 transport |
| `globalThis.fetch` 包裝 | 非 hook，extension 內可做 | 完整雙向、含串流 | 載入順序要先於其他 extension |

pi 的 hook 已經很接近完整：`before_provider_request` 可遮罩請求、`message_end` 可還原最終訊息、`tool_call`／`tool_result` 覆蓋工具邊界。但**串流中的即時還原**與**所有 provider 路徑**仍要靠 fetch 包裝或自訂 provider；這也是 LeakShield 選 fetch 而不是純 hook 的原因。

## 橫向對照

| 能力 | Claude Code | OpenCode v2 | pi 1.6 |
|---|---|---|---|
| 遮罩使用者輸入 | 無（只能 block／加 context） | `prompt`／`chat.message` | `input` transform（skill 展開前） |
| 遮罩歷史／system | 無 | `context`／`messages.transform` | `context`／`context_with_system` |
| 遮罩請求 payload | 無（需 proxy） | `http.request` | `before_provider_request`／自訂 provider |
| 還原串流輸出 | 無（`MessageDisplay` 只改顯示） | `http.response`／`text.complete` | fetch 包裝；`message_end` 只最終 |
| 還原畫面文字 | `MessageDisplay.displayContent`（僅顯示） | `experimental.text.complete` | `message_end`（最終） |
| 還原工具參數 | `PreToolUse.updatedInput` | `tool.execute.before` | `tool_call` |
| 遮罩工具結果 | `PostToolUse.updatedToolOutput` | `tool.execute.after` | `tool_result` |
| 遮罩工具錯誤 | 只能 `additionalContext` | 未驗證（`execute.after` 是否涵蓋失敗呼叫） | `tool_result`（`isError`） |
| 背景／compaction | `PreCompact` 只能引導 | `compaction`／`title`／`generate` | 同一 fetch 或 `before_provider_request` |
| transport 層 | 無 hook，需 proxy | `http.*`／`ws.*`／`aisdk` | fetch／provider |

## 對 LeakShield 的意涵

1. **OpenCode 已經有 wire hook**，所以 hook 模式可以做到接近 proxy 的覆蓋；`wireProtection: false` 時只剩高階內容 hook，非 fetch transport 會漏。
2. **pi 的 hook 足以做「請求遮罩 + 最終還原」，但不足以做串流即時還原**；要完整就維持 fetch 包裝，`tool_call` 只負責本地參數還原。
3. **Claude Code 的 hook 不能取代 proxy**：`UserPromptSubmit` 不能改 prompt、沒有請求／回應 hook、`MessageDisplay` 只改顯示。hook 的價值是補上 proxy 做不到的**本地 sink 還原**（工具參數）與**顯示還原**，以及用 `onFailure: "block"` 做 fail-closed。
4. 三者共同的設計陷阱：
   - 佔位符會被串流切開，逐 delta 還原需要緩衝或跨 chunk 狀態。
   - hook 之間有順序與載入位置問題（pi 的 fetch 包裝、OpenCode 的 plugin 載入順序）。
   - hook 失敗在 Claude Code 預設 fail-open；要遮罩就必須明確 block。
   - hook 本身看得到明文（`tool_input`、raw fetch、plugin args），所以 hook 程序不能記錄內容，也不該被當成唯一的信任邊界。

**一句話總結**：Claude Code 的 hook 是「外部治理事件」，適合審批與工具邊界；OpenCode 的 plugin 是「程序內攔截器」，v2 已能碰 transport；pi 的 extension 是「事件帶可變欄位」，請求層很強但回應串流要靠 fetch／provider。真正完整的遮罩還原，三者都仍以 transport 層為攔截點，hook 用來做本地還原與拒絕。

## 資料來源

- Claude Code：[Hooks reference](https://code.claude.com/docs/en/hooks)（本機 2.1.330）
- OpenCode：`node_modules/@opencode-ai/plugin/dist/index.d.ts`（v1 `Hooks`）、`node_modules/@opencode/plugin/dist/promise/session.d.ts`、`tool.d.ts`（v2）
- pi：`@earendil-works/pi-coding-agent/docs/extensions.md`、`custom-provider.md`（1.6.0）
- LeakShield 對照：`docs/host-capabilities.md`、`src/adapters/opencode/transparent.ts`、`src/adapters/pi/extension.ts`、`src/adapters/claude-code/proxy.ts`

## 相關頁面

- [Host capability matrix](host-capabilities.md)：各 host 的覆蓋宣告與 residual
- [Claude Code（本機 proxy）](claude-code.zh-TW.md)
- [pi adapter](pi.zh-TW.md)
- [Transparent 模式](plugin/transparent-mode.zh-TW.md)
- [Wire 保護](plugin/wire-protection.zh-TW.md)
