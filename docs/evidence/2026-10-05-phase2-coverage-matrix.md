# Phase 2 涵蓋矩陣：request kind × 防護層 payload 證據

日期：2026-10-05
分支：`feat/22-transparent-pseudonymization`
環境：opencode v2.0.23、本地 capture server（`scripts/e2e/run-boundary.mjs`，全案例 67s 全跑）
對應計畫：`docs/plans/2026-10-05-transparent-hardening-execution-plan.md` Phase 2

## 雙層結構（程式碼事實）

| 層 | 註冊點 | 涵蓋 |
|---|---|---|
| Session hooks | `src/opencode-transparent.ts:781` — `context` / `compaction` / `generate` / `title` 四種 kind | 請求組裝期的假名化 |
| HTTP 出口 | `src/opencode-transparent.ts:792/799` — `http.request`（最終遮罩）/ `http.response`（還原） | 所有經 host fetch 的 wire 請求 |
| 顯式拒絕 | `:381-391` — WebSocket（`experimental.ws.*`）、`aisdk:sdk`、`aisdk:language` 路徑 fail-closed | 不支援的傳輸不靜默放行 |

關鍵結構事實：**title、retry 與（依 host 實作）compaction 的模型呼叫都走同一條 host fetch 路徑**，因此 `http.request` 出口層對它們一體適用——下列 payload 證據逐格驗證此論。

## 涵蓋矩陣（每格 payload 級證據）

| Request kind | Session hook | 出口層證據 | 判定 |
|---|---|---|---|
| 主對話（prompt/generate） | ✅ generate | **C10**：2 請求 canary=0、`[SGP1:` token 在列 | ✅ 已證 |
| **title 生成** | ✅ title | **C6 對照組**：無插件時 title 與主對話**各漏 3 canary**（證明 title 是真實洩漏路徑）；**C10–C14** 所有 title 請求 canary=0，`[SGP1:` token 3–4 個／請求 | ✅ 已證 |
| **context（指令檔）** | ✅ context | **C14**（新）：workdir `AGENTS.md` 帶 canary → 內容進入模型 context → title+主對請求皆轉 `[SGP1:` token | ✅ 已證 |
| 工具結果回送 | `tool.execute.after` | **C11**：forced read notes.txt → 後續請求乾淨 | ✅ 已證 |
| **工具錯誤回送** | `tool.execute.after` | **C16**（新）：forced read canary 檔名不存在檔案 → 錯誤文字帶 canary → 後續請求帶 `[SGP1:` 遮罩版錯誤 | ✅ 已證 |
| **session resume 重放** | — | **C12**：`--continue` 第二輪重放本地原文 → 再遮罩，兩輪皆 0 洩漏 | ✅ 已證 |
| **傳輸重試（斷流重送）** | — | **C15**（新）：capture server 對第一個 main 請求斷流（partial chunk → socket destroy）→ host 重送 → **2 次 main 嘗試皆 canary=0**（每次重送都經出口層再遮罩） | ✅ 已證 |
| **compaction** | ✅ compaction | **無 payload 證據**：standalone harness 觸發不了（binary 內無可用的 threshold 設定鍵；`session.compaction.*` 事件存在但無 CLI 觸發路徑） | ⚠️ 結構論證：compaction 由同一 session runner 發出、走同一 `http.request` 出口，且 session hook 已註冊；**降級說明，不宣稱已證**。找到確定觸發方式後補案例 |

## 對照組與邊界

- **C6（無插件）**：title 與主對話各漏 3 canary——矩陣中每個「已證」格的防護都是相對於這個真實洩漏基準。
- **C15 exit=1**：斷流重試後 run 最終以錯誤退出（重試預算耗盡），但兩次嘗試皆乾淨——保護與否和 host 重試政策無關。
- Storage 4 筆 canary 命中屬 spec 接受之本地原文（C9/C12 resume 設計依賴）；log 0。
- 全案例原始輸出：`scripts/e2e/out/evidence.json`（gitignored）；capture 檔 `scripts/e2e/out/captured/`。

## 結論

計畫 Phase 2 的矩陣 8 格中 **7 格有 payload 級證據**（含本次新增 C14/C15/C16 三案例與 C6 對照組確立的 title 洩漏真實性）；僅 compaction 為結構論證降級。未發現任何繞過（bypass）路徑——V1 host 的 title/compaction 繞過問題（研究文件 §7.1）在 V2 未重現：V2 的 title 與 context 證據皆為實測乾淨。

下一步（Phase 3 前不阻塞）：找到 compaction 確定觸發方式後補 C17 案例，將最後一格升級為已證。
