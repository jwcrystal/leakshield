# Architecture Decision Records

依完整檔名辨識決策。狀態以各文件 frontmatter 為準；`proposed` 不表示已實裝。

| 編號 | 決策 | 狀態 |
|---|---|---|
| 0001 | [工具還原依欄位判斷](0001-tool-restore-policy-per-field.md) | accepted |
| 0002 | [程式碼欄位還原啟發式](0002-code-field-restore-heuristic.md) | accepted |
| 0003 | [OpenCode Code Mode 內層工具還原](0003-code-mode-restore-at-inner-calls.md) | accepted |
| 0004 | [curl／http 內嵌 placeholder](0004-embedded-placeholders-curl-http-only.md) | accepted |
| 0006 | [pi 未知工具拒絕政策](0006-pi-unknown-tool-placeholder-refusal.md) | accepted；Code Mode 特例見下方 pi ADR |
| 0007（跨宿主） | [體驗與隱私平衡](0007-experience-first-privacy-balance.md) | accepted |
| 0007（pi） | [Code Mode 內層工具還原](0007-pi-codemode-restore-at-inner-calls.md) | accepted |
| 0008 | [Transparent Protection & Native UX](0008-transparent-protection-and-native-ux.md) | proposed |

0005 的 Claude Code 決策位於尚未合併的 [PR #101](https://github.com/jwcrystal/leakshield/pull/101)，不在此基底的 main。兩份既有 0007 都保留原檔名，避免破壞歷史連結；引用時請加上主題或完整檔名。

0008 補上使用者體驗與驗收要求，沿用跨宿主 0007 的安全不變量與選型規則；pi 0007 則限定 Code Mode 的還原位置。三者範圍不同。
