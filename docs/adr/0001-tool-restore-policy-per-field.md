---
status: accepted
date: 2026-11-06
---

# 工具還原依欄位判斷，未知工具不當 shell

`tool:execute.before` 是否還原 placeholder、套哪種規則，依**欄位**決定，不依工具（#76）。只有內建 `SHELL_TOOLS` 名單或名稱含 shell 片段（`bash`、`zsh`、`pwsh`…）的工具整體套 shell 規則；其他工具中，名稱像指令的欄位（`command`、`cmd`、`argv`…）套 shell 規則，`code`、`script` 套受限的程式碼規則（ADR-0002），其餘欄位直接還原。無法安全還原時一律**拒絕整次呼叫、不改輸入**，不遮成 `***` 後繼續執行。

這層防的是**還原位置的注入**：還原後的原值不會變成 shell 或程式語法。它不是 egress 防護，被允許的工具可以把原值送到任何地方。

## Considered Options

- **未知工具一律當 shell（舊預設）**：被否決。這會讓 `openchamber_render`、`ctx_execute` 這類工具集體被誤擋，代價是使用者無法工作；它擋住的也不是 egress，所以換不到任何保護。
- **遮蔽後繼續執行**：被否決。這等於偷偷改了程式的輸入，失敗原因和實際執行的內容都會變得難以追查。

## Consequences

- 新的執行型工具若不在名單內、欄位名稱也不像指令，就**不會被偵測**。要支援它，得把名稱加進 `SHELL_TOOLS`，或讓它帶 `command` 欄位。名單寫在原始碼裡，不開放設定。
- 映射找不到時，只有 `READ_ONLY_TOOLS` 可以降級放行（P1，見 `docs/plans/2026-10-06-refusal-policy-simplification-decision.md`），其餘一律拒絕。
