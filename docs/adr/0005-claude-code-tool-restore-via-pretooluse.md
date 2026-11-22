---
status: accepted
date: 2026-11-22
---

# Claude Code 工具還原：PreToolUse hook 只當通道，還原在 proxy 裡做；會離開本機的欄位一律拒絕

Claude Code 的工具呼叫在執行前，由 `PreToolUse` command hook 把 placeholder 還原成原值（#91）。hook 本身不做判斷，只把 `session_id`、`tool_name`、`tool_input` 交給本機 proxy；proxy 用同一份 session 對照表與 Claude Code 專屬的 `HostToolPolicy` 套用 ADR-0001～0004 的欄位規則，回傳改寫後的輸入或拒絕。依據是 [2026-11-22 的實測](../evidence/2026-11-22-claude-code-tool-shapes-pretooluse.md)（Claude Code 2.1.330）：

- hook 收到的 `session_id` 與 proxy 用來區分 session 的 `x-claude-code-session-id` 相同，所以 hook 能指到正確的對照表；對照表只存在 proxy 記憶體裡（[docs/claude-code.md](../claude-code.md)），還原只能在 proxy 做。
- `updatedInput` 是實際執行的輸入，但下一個請求歷史裡的 `tool_use.input` 仍是模型原本的輸入，所以還原的原值不會經由工具參數回到模型。
- 工具的實際輸出會進 `tool_result`。工具若印出原值，要靠 proxy 在下一個請求重新遮罩。**hook 因此必須搭配 proxy，不能單獨使用。**

## ADR-0001～0004 逐條複查

| ADR | 對 Claude Code | 理由 |
|---|---|---|
| 0001 依欄位判斷、未知工具不當 shell、無法安全還原就拒絕整次呼叫 | **沿用，另加一條**（見下方「會離開本機的欄位」） | `Bash` 對得上 `SHELL_TOOLS`；`Monitor.command` 依欄位名判為 shell；`description` 判為 metadata。snake_case 欄位（`file_path`、`old_string`）由名稱分段處理，不需另訂。降級放行的唯讀工具只剩 `Read`（2.1.330 沒有 `Grep`、`Glob`） |
| 0002 程式碼欄位只在單行普通字串內還原 | **沿用** | 適用 `Workflow.script`（依欄位名判為 code）。`NotebookEdit.new_source` 是寫進檔案的內容、工具本身不執行，和 `Write.content` 一樣直接還原 |
| 0003 Code Mode 在內層呼叫還原 | **不適用** | Claude Code 沒有 `execute` 這類工具，Claude Code 的 policy 讓 `isCodeModeCall` 永遠回傳 false。near-miss 拒絕在 core 裡對所有工具生效，照常適用 |
| 0004 只有 `curl`、`http` 允許參數內嵌 | **沿用** | `Bash.command` 是同一套 shell 語意 |

## 會離開本機的欄位：拒絕

ADR-0001 寫明欄位規則「不是 egress 防護」。在 OpenCode 上這是可接受的取捨；Claude Code 則有幾個工具會把輸入**直接送出本機、而且不經過 proxy**，在這些欄位還原原值就等於把原值送出去：

| 工具與欄位 | 送去哪裡 |
|---|---|
| `WebFetch.url` | 任意主機；網域預檢另外把 hostname 直接送到 `api.anthropic.com` |
| `PushNotification.message` | 推播服務 |
| `DesignSync` 全部欄位 | 上傳 |
| `Monitor.ws.url` | 任意 WebSocket 主機 |

這些欄位帶已映射的 placeholder 時，**拒絕整次呼叫、不改輸入**。

## 輸入會變成另一個模型請求的欄位：不還原；送到其他 session 的欄位：拒絕

`Agent.prompt`（子 agent）、`Skill.args`、`WebFetch.prompt`（摘要模型）的值會成為下一個模型請求的內容。這些請求走同一個 base URL，proxy 會重新遮罩，但還原原值沒有好處，反而多一條要靠 proxy 補救的路。所以**不還原**：placeholder 原樣交給工具，子 agent 之後真正用到它時，會在它自己的工具呼叫再經過 hook。

`SendMessage.message`、`CronCreate.prompt`、`ScheduleWakeup.prompt` 會送到**其他 session**，或在之後的新 session 執行。placeholder 只在建立它的 session 內有效，送過去只會變成無效文字，模型和使用者都不會收到錯誤（ADR-0003 所說的無聲錯誤）。所以這幾個欄位帶已映射的 placeholder 時，**拒絕**。

## MCP 與其他未列出的工具：沿用 ADR-0001

MCP 工具（`mcp__<server>__<tool>`）與 Claude Code 日後新增、上面沒列到的工具，沿用 ADR-0001：依欄位名判斷，其餘欄位直接還原。MCP server 可能在遠端，等於 egress；但預設拒絕會擋掉使用者刻意設定的工具，而且與 OpenCode 的行為不一致。作為補償，`leakshield --doctor` 列出已設定的 MCP server，讓使用者知道哪些工具會收到原值。

## hook 與 proxy 之間的通道

- proxy 多一個路由 `POST /__leakshield/tool-restore`，只在 loopback 上，body 是 hook 收到的 `session_id`、`tool_name`、`tool_input`。
- proxy 每次啟動時產生隨機 token，寫進使用者設定目錄下權限 `0600` 的檔案；hook 讀檔後帶 `Authorization: Bearer …`。token 錯誤或缺少一律拒絕，不回任何對照資訊。
- 回應是 `{updatedInput}` 或 `{refusal}`。hook 把前者轉成 `permissionDecision: "allow"` ＋ `updatedInput`，後者轉成 `permissionDecision: "deny"` ＋ 與 OpenCode 相同的拒絕訊息。實測 `deny` 的訊息不帶 hook 路徑，比 exit 2 乾淨。
- `tool_input` 裡沒有 SGP2 前綴、也沒有 near-miss 時，hook 不呼叫 proxy，直接結束、不輸出任何內容，工具照常執行。

## fail closed

- hook 設定**必須**帶 `onFailure: "block"` 與 `timeout`。實測不設時，hook 當掉或逾時，工具會帶著 placeholder 照樣執行；設了之後兩者都會擋下。`onFailure` 需要 Claude Code 2.1.295 以上。
- proxy 沒有在跑、token 檔讀不到、回應格式不對：輸入帶 placeholder 就 `deny`。
- `leakshield --doctor` 檢查 hook 是否已註冊、是否帶 `onFailure: "block"`，沒有就回報為部分保護。

## Considered Options

- **在 proxy 裡直接還原 `tool_use` input**：被否決（#91 已排除）。這會繞過欄位規則，把原值直接放進 shell 指令或程式碼，而且還原後的值會回到 Claude Code 的歷史。
- **對照表寫到磁碟，hook 自己還原**：被否決。原值會以檔案形式長期留在磁碟上，而且 hook 與 proxy 會各有一份規則實作。
- **Unix domain socket（`0600`）取代 loopback HTTP**：權限模型較清楚，但 Windows 不支援；proxy 已經有 loopback HTTP 伺服器。先用 token，之後可以再加。
- **改用 Claude Code mods 的 `tool.call`**：能力更強（in-process、涵蓋子 agent 與 MCP），但尚未實測，文件也沒寫明是否為正式功能。另開 #99 驗證。

## Consequences

- **token 擋得住其他使用者與瀏覽器網頁打 localhost，擋不住以同一使用者身分執行的程式。** 模型透過 `Bash` 執行的指令也是同一使用者，理論上可以讀 token 檔再呼叫這個路由。這不比現況更糟：依 ADR-0004，模型本來就能讓原值經 `curl` 送到任何地方；而路由回傳的原值若印到 `tool_result`，proxy 會重新遮罩。但這條路由不能被當成存取控制。
- 每次工具呼叫多啟動一個 Node 行程。沒有 placeholder 時 hook 直接結束，成本只有行程啟動時間。
- 其他會改寫輸入的 `PreToolUse` hook（例如 rtk 會把 `curl` 改成 `rtk curl`）與這個 hook 的先後順序，Claude Code 文件沒有寫明，尚未驗證。
- 會離開本機與會跨 session 的欄位清單是依 2.1.330 的 23 個工具整理的。Claude Code 新增工具時，新工具會依 ADR-0001 的預設處理（依欄位名判斷、直接還原），需要隨版本複查。
- MCP 工具會收到還原後的原值；遠端 MCP server 因此會看到原值。`--doctor` 只負責列出，不阻擋。
