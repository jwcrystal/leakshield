# 透明防護硬化執行計畫（Transparent Hardening Execution Plan）

日期：2026-10-05
性質：執行計畫（roadmap + 驗收條件）。不修改程式碼；實作另依各 Phase 開工。
上游文件：
- Spec：`docs/specs/2026-09-30-agent-transparent-pseudonymization.md`（目標、28 條 user stories、failure contract）
- 研究：`docs/evidence/2026-10-05-provider-transport-reference-research.md`（三方參考實作、hook 名稱、未驗證清單）
- 既有 E2E：`scripts/e2e/run-boundary.mjs`（C1–C13，含 transparent C10–C13）

## 目標

達到產品狀態：「不限制模型、簡單安裝即可安心使用」，主體驗為：

> 本機保留原文 → 出站假名化 → 模型處理替代值 → 本機顯示與工具參數還原

保留必要拒絕機制（fail-closed），取代預設刪除整段內容。

## 非目標（沿用 spec Out of Scope，此處不重述全部）

- 工具外送防火牆：本計畫只保障「模型對話邊界」，不管控本地工具經 curl／遠端 MCP 的真值外傳。此邊界必須寫進所有使用者可見文件（Phase 1 一起做）。
- V1 支援、持久化 reverse-mapping DB、網路 egress 強制、NER 訓練管線。

## 現狀基線（2026-10-05 已驗證）

| 項目 | 狀態 | 證據 |
|---|---|---|
| 透明模式實作 | 完成 but **全部未提交**（13 modified + 18 untracked） | `git status` |
| Session hooks | `prompt`/`context`/`compaction`/`generate`/`title` + `tool.execute.after` 已註冊 | `src/opencode-v2.ts:184-208` |
| HTTP 出口層 | 僅放行 Chat Completions 形狀；Anthropic 形 body、附件、URL 帶 token 一律 refuse | `src/opencode-transparent-http.ts:424,273,294,425` |
| E2E payload 驗收 | C10–C13 已證 canary 不達 provider、restore 可用、resume 重遮罩 | `scripts/e2e/run-boundary.mjs` |
| 單元測試 | 218 通過（2026-10-05 回報） | 使用者提供 |
| 真實 provider E2E | **未重跑**；現有證據皆為本地 capture server | run-boundary.mjs 註解 |
| 安裝／啟用狀態顯示 | **無任何實作** | `src/opencode.ts` 全檔無 status/install 邏輯 |

---

## Phase 0：落地基準（先決條件，一切疊代之前）

**問題**：整個透明模式在 working tree，無可回滾基準；後續 Phase 都會污染同一批未審檔案。

步驟：
1. **分組盤點未提交檔案**，依邏輯切 commit（建議切法）：
   - `src/decision/pseudonymization.ts` + `tests/pseudonymization.test.ts`（核心引擎）
   - `src/opencode-transparent.ts` + `src/opencode-transparent-http.ts` + `tests/opencode-transparent.test.ts`（session guard + 出口層）
   - `src/opencode-v2.ts`/`src/opencode.ts`/`src/scanner/*`/`src/decision/deidentify.ts` 修改 + 對應測試（接線與掃描器調整）
   - `scripts/e2e/*` + fixtures（restoration-probe、manual-tui）
   - docs：spec、evidence、CONTEXT.md、CLAUDE.md
   - **排除**：`.commandcode/`、`ENCODING_FIX_SUMMARY.md`、`SECURITY_FIXES_VERIFICATION_REPORT.md` 等與透明模式無關的混入物 → 先確認去留，不混進功能 commit
2. **重跑驗收**：`npm test`（218 全過）+ `run-boundary.mjs` C1–C13。
3. **重跑真實 provider E2E**：至少一個真實 OpenAI-compatible endpoint，確認本地 capture 結論可外推。

驗收（DoD）：
- [x] working tree 乾淨（僅剩 7 項明確排除：`.commandcode/`、`CLAUDE.md`、`ENCODING_*`×3、`SECURITY_*`、`bun.lock`）
- [x] 每個 commit 可獨立通過測試（worktree 實測 352→422→503→518→531 全綠，見 `docs/evidence/2026-10-05-phase0-baseline-acceptance.md`）
- [x] C1–C13 全綠（2026-10-05，56s，canary leaks 全 0；C6 expected-leak 為對照組）
- [ ] 真實 provider E2E — **未執行**（無 API key），保留為 open item；完成前不得宣稱 runtime GO

## Phase 1：安裝流程 + 啟用狀態顯示（優先項 1）

> **2026-10-05 狀態**：1a 完成（`--doctor` 安裝健檢 + README 邊界聲明 + copy-paste 註冊 snippet，16 項單元測試）。1b（預設值遷移：新裝機預設 transparent、隱式用戶遷移通知、block 降為 fallback）**依閘門暫緩**——需 oracle 再審通過 + 真實 provider E2E 後才可翻轉預設。

**問題**：須手動建置、手動確認入口與載入；插件未載入時無任何警示。

範圍：
1. 一條安裝路徑（npm/binary 擇一為主），安裝即驗證：config 路徑、host 版本相容（V2）、插件確實被 host 載入。
2. `sensitive-guard status`（CLI 或 host 內指令）輸出三態：
   - **protected**：session hooks + HTTP 出口層皆已註冊
   - **partial**：僅其中一層（列明缺哪層、後果為何）
   - **unsupported**：host 版本／傳輸協定不支援 → 明示，不得靜默放行
3. 安裝失敗必須可見：失敗即 fail-closed 提示，不可看似正常（對齊 spec failure contract #21）。
4. **預設值遷移**（spec user stories 1–3）：新裝機預設 transparent；既有顯式 block/redact 保留；隱式預設用戶需一次性遷移通知。block 降為 fallback 路徑。
5. 邊界聲明文件化：README/安裝指南載明「對話防洩漏 ≠ 工具外送防火牆」。

驗收：
- [ ] 全新環境照文件安裝，一個指令完成，`status` 回 protected
- [ ] 停用插件／裝錯版本 → `status` 回 unsupported 或 partial，且訊息指出修法
- [ ] payload 斷言：安裝後跑 C10 型案例，canary 不達 provider（跨 Phase 驗收標準，見「Phase 4」）

## Phase 2：雙層涵蓋稽核（優先項 2 — 補洞，非新建）

> **2026-10-05 狀態**：完成。矩陣 8 格中 7 格有 payload 級證據（新增 C14 context／C15 retry／C16 tool-error 三案例；C6 對照組證明 title 是真實洩漏路徑且已防護）；僅 compaction 以結構論證降級（standalone 無法觸發，找到觸發方式後補案例）。未發現繞過路徑。見 `docs/evidence/2026-10-05-phase2-coverage-matrix.md`。

**現況**：兩層皆已存在。缺口是「每種 request kind × 每層」的涵蓋證明。

研究文件 §7 已證 V1（v1.2.10）title/compaction 可繞過；**§7.2 明列 V2 未驗證**。本 Phase 產出涵蓋矩陣並補洞：

| Request kind | Session hook | HTTP 出口層 | 待辦 |
|---|---|---|---|
| 一般 generate/prompt | ✅ | ✅（Chat Completions） | 已有 C10 |
| context | ✅ 已註冊 | ？ | 驗證 payload 證據 |
| compaction | ✅ 已註冊 | ？（V1 可繞過） | **V2 實測**；繞過則補 |
| title | ✅ 已註冊 | ？（V1 可繞過） | **V2 實測**；繞過則補 |
| session resume 重放 | C12 已涵蓋 | ✅ | 延伸：resume 後 title/compaction 再觸發案例 |
| 重試（stream 中斷重送） | 未證 | 未證 | 新增 E2E 案例 |
| 歷史工具參數／錯誤訊息 | C11 涵蓋 tool output | — | 延伸：工具「錯誤回呼」路徑 |

驗收：
- [ ] 涵蓋矩陣每格有 payload 級證據（canary 斷言），註明 E2E 案例編號
- [ ] 發現繞過 → 修補 + 回歸案例；無法修 → 該 kind 明示降級並列入 `status` 輸出

## Phase 3：協定擴充，不綁模型名稱（優先項 3）

**原則**：以 **body 形狀**判斷協定，非模型/provider 白名單。形狀無法辨識 → 顯式 refuse（維持現有 fail-closed）。

順序：
1. **Anthropic Messages**（`/v1/messages`：頂層 `system`、content blocks、tool_use/tool_result）
   - 參考：Rehydra proxy 的 OpenAI/Anthropic adapter 分離設計（研究文件 §5.2、RH-providers）
   - 既有 refuse 點 `opencode-transparent-http.ts:273` 改為 Anthropic 分支處理
   - 還原：response SSE 中 tool_use input 的 token → 本機 restore（比照 C13 模式）
2. **OpenAI Responses**（`/v1/responses`：input items、function_call）
   - 注意 V2 provider options 已用語義選項（如 `reasoningEffort`），adapter 需對應新形狀
3. **明示不支援**：WebSocket、Gemini 原生等 → refuse 訊息列原因，`status`同步顯示
4. 附件：維持 refuse（spec 範圍內），但列入未來工作

驗收（每個協定 individually）：
- [ ] 假名化往返：request canary → token；response token → restore
- [ ] 工具參數 restore（C13 同型案例 per protocol）
- [ ] 混形／未知 body → refuse，訊息指明協定
- [ ] `status` 對該協定回 protected

## Phase 4（橫切）：以實際出站內容驗收 — 併入各 Phase DoD，不另排期

原則：**任何 Phase 宣稱完成，必須有「canary 未出現於 provider request body」的斷言證據**，僅證 hook 物件被改過不算數。

載具：擴充 `scripts/e2e/capture-server.mjs` 支援新協定形狀（Anthropic、Responses），C10–C13 模式複用。
每 Phase 產出 `docs/evidence/<date>-phase<N>-payload-proof.md`。

---

## 執行順序與依賴

```
Phase 0 （基準落地）
   │
   ├─→ Phase 1 （安裝+狀態）      ── 可與 P2 並行
   ├─→ Phase 2 （涵蓋稽核）        ── 依賴 P0 的 E2E 基線
   └─→ Phase 3 （協定擴充）        ── 建議在 P2 之後（矩陣先立，新協定直接入矩陣）
Phase 4 橫切於所有 Phase 的 DoD
```

## 主要風險

| 風險 | 緩解 |
|---|---|
| 未提交工作在 commit 前被覆寫／遺失 | Phase 0 第 1 步先行；必要時先 `git stash create` 快照 |
| V2 title/compaction 確認繞過且短期難修 | 降級明示 + `status` 反映，不放棄 fail-closed |
| Anthropic adapter 還原遺漏（SSE 串流中 token 分裂） | token 設計需跨 chunk 穩定；C13 型案例 per protocol 必測 |
| 真實 provider E2E 需付費 endpoint | 固定最小案例集；保留 capture server 為主要迴歸層 |
