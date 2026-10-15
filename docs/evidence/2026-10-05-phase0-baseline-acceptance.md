# Phase 0 基準落地驗收證據（Baseline Acceptance）

日期：2026-10-05
分支：`feat/22-transparent-pseudonymization`（base: local `main` @ `b47ed0a`）
環境：opencode v2.0.23（`~/.opencode/bin/opencode`）、vitest、macOS
對應計畫：`docs/plans/2026-10-05-transparent-hardening-execution-plan.md` Phase 0

## 1. 基準 commits 與逐 commit 獨立測試（worktree 實測）

每個 commit 於獨立 worktree checkout 後執行 `npx vitest run`（symlink 共用 node_modules）：

| Commit | 內容 | 測試結果 |
|---|---|---|
| `db99338` | chore: .gitignore 改寫 + AGENTS.md 清理 | 352/352（19 檔）綠 |
| `3da4db2` | feat(transparent): 假名化引擎 (#22) | 422/422（20 檔）綠 |
| `d3f2b87` | feat(transparent): session guard + 出口遮罩 | 503/503（21 檔）綠 |
| `d248d12` | feat(plugin): transparent 接線 + protectedSpans | 518/518（21 檔）綠 |
| `8153c4f` | test(e2e): C10–C13 + restoration probe | 518/518（21 檔）綠 |
| `c1f5ac1` | docs: spec + evidence + plan | docs-only，免測 |
| `8175ad0` | test(scanner): encoding tests + benchmark | 531/531（24 檔）綠 |

測試數單調遞增、無任何 commit 處於紅燈或零測試狀態。

## 2. Boundary harness C1–C13（本地 capture server，56s）

`node scripts/e2e/run-boundary.mjs` — 真實 `opencode run --standalone` session：

| Case | reqs | canary leaks | verdict |
|---|---|---|---|
| C1-block | 2 | 0 | pass |
| C2-redact | 2 | 0 | pass |
| C3-tool-output | 3 | 0 | pass |
| C4a/C4b-order | 2/2 | 0/0 | observe（canary 未達 provider） |
| C5-invalid-options | 0 | 0 | pass（fail-closed，未發任何請求） |
| C6-absent | 2 | 6 | **expected-leak**（對照組：無插件=無保護，非產品缺失） |
| C7-deidentify | 2 | 0 | pass（stable [SG-EMAIL-… placeholders） |
| C8-ignore-bypass | 2 | 0 | pass |
| C9-resume | 3 | 0 | pass |
| C10-transparent | 2 | 0 | pass（[SGP1:… tokens 出現於 2 請求） |
| C11-transparent-tool | 3 | 0 | pass（工具往返皆乾淨） |
| C12-transparent-resume | 3 | 0 | pass（本地原文重放有再遮罩） |
| C13-transparent-restore | 3 | 0 | pass（provider 未見明文；本地工具以還原後的原始路徑讀檔成功） |

Storage hits: 4 / log hits: 0 / unattributed: 0。
Storage 命中屬 spec 明文接受範圍（「Accept local originals in chat history, outputs, files, and logs」；C9/C12 的 resume 重放設計即依賴本地保留原文）。原始輸出：`scripts/e2e/out/evidence.json`（gitignored）。

## 3. 明確未執行（open items）

1. **真實 provider E2E**：未執行——本次無 API key。現有證據全部來自本地 capture server（OpenAI Chat Completions 形狀），不能外推為真實 provider 行為已驗證。
2. **Oracle 再審**：10-02 重審後的修復（hash 已變更：`e28689fb`/`c9ac30e7`/`98ba3dc7`）尚無獨立複審裁決。issue #22 保持 open，runtime GO 需再審 + 真實 provider E2E。

## 4. 結論

Phase 0 DoD 達成 3/4（working tree 乾淨、逐 commit 綠、C1–C13 綠）；真實 provider E2E 明確跳過並記錄於上。基準可回滾，後續 Phase 1–3 以此為底。
