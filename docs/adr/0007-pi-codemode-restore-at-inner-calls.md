---
status: accepted
date: 2026-11-24
---
# pi 的 codemode 原始碼不還原，改在內層工具呼叫還原
`codemode`（`{ code: string }`）的 JavaScript 原始碼維持 placeholder 原樣；腳本呼叫 `tools.<name>()` 時，pi 會再觸發一次 `tool_call`，帶的是已求值的參數，adapter 就在那一層依 ADR-0001 的欄位規則還原。這是 ADR-0003 對 OpenCode `execute` 的同一條路徑（#123）。
## Context
ADR-0006 讓 pi 的未知工具一律拒絕，理由是參數會離開 process、目的地不可知，而 `codemode` 被一起歸進未知工具：腳本裡任何一個 placeholder 都會取消整次呼叫。
pi 1.6.0 的 codemode 不是那種工具。腳本跑在 QuickJS 沙箱裡，沒有 Node API、檔案系統、網路與 timer，出口只有 `tools.<name>()`（`docs/codemode.md`）；內層呼叫會像模型發出的呼叫一樣經過參數驗證與 `tool_call`／`tool_result`（`docs/extensions.md`）。而 MCP server 的 `exposure` 預設就是 `codemode`，server 連上時 pi 自動啟用（`docs/mcp.md`），所以這是 MCP 使用者的預設路徑，不是進階選項。拒絕整段腳本換不到保護，只是讓這一輪遇到已映射的值時整段失敗。
## Decision
- pi adapter 把 `codemode` 視為 Code Mode 呼叫：原始碼不動，內層呼叫照 `HostToolPolicy` 的欄位規則還原，core 的 Code Mode 檢查（near-miss、`fetch` 與 placeholder 同時出現）照常套用。
- 內層是未知工具時仍由 ADR-0006 的邊界拒絕；拒絕訊息帶上工具名稱，讓模型能換路徑。
- 直接曝露的 `mcp__*`、自訂與 extension 工具維持拒絕，ADR-0006 不變。
- 唯讀查詢工具（`tool_search`）不列入。它以 `model-only` 曝露，腳本本來就呼叫不到；在 `query` 裡還原原值還可能把明文寫進本機 session，維持拒絕。
## Considered Options
- **維持整段拒絕**：否決。沙箱沒有自己的出口，拒絕換不到保護，卻讓 MCP 預設路徑在遇到已映射的值時整輪失敗。
- **把 codemode 加進已知工具、照欄位還原原始碼**：否決。原始碼是 JavaScript，ADR-0002 的啟發式規則在真實模型上誤判率高（ADR-0003 記錄了 12 次中 8 次被拒、4 次無聲錯誤），而內層還原拿的是已求值的參數。
- **放寬所有未知工具**：否決。`direct` 的 MCP 與自訂工具確實把參數送出 process，沒有內層再檢查，ADR-0006 的理由成立。
## Consequences
- codemode 腳本可以把 placeholder 交給 `bash`、`read`、`write` 等已知工具並正常還原。
- 腳本把 placeholder 交給未知工具時，那次呼叫被拒、工具沒執行，錯誤回傳給腳本；腳本可以捕捉它，run 不會因此中斷（實測：`Script completed` 加上 `blocked: …` 訊息）。
- 原始碼中的 placeholder 會原樣出現在腳本的 `text()`／`return` 輸出，模型看到的是 placeholder，不是原值。
- 本機 session 檔仍存真實值（宿主行為）；送給 provider 的請求一律遮罩。
- 證據：`scripts/e2e/run-pi-codemode.mjs`，真實 pi 1.6.0＋錄製 stub，涵蓋內層 `read` 還原、內層自訂工具被拒且未執行、provider 未收到原值。
