# Evidence 索引

這裡是帶日期的驗證與研究紀錄。**內容不隨程式更新改寫**：結論過時時，在原檔開頭加一行指向新檔，而不是修改原結論。要知道「現在怎麼樣」，先看下面標為「現行」的檔案。

公開前（2026-10-15）已移除本機 OpenCode session／message ID、OpenChamber 連結與帳號名稱；其餘內容未改寫。

狀態說明：**現行** = 目前最新結論；**歷史** = 當時的快照，仍可作背景；**已被取代** = 數據或結論已由較新檔案更新，保留作對照。

## 現行入口

| 想知道 | 看這份 |
|---|---|
| SG 與官方 Rehydra／EightDoor 現在差在哪 | [三方重測 2026-10-14](2026-10-14-three-way-comparison.md) |
| 長對話、加密 reasoning、刪除回收是否可用 | [容量與刪除回收重測 2026-10-14](2026-10-14-live-capacity-and-lifecycle-retest.md) |
| 容量上限與 session 回收的設計與測試 | [容量修正驗證 2026-10-14](2026-10-14-transparent-capacity-verification.md) |
| `wireProtection: false` 目前的契約（純 hook-only） | [純 hook-only 驗證 2026-10-11](2026-10-11-pure-hook-only-verification.md) |
| 官方 `@rehydra/opencode` 的實際行為（原始碼） | [官方發布來源稽核 2026-10-11](2026-10-11-rehydra-current-source-audit.md) |
| 各 transport 是否支援（Responses WS、AI SDK） | [Responses WS](2026-10-11-responses-ws-verification.md)、[AI SDK HTTP](2026-10-11-aisdk-http-verification.md) |
| Claude Code 經本機 proxy 是否遮罩與還原 | [Claude Code proxy 驗證 2026-11-21](2026-11-21-claude-code-proxy.md) |
| pi 行程內 extension：遮罩、工具還原、session 續用 | [pi extension 驗證 2026-11-23](2026-11-23-pi-extension.md) |
| pi 套件入口、打包安裝與移除是否可用 | [pi 套件安裝驗證 2026-11-24](2026-11-24-pi-package-install.md) |
| pi hook-only 是否可行、例外與取消是否能阻擋 | [pi hook-only 雲端驗證 2026-11-23](2026-11-23-pi-hook-only-feasibility.md) |

## 比較

| 檔案 | 狀態 |
|---|---|
| [2026-10-14 三方重測](2026-10-14-three-way-comparison.md) | 現行 |
| [2026-10-11 官方 Rehydra 來源稽核](2026-10-11-rehydra-current-source-audit.md) | 現行 |
| [2026-10-11 官方 V2 對照](2026-10-11-official-rehydra-v2-comparison.md) | 已被取代（數字以 10/14 為準；測試方法與 EightDoor 發現仍可參考） |
| [2026-10-11 SG 與官方：日常體驗](2026-10-11-current-sg-official-rehydra.md) | 已被取代（純 hook-only 前快照） |
| [2026-10-11 EightDoor 可用性實測](2026-10-11-rehydra-v2-usability-comparison.md) | 歷史 |
| [2026-10-05 三家差異（VibeGuard／opencode-vibeguard／Rehydra）](2026-10-05-three-way-comparison.md) | 已被取代（VibeGuard 兩家為原始碼研究，從未實測） |
| [2026-10-05 Provider／transport 參考研究](2026-10-05-provider-transport-reference-research.md) | 歷史（固定 SHA 的原始碼研究） |
| [2026-10-15 Coding agent 攔截能力調查](2026-10-15-agent-interception-capabilities.md) | 研究（hook／local proxy adapter 的選型依據，只讀文件與原始碼；Claude Code proxy 已於 [2026-11-21](2026-11-21-claude-code-proxy.md) 實作） |

## 驗證與重測（依時間）

| 日期 | 檔案 | 狀態 |
|---|---|---|
| 11-24 | [pi 套件入口與打包安裝驗證](2026-11-24-pi-package-install.md) | 現行（Node 22.19／24，三種 API） |
| 11-23 | [pi hook-only：內容 hooks、背景請求與明確取消（#118）](2026-11-23-pi-hook-only-feasibility.md) | 研究（37 情境、146 斷言；尚非正式模式） |
| 11-23 | [pi extension：行程內遮罩、工具還原、session 續用（#98）](2026-11-23-pi-extension.md) | 現行 |
| 11-23 | [pi adapter：受管啟動版（已由 extension 取代）](2026-11-23-pi-adapter.md) | 已被取代 |
| 11-23 | [pi 1.6.0 fetch 攔截缺口稽核](2026-11-23-pi-fetch-gap-audit.md) | 現行 |
| 11-23 | [pi 1.6.0：extension 的行程內 fetch 攔截](2026-11-23-pi-in-process-fetch-interception.md) | 現行（缺口稽核的前置探測） |
| 11-21 | [Claude Code 本機 proxy：Claude Code 2.1.321 實機驗證（#86）](2026-11-21-claude-code-proxy.md) | 現行 |
| 11-06 | [0.3.0 工具還原：OpenCode v2.2.5 實機驗證](2026-11-06-opencode-2.2.5-tool-restoration.md) | 現行 |
| 10-14 | [容量修正驗證](2026-10-14-transparent-capacity-verification.md) | 現行 |
| 10-14 | [容量與刪除回收重測](2026-10-14-live-capacity-and-lifecycle-retest.md) | 現行 |
| 10-11 | [純 hook-only 驗證](2026-10-11-pure-hook-only-verification.md) | 現行 |
| 10-11 | [純 hook-only 實機重測](2026-10-11-pure-hook-only-live-retest.md) | 歷史 |
| 10-11 | [實機短對話與長對話分叉](2026-10-11-live-long-context-retest.md) | 已被取代（分叉失敗已於 10/14 通過） |
| 10-11 | [體驗優先：回覆降級與 scoped hook-only](2026-10-11-experience-first-verification.md) | 歷史 |
| 10-11 | [Responses WS 與持久化狀態](2026-10-11-responses-ws-verification.md) | 現行 |
| 10-11 | [AI SDK HTTP 相容性](2026-10-11-aisdk-http-verification.md) | 現行 |
| 10-11 | [目前仍會被擋的情況](2026-10-11-current-blocking-impact.md) | 已被取代（純 hook-only 前快照） |
| 10-11 | [全域停用與 runtime 盤點](2026-10-11-global-removal-diagnostics.md) | 歷史 |
| 10-07 | [Hook-first 設定與驗證](2026-10-07-hook-first-verification.md) | 歷史 |
| 10-07 | [HTTP 相容性恢復](2026-10-07-http-recovery-verification.md) | 歷史 |
| 10-07 | [Vision 工具輸出恢復](2026-10-07-vision-tool-output-recovery.md) | 歷史 |
| 10-07 | [SGP2 token 誤報語料](2026-10-07-sgp2-fp-corpus.md) | 歷史（量測） |
| 10-06 | [OpenCode wire 情境盤點](2026-10-06-opencode-wire-inventory.md) | 歷史（v2.0.24，非現行支援表） |
| 10-06 | [穩定性修正清單](2026-10-06-stability-fix-plan.md) | 歷史 |
| 10-05 | [Phase 0 基準驗收](2026-10-05-phase0-baseline-acceptance.md)、[Phase 2 涵蓋矩陣](2026-10-05-phase2-coverage-matrix.md) | 歷史 |
| 10-01／02 | [審查](2026-10-01-transparent-hooks-review.md)、[修復檢查](2026-10-02-transparent-hooks-repair-check.md)、[複審](2026-10-02-transparent-hooks-rereview.md) | 歷史 |
| 09-29 | [OpenCode v2 邊界驗證（issue #19）](2026-09-29-opencode-v2-boundary.md) | 歷史 |

## 計畫與規格

- 規格：[Agent Transparent Pseudonymization（現行）](../specs/2026-09-30-agent-transparent-pseudonymization.md)、[Sensitive-content continuity（草案）](../specs/2026-09-29-sensitive-content-continuity.md)
- 決策與計畫：[拒絕政策簡化](../plans/2026-10-06-refusal-policy-simplification-decision.md)、[體驗優先政策](../plans/2026-10-11-experience-first-policy.md)、[對話優先調整](../plans/2026-10-11-conversation-first-adjustments.md)、[持久化路線](../plans/2026-10-07-persistence-decision-db-over-t2.md)、[SGP2 與持久化執行計畫](../plans/2026-10-07-sgp2-persistence-execution-plan.md)、[偵測補強](../plans/2026-10-07-detection-hardening-plan.md)、[透明防護硬化](../plans/2026-10-05-transparent-hardening-execution-plan.md)

## 重現的限制

- E2E 與診斷腳本在 [`scripts/e2e/`](../../scripts/e2e) 與 [`scripts/diagnostics/`](../../scripts/diagnostics)，可直接重跑。
- 三方比較的測試腳本在 [`scripts/e2e/compare/`](../../scripts/e2e/compare/README.md)（Chat Completions 與 native Responses 兩支）。官方與 EightDoor 套件不隨 repo 附帶，需依該 README 另行安裝；未安裝時只跑 baseline 與 SG。10/14 的結果原由暫存目錄的舊版腳本產生，該目錄已被系統清除，repo 內版本已重跑並與其結果一致。
- 各報告中的 `$TMPDIR/...` 證據目錄是當次測試的本機輸出，不保證仍存在。
