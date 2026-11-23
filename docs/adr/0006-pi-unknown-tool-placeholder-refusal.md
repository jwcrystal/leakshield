---
status: accepted
date: 2026-11-23
---

# pi 的未知工具含 placeholder 一律拒絕

pi adapter 的 `assertPiToolBoundary`（`src/pi/tool-policy.ts`）在呼叫 core 之前，對**不在 pi 內建名單**的工具做一次 placeholder 檢查：只要參數或鍵名含 `SGP2` prefix，就拒絕整次呼叫。pi 內建 `read`、`write`、`edit`、`bash`、`powershell`、`grep`、`find`、`ls` 仍交給 `HostToolPolicy` 依欄位還原。

## Context

ADR-0001 的規則是「依欄位、不依工具」：非 shell 工具的其他欄位直接還原，未知工具不特別擋。那適用於 OpenCode，因為它的工具都在同一個 host process 內，欄位語意可由 core 分類。

pi 的 MCP、自訂與 extension 工具是另一種情況：adapter 不知道參數會被送到哪裡。MCP server 可能是遠端服務，自訂工具可能自己發 HTTP。把 mapping 還原後交給這種工具，等於把原值送進一個沒有在同一個 session mapping 裡的出口。這不是還原位置的注入問題，而是**工具本身的出口未知**。

Issue #98 也明確要求：「Unknown executable tools must refuse placeholders.」

## Decision

- pi adapter 只還原八個內建工具的參數；其餘工具若含 placeholder 就拒絕，不嘗試推測欄位。
- 這個拒絕發生在 `src/pi/proxy.ts` 的 `/control/tool`，也就是本機執行邊界；extension 收到拒絕後 block 該次 tool call。
- 不含 placeholder 的未知工具照常執行。
- 若某個自訂工具確定是本機唯讀、且欄位語意可證明安全，應把它加進 adapter 的已知名單並補測試，而不是放寬成「所有未知工具都還原」。

## Considered Options

- **沿用 ADR-0001 直接還原未知工具**：否決。pi 的工具可能把參數送到 adapter 看不見的遠端服務；這與 OpenCode 的同 process 模型不同。
- **只還原看起來唯讀的欄位**：否決。欄位名稱無法證明工具不會轉送參數；`path` 也可能被送到遠端 API。
- **全部拒絕，包括不含 placeholder 的呼叫**：否決。沒有 placeholder 就沒有 mapping 洩漏，沒有理由擋住正常工作。

## Consequences

- MCP、codemode、自訂工具在受管模式中含 placeholder 會被拒絕；不含 placeholder 則可使用（codemode 仍被啟動器的 `--no-extensions` 停用）。
- 這是 pi adapter 比 OpenCode 更嚴的地方，差異記錄在 `docs/pi.md`。
- ADR-0001 對 OpenCode 仍然有效；本 ADR 只覆寫 pi adapter 的未知工具行為。
