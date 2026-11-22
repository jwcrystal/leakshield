# Claude Code 2.1.330：工具輸入格式與 PreToolUse hook 行為（issue #91）

日期：2026-11-22 · Claude Code 2.1.330 · leakshield `main` `047e5aa`。這份是 #91 範圍第 1 項：把 Claude Code 工具的輸入格式固定到一個版本，並實測 `PreToolUse` hook 的實際行為，作為 ADR 0001–0004 複查與 hook 設計的依據。**這裡只記錄觀察，不做設計決定。**

## 方法

- **執行方式：** 真實的 `claude -p`（`--model sonnet`、`--allowedTools "Bash(cat:*)" "Bash(wc:*)"`、`--max-turns 5`），以 `env -i` 只保留 `PATH`、`HOME`，每次用獨立的 `CLAUDE_CONFIG_DIR`。`ANTHROPIC_BASE_URL` **直接**指向本機替身 [`stub-upstream.mjs`](../../scripts/e2e/claude-code/stub-upstream.mjs)（不經 LeakShield proxy），`ANTHROPIC_API_KEY` 是合成值。替身依腳本呼叫 `Bash cat notes.txt` 與 `Bash wc -c notes.txt`。**沒有使用真實模型，也沒有連到 Anthropic。**
- **工具格式：** 取自替身記錄的第一個 `POST /v1/messages` 的 `tools` 欄位。預設會延遲載入部分工具（`DeferredToolPlaceholder`、`defer_loading: true`，只送 12 個定義）；設定 `ENABLE_TOOL_SEARCH=false` 後送出全部 23 個定義，下表以此為準。
- **Hook：** `CLAUDE_CONFIG_DIR/settings.json` 註冊一個 `PreToolUse`（matcher `*`）command hook，把 stdin 原樣記錄下來，並依 `PROBE_MODE` 改寫、失敗或拒絕。探測腳本未納入 repo，以下結果由替身記錄的請求與 hook 記錄機械比對。

## 1. 工具輸入格式（23 個）

粗體是 `required`。巢狀物件只列第一層欄位名。這次的設定沒有 MCP server、plugin 或 skill，所以沒有 `mcp__*` 工具；MCP 工具的格式由各 server 決定，名稱形如 `mcp__<server>__<tool>`（文件），本次未觀察。2.1.330 的工具清單裡**沒有** `Grep`、`Glob`。

| 工具 | 欄位：型別 |
|---|---|
| `Agent` | **description**: string<br>**prompt**: string<br>subagent_type: string<br>model: enum<br>effort: enum<br>run_in_background: boolean<br>isolation: enum |
| `Bash` | **command**: string<br>timeout: number<br>description: string<br>run_in_background: boolean<br>dangerouslyDisableSandbox: boolean |
| `CronCreate` | **cron**: string<br>**prompt**: string<br>recurring: boolean<br>durable: boolean |
| `CronDelete` | **id**: string |
| `CronList` | （無） |
| `DesignSync` | **method**: enum<br>projectId: string<br>path: string<br>writes: array<string><br>deletes: array<string><br>planId: string<br>files: array<object{path,localPath,data,encoding,mimeType}><br>paths: array<string><br>name: string<br>assets: array<object{name,path,subtitle,viewport,group}><br>localDir: string<br>counts: object{total,bad,thin,variantsIdentical,iterations} |
| `Edit` | **file_path**: string<br>**old_string**: string<br>**new_string**: string<br>replace_all: boolean |
| `EnterWorktree` | name: string<br>path: string |
| `ExitWorktree` | **action**: enum<br>discard_changes: boolean |
| `ListAgents` | channel: string<br>q: string<br>cursor: string |
| `Monitor` | **description**: string<br>**timeout_ms**: number<br>command: string<br>ws: object{url,protocols} |
| `NotebookEdit` | **notebook_path**: string<br>cell_id: string<br>**new_source**: string<br>cell_type: enum<br>edit_mode: enum |
| `PushNotification` | **message**: string<br>status: string |
| `Read` | **file_path**: string<br>offset: integer<br>limit: integer<br>pages: string<br>allow_large: boolean |
| `ReportFindings` | level: enum<br>**findings**: array<object{file,line,summary,short_summary,failure_scenario,category,severity,verdict,outcome}> |
| `ScheduleWakeup` | delaySeconds: number<br>reason: string<br>prompt: string<br>stop: boolean<br>noop: boolean |
| `SendMessage` | **to**: string<br>summary: string<br>**message**: string<br>notify_when_idle: boolean |
| `Skill` | **skill**: string<br>args: string |
| `TaskStop` | task_id: string<br>shell_id: string |
| `WebFetch` | **url**: string<br>**prompt**: string<br>offset: integer |
| `WebSearch` | **query**: string<br>allowed_domains: array<string><br>blocked_domains: array<string> |
| `Workflow` | script: string<br>name: string<br>description: string<br>title: string<br>args: ?<br>scriptPath: string<br>resumeFromRunId: string |
| `Write` | **file_path**: string<br>**content**: string |

## 2. PreToolUse hook 的輸入

hook stdin 的欄位：`session_id`、`transcript_path`、`cwd`、`prompt_id`、`permission_mode`、`effort`、`hook_event_name`、`tool_name`、`tool_input`、`tool_use_id`。

```json
{"session_id":"731360eb-…","tool_name":"Bash","tool_input":{"command":"cat notes.txt","description":"Show notes"},"tool_use_id":"toolu_stub_1","permission_mode":"default", …}
```

- `tool_name` 與 `tool_input` 和模型回傳的 `tool_use` 的 `name`、`input` 逐字相同；`tool_use_id` 就是 `tool_use.id`。
- **`session_id` 與同一個 session 每個 Messages 請求的 `x-claude-code-session-id` header 相同**（`731360eb-…`）。proxy 以這個 header 區分 session 的對照表，所以 hook 可以用 `session_id` 指到同一份對照表。
- 子 agent（`Agent` 工具）內的工具呼叫、以及子 agent 請求帶的 session header，本次沒有觀察。

## 3. 改寫輸入（`updatedInput`）

hook 回傳 `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{…}}}`，把 Bash 的 `command` 改成 `printf "HOOK-RAN:"; <原指令>`：

| 觀察 | 結果 |
|---|---|
| 實際執行的是改寫後的輸入 | 是：兩個 `tool_result` 分別是 `HOOK-RAN:plain text`、`HOOK-RAN:11 notes.txt` |
| 下一個請求歷史裡的 `tool_use.input` | **模型原本的輸入**（`cat notes.txt`、`wc -c notes.txt`），不是改寫後的 |
| 下一個請求歷史裡的 `tool_result` | 改寫後指令的**實際輸出** |

也就是：在 hook 裡還原的原值不會經由 `tool_use` 回到模型；但工具若把原值印出來，原值會出現在 `tool_result`，必須靠 proxy 在下一個請求重新遮罩。沒有 proxy 時，這條路會外洩。

## 4. 失敗與拒絕

每種情況都讓兩次 Bash 呼叫各走一次 hook。「被擋下」指工具沒有執行，`tool_result` 帶 `is_error`。錯誤文字裡 hook 指令的路徑以 `<hook>` 代替。

| hook 行為 | `onFailure` | 工具 | 模型看到的 `tool_result` |
|---|---|---|---|
| exit 1（當掉） | 未設定 | **照樣執行**（fail open） | `plain text`、`11 notes.txt` |
| exit 1（當掉） | `"block"` | 被擋下 | `PreToolUse:Bash hook error: [node <hook>]: failed; blocking because onFailure is "block"\nprobe crash` |
| exit 2，stderr 寫原因 | 未設定 | 被擋下 | `PreToolUse:Bash hook error: [node <hook>]: probe exit2 refusal` |
| `permissionDecision: "deny"` ＋ `permissionDecisionReason` | 未設定 | 被擋下 | `PreToolUse:Bash hook error: probe deny reason` |
| 不回應，超過 `timeout: 1`（秒） | 未設定 | **照樣執行**（fail open） | `plain text`、`11 notes.txt` |
| 不回應，超過 `timeout: 1`（秒） | `"block"` | 被擋下 | `PreToolUse:Bash hook error: [node <hook>]: timed out; blocking because onFailure is "block"` |

- 不設 `onFailure: "block"` 時，hook 當掉或逾時，工具會**帶著 placeholder 照樣執行**。
- 設了 `onFailure: "block"` 後，當掉與逾時都會擋下。
- exit 2 與 `deny` 不論 `onFailure` 都會擋下。`deny` 的訊息不含 hook 路徑，最乾淨；exit 1／exit 2 的訊息會帶出 hook 指令的完整路徑。

## 5. 對照 OpenCode 規則的觀察（供 ADR 用）

以下只比對名稱與資料流向，是否沿用由 ADR 決定。

- **欄位命名：** Claude Code 用 snake_case（`file_path`、`old_string`、`new_string`、`notebook_path`、`new_source`），OpenCode 用 camelCase（`filePath`、`oldString`）。`tool-restore-policy` 依名稱分段判斷，`description` 仍會判為 metadata。
- **shell：** `Bash` 符合 `SHELL_TOOLS` 的 `bash`；`command` 欄位符合 shell key。`Monitor` 不是 shell 工具名，但有 `command` 欄位，會依欄位名判為 shell。
- **程式碼：** `Workflow` 的 `script` 符合 code key（inert）。`NotebookEdit` 的 `new_source` 是程式碼內容，但名稱不在 code key 清單裡，會依預設判為 verbatim。
- **唯讀：** `Read` 對得上 `READ_ONLY_TOOLS` 的 `read`。清單裡的 `grep`、`glob` 在 2.1.330 不存在。
- **輸入會再送給模型的欄位：** `Agent.prompt`（子 agent）、`WebFetch.prompt`（摘要模型）、`CronCreate.prompt`、`ScheduleWakeup.prompt`、`SendMessage.message`、`Skill.args`。這些值會成為另一個模型請求的內容。
- **輸入會離開本機、且不經 proxy 的欄位：** `WebFetch.url`（連到任意主機；網域預檢另外把 hostname 直接送到 `api.anthropic.com`）、`PushNotification.message`（推播服務）、`DesignSync`（上傳）、`Monitor.ws.url`。在這些欄位還原原值，等於把原值送出本機。
- **伺服器端工具：** `WebSearch.query` 交給 Anthropic 端的搜尋，請求經 base URL；[proxy 目前會擋下](../claude-code.md#what-it-does-not-cover)帶 server tool 區塊的歷史。
- **寫檔：** `Write.content`、`Edit.new_string`、`NotebookEdit.new_source` 還原後，原值會寫進本機檔案；之後若被讀回，會經 `tool_result` 由 proxy 重新遮罩。

## 待驗證

- 子 agent 內的工具呼叫是否觸發同一個 hook、`session_id` 是否與子 agent 請求的 header 一致。
- MCP 工具的實際輸入格式。
- 真實模型（非替身）下的同一組行為。
