# 三家差異比較 + 正常對話流程驗證

> **已被取代（2026-10-14）：** 現行比較與數據見 [三方重測](2026-10-14-three-way-comparison.md)。本文的 VibeGuard／opencode-vibeguard 欄位來自 10/05 原始碼研究，從未實測，也未重跑。

日期：2026-10-05
分支：`feat/22-transparent-pseudonymization`（未推送）
本文件回答兩個問題：
1. sensitive-guard（transparent 模式）與 VibeGuard / opencode-vibeguard / Rehydra 的差異
2. 實際使用流程能否「正常對話」，操作是否與三家相同

事實基礎：`docs/evidence/2026-10-05-provider-transport-reference-research.md`（三方 source 均固定 SHA）＋ 本 repo C1–C17 payload 實證（`scripts/e2e/run-boundary.mjs`，17 案例全綠）。2026-10-07 增補同世代參考 EightDoor/opencode-rehydra-sdk（固定 SHA，見 §6，全為 S 級 source 宣稱）。

> **更新註記（2026-10-05 稍後，Phase 3 完成後）**：wire 協定已為三條（Chat Completions／Anthropic Messages／Responses，C18／C19 實證）；附件政策為 `block`（omission notice，預設）／`allow`（明示未掃描）。本文 §3、§4 中與此牴觸的敘述（含「Anthropic／Responses 待補」與附件相關字句）以本註記為準。

## 1. 操作流程：跟三家一樣嗎？

| | 安裝 | 之後的使用者操作 |
|---|---|---|
| **sensitive-guard** | `opencode.json` 填 `plugins`（dist 目錄或套件名）＋ `--doctor` 健檢 | **正常聊天，無感** |
| opencode-vibeguard | `opencode.json` 填插件 | 正常聊天 |
| Rehydra（plugin 路線） | npm 套件 `@rehydra/opencode` | 正常聊天 |
| VibeGuard | **proxy 執行檔 + CA 憑證安裝**（系統/環境設定） | 正常聊天（流量繞代理） |

**結論：與兩家插件式產品操作完全同型**——裝了就聊天，沒有額外步驟；與 VibeGuard 不同型（它多一層系統級網路設定，換到的是「任何走代理的客戶端」都涵蓋）。差異：三家有已發布套件，我們目前用本機 dist 目錄安裝（npm publish 尚未做，doctor 已支援兩種形態）。

## 2. 正常對話流程驗證（本地 capture server，C1–C17 全綠）

「能不能正常對話」拆成六個可驗證命題，全部有 payload 級證據：

| 命題 | 證據 | 結果 |
|---|---|---|
| 使用者送出含敏感的訊息，對話照常完成 | C10（exit 0，2 請求往返） | ✅ |
| 模型回覆帶 token 時，**使用者看到的是還原後原文**，不是 `[SGP1:…]` | **C17（新）**：capture server 回覆內嵌 token → stdout 事件顯示 `alice.canary@example-test.invalid` | ✅ |
| 工具拿到**原始值**執行（模型只見 token） | **C13**：provider 回 token 當 read 路徑 → 本機工具成功開啟還原後的原始檔名 | ✅ |
| 多輪／session resume 繼續聊 | C12（`--continue` 第二輪，重放再遮罩） | ✅ |
| 傳輸失敗重試不中斷對話 | C15（斷流 → 重送 → 兩次嘗試皆乾淨） | ✅ |
| title 自動生成等背景請求不干擾、且受保護 | C10–C14 title 請求全乾淨（C6 對照：無插件時 title 真的會漏） | ✅ |

另：工具錯誤訊息（C16）、指令檔 context（C14）亦在覆蓋內。結論：**流程可正常對話，體驗與無保護時無差異**（原文進、原文出、工具拿真值），差異只存在於 provider 看到的是 token。

## 3. 機制差異對照

| 維度 | sensitive-guard transparent | VibeGuard（proxy） | opencode-vibeguard 0.1.0 | Rehydra |
|---|---|---|---|---|
| 攔截層 | host 內 `http.request/response`（wire）＋ 4 種 session hooks | MITM 代理 `OnRequest/OnResponse` | V1 hooks（3 個，無 wire 層） | plugin：V1 hooks；proxy：分協定 adapter |
| 適用 host | OpenCode v2（v1 走 block/redact） | 任何客戶端（經代理） | OpenCode v1 形 | v1 形 plugin／proxy 獨立 |
| 協定形狀 | Chat Completions（形狀判別，非模型白名單） | JSON 欄位 best-effort | —（無 wire 層） | proxy：OpenAI CC＋**Anthropic Messages** |
| **不支援 payload 行為** | **refuse（fail-closed），絕不原樣放行**（附件除外：`block`＝omission notice、`allow`＝明示未掃描放行） | **原樣轉送**（=靜默不保護） | — | proxy 未涵蓋者依其實作 |
| 回覆還原 | wire response 還原（C17 實證） | JSON/SSE 還原 | tool.execute.before | session mapping 還原 |
| 工具參數還原 | 執行前還原（C13 實證） | N/A（代理層） | ✅ | ✅（plugin 路線） |
| title/compaction/retry 覆蓋 | title 實證＋retry 實證＋context 實證；compaction 結構論證 | 代理理論全涵蓋 | 無證據 | 無證據 |
| 驗收證據 | 17 案例 payload 級＋對照組（C6） | 有測試（本研究未執行） | 有測試（未執行） | 有測試（未執行） |
| 安裝驗證工具 | `--doctor`（三態＋修法＋snippet） | 無 | 無 | 無 |

## 4. 誠實差距（目前輸給三家的點）

1. **（Phase 3 已完成，此差距關閉）Anthropic Messages 與 OpenAI Responses**：Rehydra proxy 已有 Anthropic adapter；我們已補上 Anthropic 與 Responses，並以 C18／C19 實證。
2. **覆蓋範圍**：VibeGuard 代理可保護其他 AI 客戶端；我們明確限縮在「OpenCode 模型對話邊界」，工具外送（curl/remote MCP）本來就不在保證範圍（README 已聲明）。
3. **發布形態**：三家有 npm 已發布套件；我們尚未 publish（doctor 已支援套件名註冊形態，publish 後零改動）。
4. **真實 provider E2E**：我們的 17 案例全在本地 capture server；真實 provider 端到端尚未重跑（open item，與三家比較無關，是我們自己的閘門）。
5. **（2026-10-07 增補）WS 回應還原**：EightDoor V2 plugin 以 `experimental.ws.receive`＋per-session tail buffer 還原 WS frames（S 級宣稱，見 §6）；我們 fail-closed 拒絕 WS 並以 HTTP preference 導流（wire inventory T4 決策：先導流，必要時才設計 frame 層 adapter）。
6. **（2026-10-07 增補）偵測豐富度**：EightDoor（承 Rehydra 血統）有本地 ONNX NER、semantic enrichment、.env／VCS 身分辨識；我們為規則驅動＋round-trip verifier。屬能力廣度差距，非邊界保證差距。

## 5. 我們領先的點

1. **wire 級 fail-closed**：VibeGuard 遇不支援 payload 會原樣轉送（靜默不保護）；我們一律拒絕並讓使用者知道——這是「安心使用」的核心差異。（2026-10-07 收窄：同世代 V2 對手 EightDoor 的出站 scrub 亦 fail-closed，但位於 message-hook 層，無 wire `http.request` 攔截、未知形狀拒絕與 WS／aisdk 守門，見 §6；獨有性以「wire 層＋未知形狀拒絕」機制定義為準。）
2. **邊界證據文件化**：17 案例＋對照組的可重跑 harness（含 title、retry、tool-error、context、顯示還原），三家 repo 均無等效邊界證據。
3. **安裝健檢**（`--doctor`）：直接回應「插件沒載入卻看似正常」的風險，三家無對應物。

## 6. 同世代參考：EightDoor/opencode-rehydra-sdk（2026-10-07 增補）

來源：`EightDoor/opencode-rehydra-sdk` @ `4b892b0f57b5514a0385a2138642f207ae68b813`（2026-09-30；獨立 repo，內容主體為 `rehydra-ai/rehydra-sdk` 的 MIT 衍生＋新增 V2 plugin 層；npm 已發布 `opencode-rehydar` 0.14.0–0.14.3；0 star、單一作者、成立一週）。**全部為 S 級 source 宣稱，未 runtime 驗證**；不併入 §3 主表（主體與 Rehydra 重複計數），僅記錄與本計畫最接近的同世代設計。

| 軸 | EightDoor V2 plugin（S 級宣稱） | sensitive-guard transparent |
|---|---|---|
| 出站遮罩位置 | `session.hook("context"/"compaction"/"generate"/"title")` 訊息層 scrub（deep-clone、例外 rethrow＝fail-closed） | `http.request` wire 層＋4 request kinds；與 caller 無關 |
| 未知形狀／未涵蓋 caller | 非 message 路徑不經遮罩；回應還原失敗原樣放行（明寫 fail-open） | wire 形狀判別，未知一律 refuse；WS／aisdk 全拒（C 實證） |
| 回覆還原 | `session.hook("http.response")`（JSON walk＋SSE 跨片段 tag 縫合）＋`experimental.ws.receive`（tail buffer 跨 frame 縫合） | `http.response` 三協定＋streaming（C17–C19）；WS fail-closed 拒絕 |
| tool hooks | `execute.before/after` 還原（fail-open，吞錯） | `execute.before` fail-closed（未知 token 拒絕、shell 語法限制）；`execute.after` 架構上不需要——本地結果從未遮罩，回送由 request kinds 保護（C11／C16） |
| 偵測 | regex recognizers＋本地 ONNX NER＋semantic enrich＋.env／git 身分 | 規則驅動（builtin/dynamic）＋round-trip verifier |
| 發布／證據 | npm 已發布；mock 級測試（`plugin-v2.test.ts` 等） | 未 publish（doctor 已支援）；17 案例 host 級 payload E2E＋對照組＋doctor |

結論：**品類雷同**（V2 native、透明假名化、wire 級回應還原、npm 形態、title/compaction 覆蓋），但**出站保證層次不同**——其保證依賴所有 caller 皆經 session hooks（V1 世代弱點的 V2 形狀），本計畫保證位於 wire 邊界且未知形狀拒絕。可參考項（npm 發布工程、WS tail-buffer 還原技術、adapter 單元測試分層；來源 MIT，衍生鏈 rehydra-sdk 亦 MIT，引用需 attribution）另由 plan 追蹤，不在本文件展開。

## 附註：本日 harness 修復

C13（還原探針）今日一度觀察到失敗，根因是 **host 的 read 工具以繼承的 `PWD`（非 spawn cwd）解析相對路徑**，harness 從不同目錄啟動時解析基底跟著漂。修復：spawn env 明確 `PWD=workdir`＋fixture 移入 workdir（修後 shell 與 sandbox 兩種啟動方式皆穩定 pass）。教訓已寫入 harness 註解：任何依賴相對路徑的探針都必須錨定環境。
