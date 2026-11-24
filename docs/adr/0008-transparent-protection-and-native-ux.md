---
status: accepted
date: 2026-11-24
---

# Transparent Protection & Native UX

> Invisible by default. Observable on demand. Fail-closed by design.

預設無感、按需可觀測、安全失敗時阻斷。這是後續 adapter 工作的驗收契約，不是目前所有宿主都已達成的產品保證。

## Context

[跨宿主體驗與隱私平衡](0007-experience-first-privacy-balance.md)已定義安全不變量與依宿主原語選型的規則；本 ADR 補上日常使用、狀態查詢與相容性的可驗收要求，沿用既有架構。

截至 2026-11-24，main 的 pi adapter 已具備 fetch 邊界及 Code Mode 內層工具還原。Claude Code 仍是實驗性 proxy：工具參數尚未還原（[#91](https://github.com/jwcrystal/leakshield/issues/91)），背景請求與 WebSocket 另有待驗證項目（[#111](https://github.com/jwcrystal/leakshield/issues/111)、[#113](https://github.com/jwcrystal/leakshield/issues/113)）。[PR #101](https://github.com/jwcrystal/leakshield/pull/101) 的 ADR-0005 尚未合併，不能當成 main 已實裝的能力。

兩份既有 ADR 共用 0007 編號，本文均以完整檔名連結辨識；[ADR 索引](README.md)列出兩者。本文不重新編號歷史文件。

## Decision

### 1. 安全不變量優先，於可行方案中保留原生體驗

設計優先順序為 **Security Invariants > Native UX > Implementation Convenience**。安全不變量的範圍及失敗處理沿用[跨宿主 ADR](0007-experience-first-privacy-balance.md)：

- 出站遮罩與初始化失敗時，拒絕受影響的請求，不自動重送未遮罩原文。
- 工具只在已驗證的執行邊界依欄位政策還原；無法安全還原時拒絕該次呼叫。既有唯讀降級規則維持有效。
- 入站回覆還原失敗採 P0 降級：保留字面 placeholder，繼續呈現已收到的回覆，不猜測或跨 session 取 mapping。

因此 fail-closed 並非所有入站解析錯誤都要切斷對話，也不代表工具 egress 或本機磁碟已受全面管控。

### 2. Invisible by default：安裝後維持原生操作

- 完成明確的首次設定後，日常目標是使用宿主原有 CLI、IDE、session、resume 與工具權限流程；不要求使用者逐次手動遮罩、揭露或搬移對話。
- 自動化 proxy 啟動、健康檢查與停止時，須定義行程所有權、連接埠衝突、多 session、異常退出及重啟行為；無法建立受保護路徑時，阻止受影響操作並提供恢復方式。
- 自動修復與啟動不得覆寫不屬於 LeakShield 的設定或停止其他行程；取消設定應能移除自身變更。
- 僅在證據支持相同保護邊界時，才改用干擾較小的攔截機制。安裝了 mod 或 hook 本身不是覆蓋完整模型請求的證明。

Managed Proxy 是後續設計工作；本文不新增 `setup` 指令、不改啟動方式，也不宣稱原生 `claude` 已會自動啟動 proxy。

### 3. Observable on demand：狀態要能支持使用者判斷

- 沿用[宿主能力矩陣](../host-capabilities.md)的狀態與 doctor 宣告，不另建第二套分級。
- 區分設定已註冊、行程健康、以及實際請求已經過保護。設定檢查通過或 health endpoint 存在，不能當成即時攔截證據。
- 揭露宿主／已驗證版本、啟用模式、provider／transport、工具與背景請求覆蓋，以及 `unknown`／`outside`、被停用或載入失敗的限制。
- 錯誤提供 adapter、階段、原因及可操作的恢復方式；預設診斷不含原值、憑證或可逆 mapping。額外診斷由使用者按需開啟。

這些是後續觀測功能的要求；目前 doctor 的限制仍以各宿主文件為準。

### 4. 相容性與 session 連續性必須以宿主實測驗收

- 保留串流、工具搜尋、背景摘要／compaction、subagent／MCP 與原生權限等被宣稱支援的功能。合法協定形狀的誤拒應優先修復協定處理，未知內容仍沿用安全拒絕政策。
- 測試同時存在的 session、切換、resume、宿主／proxy 重啟與 mapping 遺失；未啟用 persistence 時，明確說明哪些原生操作可繼續、哪些需要重讀來源或刷新 context。
- session 歸屬不明時保留 placeholder 或拒絕需要還原的工具，依既有政策處理；不借用另一 session 的 mapping。
- 本機 transcript、檔案與工具結果可能保留原值；之後重播給模型時仍須再次遮罩。
- 各 adapter 依自己的能力與殘留限制驗收。pi 的未知工具政策、OpenCode 的欄位還原及 Claude Code 的出口規則不為表面一致而互相覆寫。

## Acceptance for follow-up changes

下表要求適用的後續功能 PR 提供證據；不是宣告這份文件 PR 已通過宿主驗收。

| 面向 | 最小驗收與證據 |
|---|---|
| 模型邊界 | 真實宿主＋錄製 loopback upstream，使用合成 canary；核對初始 prompt、歷史、工具結果及背景請求，記錄遮罩或拒絕，避免只看 UI 推論 |
| 工具守門 | 安全欄位精確還原；危險位置、外 session mapping、失敗／逾時案例證明工具未執行；後續模型請求仍已遮罩 |
| 回覆與連續性 | 串流、取消、resume／重啟、mapping 遺失、多 session；入站還原失敗保留 placeholder，安全邊界不受影響 |
| 原生能力 | 對宣稱支援的 CLI／IDE、ToolSearch、MCP／subagent、compaction 逐項記錄通過、拒絕或未驗證；固定宿主版本 |
| 生命週期 | 自動啟動、健康確認、連接埠衝突、proxy crash／重啟、設定撤回；證明失敗時不自動繞過保護 |
| 可觀測性 | doctor 的設定與覆蓋宣告一致；停用、未載入、未知與旁路情境如實揭露；診斷不帶合成原值／憑證／mapping |
| 效能 | 同宿主／模型／輸入比較開關保護的額外首字延遲、總時間與資源，分開冷啟動、暖機及工具回呼；記錄樣本數與 p50／p95，門檻由功能 PR 說明，本文不捏造預算 |
| 隔離 | 共用 core 或政策介面改動需重跑其他 adapter 回歸；特定宿主限制留在該 adapter |

PR 說明需列出適用的面向；不適用的面向各附一句理由。

真實 provider 與本機 stub 證據分開記錄，未錄製 outbound body 時清楚標示推論。未知 transport 不因另一條路徑成功而提升為已保護。

## Existing work and sequencing

| 工作 | 沿用與界線 |
|---|---|
| Claude Code 工具還原 | [#91](https://github.com/jwcrystal/leakshield/issues/91)／[PR #101](https://github.com/jwcrystal/leakshield/pull/101)；本 ADR 不複製工具 schema 或取代 ADR-0005 決策 |
| Claude Code mods | [#99](https://github.com/jwcrystal/leakshield/issues/99)維持獨立研究：比較 proxy＋hook、proxy＋mod、無 proxy mod；取得實測證據後再提架構變更 |
| 背景／transport 探測 | Claude Code [#111](https://github.com/jwcrystal/leakshield/issues/111)、[#113](https://github.com/jwcrystal/leakshield/issues/113)；OpenCode [#110](https://github.com/jwcrystal/leakshield/issues/110) |
| 真實環境與效能 | 參考既有 [#26](https://github.com/jwcrystal/leakshield/issues/26) 的驗證缺口；該票原以 OpenCode 為範圍，其他宿主新增驗證前先核對既有證據與工作項目 |
| Managed Proxy／整合 UX | 尚未在本次核對的 open issues 找到專票；先設計生命週期，再確認是否需新票，與 #91 的工具還原分開 |

pi 發版沿用 [PR #126（0.4.0）](https://github.com/jwcrystal/leakshield/pull/126)及 [PR #127（真實 provider 證據）](https://github.com/jwcrystal/leakshield/pull/127)，不另開 release PR，也不等待 #99 或 Claude Code 的完整原生 UX。0.4.0 已包含 main 的實驗性 Claude Code proxy；「pi 先發」指交付 pi 支援，Claude Code 完整工具還原與 UX 另以後續版本驗收。本文不授權合併、打 tag 或發布套件。

## Considered Options

- **只新增口號**：不足以決定生命週期、錯誤恢復與相容性如何驗收。
- **重寫所有 adapter 為同一機制**：不採用。沿用跨宿主 ADR 的原語選型，僅統一使用者契約。
- **在本 ADR 選定 mods 取代 proxy**：延後到 #99 實測；較多事件不等於可安全覆蓋全部請求與串流。

## Consequences

後續功能可用同一組驗收面向討論原生體驗，同時保留各宿主的安全政策。額外的生命週期、相容性與效能證據需要持續維護，支援聲明必須隨版本與證據更新。

本 ADR 僅含文件；不變更實作、預設模式、doctor 結果、能力宣告、發版內容或既有 accepted ADR。採納後，README 以「設計原則」呈現三句口號並連回本文，第三句依 Decision 1 收窄為模型邊界；AGENTS 開發準則另行對齊。
