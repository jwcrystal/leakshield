---
status: accepted
date: 2026-11-24
---

# 跨宿主設計原則：不傷體驗下的最大隱私洩漏保護

LeakShield 的核心原則，是在**不破壞日常對話連續性、內建功能與工具執行順暢度**的前提下，於各宿主可行的攔截邊界內最大化隱私洩漏保護。開發或評估任何新 host adapter 時，應依宿主底層 API 原語選擇能同時維持體驗與保護的架構，而不是強行對齊其他宿主的設定開關。

## Context

`docs/plans/2026-10-11-experience-first-policy.md` 先前在 OpenCode 上確立了「體驗優先」方向：避免讓過度嚴格的守門機制頻繁誤拒或中斷回覆，否則使用者會直接停用防護，反而導致全面外洩。

隨著專案涵蓋 OpenCode、pi 與 Claude Code 三類不同形態的宿主，各宿主提供的攔截原語差異極大：

- **OpenCode（`in-process-host-hook`）**：原生提供涵蓋背景摘要的 content hooks（`context`、`compaction`、`generate`、`title`）、throw-to-abort 的 fail-closed 語意，以及與 outbound wire 解耦的 inbound 回覆還原 hook（`http.response`、`ws.receive`）。因此 `wireProtection: false` 不會犧牲任何日常功能。
- **pi（`in-process-fetch`）**：依 PR #119（`docs/evidence/2026-11-23-pi-hook-only-feasibility.md`）對 pi 1.6.0 的實測，通用 content hooks 漏掉手動／自動 compaction 與 tree summary，hook 內 throw 會 fail-open，且無獨立 inbound 回覆還原 hook。若硬推純 hook-only，反而會迫使停用背景摘要並失去串流還原，同時傷害體驗與保護。
- **Claude Code（`loopback-proxy`）**：採行程外 HTTP proxy（`ANTHROPIC_BASE_URL`），憑證與宿主隔離，但未支援的新協定形狀會觸發誤拒或靜默退化（如 PR #103 修正前的 `ToolSearch` `tool_reference`）；且工具參數還原尚未實裝（規劃於 ADR-0005 / #91，採薄客戶端 `PreToolUse` hook 回呼 proxy），是目前對日常體驗影響最大的缺口。

需要一份跨宿主 ADR，將「體驗 × 保護」的共同底線與新宿主選型準則定錨，供後續新 adapter 開發直接沿用。

## Decision

### 1. 跨宿主共通不變量（不可為體驗妥協）

- **出站與初始化絕不靜默 fail-open**：遮罩失敗、超限或初始化錯誤時，不得默默送出未遮罩原值。
- **入站回覆還原採 P0 降級**：歸屬不明或串流解析失敗時，停止還原並保留字面 placeholder，絕不中斷已收到的回覆，亦不跨 session 猜測 mapping。
- **工具執行安全不隨模式放寬**：未知出口（ADR-0006）、外送／跨 session 欄位（ADR-0005）與危險 shell 語法一律拒絕，並回傳可重試的明確錯誤訊息。
- **相容性問題優先修協定、次選降級開關**：遇到合法的新協定欄位或形狀時，優先於共用 `src/core/wire.ts` 或 adapter 補齊受控放行與結構檢查（如 PR #103），不優先以關閉保護層換取相容性。
- **邊界如實揭露**：任何降級模式、未稽核 transport 或宿主外流量（`outside` / `unknown`），皆須於 `leakshield --doctor` 與 `capabilities.ts` 明確標示（如 `PARTIAL`）。

### 2. 新 Adapter 選型檢查表

導入新宿主前，依序檢核宿主是否原生具備三項原語：

1. 涵蓋一般與背景請求（compaction／摘要／標題）的 content hooks。
2. 確定的 fail-closed 中止語意（throw 或可驗證無競態的 abort 機制）。
3. 與 outbound 攔截解耦的 inbound 回覆還原掛鉤。

選型規則：

- **三項皆具備**（如 OpenCode）：採用「常駐 content hooks ＋ 可選 `wireProtection`」雙層架構，允許日常以 `wireProtection: false` 兼顧相容性與完整功能。
- **缺少任一項且宿主走可攔截的行程內 HTTP 邊界**（如 pi 1.6.0）：採用單層 `fetch` 邊界作為唯一預設模式，不強行提供會破壞背景功能或回覆還原的 hook-only 開關。僅在出現無法靠針對性協定修復解決的真實相容性拒絕時，才提供 opt-in 折衷架構——「Content Hooks（統一以 `ctx.abort()` 處理失敗並取消背景摘要）＋ 僅做 `onHttpResponse` 的唯讀 fetch 還原層」，並於 `--doctor` 標示 `PARTIAL`。
- **宿主無可用行程內攔截點或需憑證隔離**（如 Claude Code）：採用行程外 `loopback-proxy` 搭配薄客戶端工具還原 hook（ADR-0005），並在 `--doctor` 明確揭露不經 proxy 的 `outside` 流量。

## Considered Options

- **強制所有宿主提供對等的 `wireProtection: false` 開關**：否決。在缺少完整 content／inbound hook 原語的宿主（如 pi 1.6.0）上，關閉 wire 層反而會停用背景摘要或失去串流還原，違背不傷體驗的初衷。
- **全面採極嚴格阻斷（入站還原異常或未知形狀一律中斷對話）**：否決。過高的誤拒與斷流會迫使使用者直接停用防護，造成更嚴重的隱私外洩風險。
- **為維持體驗而在遮罩失敗時自動退回明文（fail-open）**：否決。直接違反 LeakShield 的核心安全承諾。

## Consequences

- 後續開發新 adapter 時可直接沿用本 ADR 的五條不變量與三項原語檢查表，無須重覆論證是否該複製 OpenCode 的雙層開關。
- pi adapter 維持現行 `globalThis.fetch` 單層架構為唯一模式，並以此作為 Issue #118（配合 PR #119 證據）的正式決策依據。
- 各宿主不追求設定開關的表面一致，而是對齊同一套「體驗優先、出站 fail-closed、入站降級、工具守門、邊界誠實揭露」的跨宿主契約。
