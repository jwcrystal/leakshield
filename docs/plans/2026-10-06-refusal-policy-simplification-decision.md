# 拒絕政策重分類與簡化決策（Refusal Policy & Simplification Decision）

日期：2026-10-06
性質：決策紀錄。P1–P5 與全部待決項已由 owner 核可（2026-10-06）；同日 review 的五項技術修正亦經 owner 授權，補強 marker 信任邊界、overlap 完整覆蓋、工具輸入完整性、版本相容與 detector 誤報驗收。Q6 經 owner 再確認，維持刪除真實 provider gate，不採 review 提議的 smoke＋owner re-review 閘門。第 6 節 revision block 與 spec 同步，第 7 節 T1–T3 為工作票。本次僅修文件，不代表政策已實作或驗證通過。
上游文件：
- Spec：`docs/specs/2026-09-30-agent-transparent-pseudonymization.md`（含 2026-10-06 已套用的 owner-approved revision）
- 研究：`docs/evidence/2026-10-05-provider-transport-reference-research.md`（三方參考、hook 名稱）
- 比較：`docs/evidence/2026-10-05-three-way-comparison.md`（含 Phase 3 更新註記）
- 計畫：`docs/plans/2026-10-05-transparent-hardening-execution-plan.md`

---

## 1. 背景與 bug 判定

觸發是「舊 session 歷史經 `SessionRunner.drain` 重播」，不是 session 老化，也與本日稍早的 spec／文件調整無關（純文件；錯誤當下 dist 未重建——dist mtime 10:20 晚於 02:07–02:23 錯誤，錯誤時運行的是既有 build，同日 spec 修訂未觸及程式）。原因分三類：

1. **實作偏離 spec（bug）**：串流回應側把跨 chunk 切半的 marker 誤判 malformed（`splitRestorable` hold 終止未清空 → `MALFORMED_STREAM`），且 `strayTokenIn` 對回應中任何非 tool-args／非 display 路徑的 token 形字串直接拒絕——兩者都超出「unknown marker 留 literal」政策。protect 路徑另證實一個缺陷：孤兒 marker 的 payload 命中 detector 時被**巢狀遮罩**（`[SGP1:…[新token]…]`），marker 就地破壞，重播時製造更多 malformed（重放 236/237 訊息全被遮罩，佐證規模）。
2. **已重現（02:23 stack 根因；DB payload 重放 2026-10-06）**：reason＝`overlapping_findings`——237 則重放訊息中恰一則 assistant 訊息觸發（seq 1332、4,608 chars、**不含任何孤兒 token**；原始掃描 3×SECRET＋2×NDA_KEYWORD 且原座標無重疊，重疊係 protect 路徑內部產生，疑與 decoded-context／URL-window 映射有關，實作時以 `dist/scanner/engine.js` 之 `scanTextWithDecoding` 對照）。孤兒 token 與此失敗無關；早期假說「孤兒 payload → residual_sensitive_content」已被重放否定（payload 命中會被遮罩而非殘留）。新政策歸類：有效座標的 overlap 可 best-effort 合併遮罩，不因重疊本身拒絕；座標錯誤、無法證明完整覆蓋或 rescan 仍有敏感原文時，保留拒絕。
3. **spec 現行要求（政策待修）**：結構識別碼、數字、transport metadata 位置的 token 型內容一律 strict 拒送；工具側未還原即拒絕。failure contract 只設想「工具側 mapping 遺失」，沒設想「歷史重播」——結果是舊 session 永久過不了，死鎖。

Stack 對應：02:07 `protectRequestKind` 直接 throw → 類 3（結構／數字檢查階段）；02:23 `withOpaqueAttachments → protectJsonForModel` 回傳 `!ok` → 類 2（已重現）。

> **基準**：本文件行為描述對應 working tree（含未提交之 attachments／schema-prose 改動、dist 10:20 重建）；`pseudonymization.ts` 自 10-05 未動。重放環境＝現行 dist＋實際 plugin config（`withEncodingDetection` 後），語料＝`opencode.db` ses_ef35b33d 全部 266 列重建為 237 則可重放訊息（user text＋assistant content parts；system 列入 system）。

## 2. 共識原則

**模型邊界對外洩風險 fail-closed；解析不確定只有在遮罩完整、輸入語意安全時才走 best-effort＋notice。工具側保留輸入完整性防線，不把「不洩漏」等同「無副作用」。**

- 三家參考（VibeGuard／Rehydra／opencode-vibeguard）＝單點、best-effort、fail-open；主流（Google DLP／Presidio／Copilot 類）＝確定性金鑰、per-finding 處理、多為單向遮罩。兩邊指向同一結論：拒絕條件不該綁在解析完整度上。
- 架構取捨：wire 層留作唯一 enforcement 與證據邊界；容忍度抄三家。**不照搬** refs 架構——V1 plugin 不能跑 V2、V2 無 `experimental.text.complete` 一對一替代、V2 compaction 在 request hooks 之後 append、三家均無 payload 級證據層。

## 3. 修法（槓桿排序）

- **P1 拒絕重分類**（立即；解死鎖、也解現存 DB 孤兒——確定性金鑰落地前的遷移路徑）：
  - token 型內容（孤兒／foreign／expired／malformed／bare prefix／切半）本身永不構成拒絕理由。
  - 模型側文字：無敏感命中時保留 literal；歷史重播不因 mapping 遺失本身被擋。**前綴或格式不是信任證明**：只有本 session 已登記 token（或 T2 落地後經密碼學驗證的 token）可豁免內部掃描。完整但無 mapping 的 marker 仍掃描 payload；命中時整段 marker 遮罩，避免巢狀替換。malformed／bare prefix／切半照普通文字掃描，不因缺少結尾而豁免後續文字；跨 marker 的 findings 必須完整覆蓋，無法安全遮罩才拒絕。
  - 結構識別碼／transport metadata／數字位置：marker 本身不拒絕；未驗證內容仍依相同掃描原則處理。確認無敏感原文才原樣保留，若敏感命中且無法在不破壞協定的前提下遮罩／更名，仍拒送。降級可見性＝對話現場（可呈現的 token 字面值／本地診斷）＋host log WARN 一行（content-free），不注入 notice 進 body、不另建檔案。
  - 工具側有限 best-effort：僅在可證明唯讀、且 literal 不改變目標／參數語意時，允許 unresolved token 原樣傳入並附可行動的本地診斷（規則／型別＋復原步驟）。寫入、刪除、外送等有副作用的呼叫，以及未能證明輸入安全的未知工具／shell 語境，仍拒絕受影響呼叫，且須在任何參數套用或副作用前完成檢查；不阻斷整個 session。shell quoting／globbing／option injection 與 tool input shape 檢查保留。降級以 in-band 診斷＋content-free host log WARN 呈現；不新增獨立授權系統，正確還原原文仍由既有 OpenCode permissions 控制。
  - Overlap：有效座標的部分交疊與連鎖交疊取**聯集遮罩**，完全包含取外層，重複範圍去重；不得只取最長 span 丟掉另一 finding 的尾段。結果須非重疊、完整覆蓋全部待遮罩 findings，並通過 rescan／原文 absence 檢查；涉及已登記 token 的交疊須保留其還原完整性，無法兼顧時拒絕。
  - **拒絕 UX（實作要求）**：僅存的每一個拒絕必須附可行動、不含內容的訊息——指明原因（detector／規則名、位置類型）與修法（調整 config、更換 provider 協定）；已知不支援路由（WebSocket、`aisdk`、未知 dialect）必須在 `status`/`--doctor` pre-flight 警告，讓使用者在配置期而非對話中第一次遇到；降級（preserve＋notice）可見於對話現場（token 字面值＋工具診斷）＋host log WARN 一行，不另建檔案、`--doctor` 不承諾降級史查詢，永不注入請求 body。
- **P2 誤報源治理**：電話 regex 改 **opt-in 預設關**（2026-10-06 owner 拍板；漏真電話風險寫入 profile 文件；context guard 不做）；`assertNumbersSafe` 縮到內容位置（**保留**，不砍）；新增**預設規則 FP 稽核**——以非 dev 乾淨語料跑各規則命中率列表，偏寬的關鍵字規則（NDA_KEYWORD 類）加 domain 限制或降權。證據：重放 236/237 訊息 100% 被遮罩——P1 把拒絕面縮到最窄後，「過度遮罩」（無辜文字被插 token、模型所見失真）成為剩餘的主要體驗傷害。
- **P3 確定性轉換＋持久金鑰（不排期，觸發條件制）**：token 改為確定性可逆轉換、金鑰存 OS keychain；孤兒／epoch／resume 三類問題結構性消失。代價：keychain 授權提示（新摩擦）、per-session 隔離作廢、key 洩漏＝全歷史可反查、確定性 token 跨 session 可關聯（皆寫入 spec）。**觸發條件：真實使用中 resume 降級（token 字面值）造成實際困擾才啟動。** 事實基礎：三家均無持久金鑰與跨重啟還原（research doc L78／L94-95／L118／L122-126——OV 為 per-session 隨機 secret＋TTL、Rehydra in-memory map 跨重啟拋錯、VG proxy 內 session manager），且同場景行為更差（OV 靜默壞、Rehydra 拋錯、VG 留原樣）；P1 之後本專案 resume 降級已是四者最佳。舊 token 由 P1 政策回收。
- **P4 產品分層（撤回；Q6 維持刪除真實 provider gate）**：以原始目標三要素（替換機敏、防外洩、無感體驗）檢驗後，單向預設與「無感體驗」矛盾（回覆中可見 token）。**P1 落地＋C-matrix（既有 C1–C19 harness）全綠 → 新裝預設 transparent**。owner 再確認不採 review 提議的最低 smoke＋owner re-review 閘門；P1 後 live pass 為非阻擋自檢，不是新增 gate。這是接受剩餘驗證風險的產品決策，不代表 dogfooding 已證明優於或可取代可重跑測試，也不代表未 publish 就無風險。C-matrix 全綠僅代表已涵蓋案例通過，不等同所有 provider／client 路徑已端到端證明；coverage matrix 中 compaction 仍只有結構論證，保留缺口註記，補證不另設 default-flip gate。單向遮罩仍為退化／保守選項，非目標預設；既有 explicit policy 與 implicit-default migration 條件不變。
- **P5 層級簡化（目標態）**：session hooks 定位＝序列化前遮罩優化＋使用者通知載點；wire 層為唯一 enforcement 與證據邊界。目標態＝移除 session 層（單層 wire＋`tool:execute.before`），移除前置條件：(a) wire-bypass 防護——確認除 WS／`aisdk`（既有拒絕）外無路徑繞過 wire 層；(b) notice／診斷遷移至 wire／doctor；(c) C-matrix 於拔除 session hooks 後重跑全綠。P1–P4 落地後啟動評估。

## 4. 明確不做

- doctor 掃 `opencode.db`／記憶注入檔（P1 之後多餘；context-mode 注入由 P1 政策涵蓋）。
- 直接移除 `assertNumbersSafe`、移除「敏感原文落在結構位置」的拒絕（這兩者是真實外洩風險，不在重分類範圍）。
- 照搬 refs 的覆蓋空白（system 不遮罩、title／compaction 缺口、無 binary 處理）。

## 5. 保留資產

- wire 層 `http.request/response`＋C1–C19／C6 對照組證據 harness。
- 差異化定義收斂為一句：**模型外送 fail-closed；工具輸入保完整性；其餘在安全前提下 best-effort。**

---

## 6. 已套用的 Spec revision（English，含同日 review 修正）

> 與 spec 的 `### 2026-10-06b (owner-approved)` 同步；取代該 revision 早先的全面 payload 豁免、最長 span、工具無拒絕與舊版 token 永不 restore 措辭。Q6 維持刪除真實 provider gate；先前 `2026-10-06` revision 保留，預設切換閘門等衝突處以本條為準。

```
### 2026-10-06b (owner-approved)

1. **Refusal reclassified: tolerate parse uncertainty only when protection and input integrity remain provable.**
   - Unresolvable reserved markers (orphaned, foreign, expired, malformed, bare-prefix, or split) do not by themselves justify refusing a provider-bound request or history replay. A prefix or matching format grants no ownership or scan exemption: only tokens registered to the requesting session, or cryptographically verified tokens after item 3 is implemented, qualify. Unverified content is still scanned, including marker payloads. Preserve literal content only when no sensitive originals are detected; if a complete unowned marker contains a finding, mask the whole marker instead of nesting a replacement inside it. Malformed, bare-prefix, and split content is scanned as ordinary text; an absent terminator must not exempt subsequent text. Findings crossing marker boundaries require full coverage or safe refusal.
   - Apply the same rule to structural identifiers, transport metadata, and numeric positions: preserve unresolved markers only when no sensitive originals are exposed; refuse detected sensitive content that cannot be masked or renamed without breaking the protocol. Existing fail-closed safeguards for unsupported routes, scan limits, scanner errors, and unscannable input remain. Mapping loss alone never blocks history replay. Degradation surfaces through available local conversation/tool diagnostics and a content-free host-log WARN — no provider-body notices or side files; `--doctor` does not promise degradation-history queries.
   - Every remaining refusal carries an actionable, content-free message naming the cause (detector/rule, position kind) and the remedy. Known-unsupported routes (WebSocket, `aisdk`, unrecognized dialects) are surfaced pre-flight by `status`/`--doctor` rather than first hit mid-conversation, and degradation notices never enter provider-bound bodies.
   - Tool-side degradation is permitted only for proven read-only calls whose targets and argument semantics remain safe with literal placeholders. Side-effecting calls (including writes, deletes, or outbound transmission), unknown tools, and unsupported shell contexts are refused when correct restoration or safe semantics cannot be guaranteed. Validate the entire invocation before applying replacements or allowing side effects; retain shell quoting/globbing/option-injection and input-shape safeguards. Refuse only the affected invocation, not the session, and provide actionable, content-free diagnostics in-band and in the host log. Correctly restored originals remain subject to existing OpenCode permissions; no separate authorization system is added.
   - Amendment (2026-11-05): the original decision above is kept as written, but unknown tools are no longer refused wholesale. Restoration policy is now decided per field: shell tools and command-like fields get shell rules, `code`/`script` fields restore a placeholder only under a restricted single-line string rule (a conservative heuristic, not syntax verification; it can over-refuse and miss, refuses multi-line strings, triple-quote lines and backslash continuations, and guards the restoration context only, not egress) and refuse originals containing shell-unsafe characters; a refused call is blocked, not masked, and keeps its placeholder, and other fields restore verbatim.
   - Resolve valid overlapping findings by masking their union, including transitively overlapping spans; containment uses the outer span and identical spans are deduplicated. The output must be non-overlapping and cover every actionable finding, with rescan and original-absence checks retained. Do not discard partially overlapping tails by selecting only the longest span. Invalid coordinates or conflicts with registered-token restoration integrity remain grounds for safe refusal.
   - This item narrows the request failure contract only for unresolved markers that can be safely protected, and the tool failure contract only for proven-safe read-only literal-placeholder calls. "No notice-substituted continuation" remains required for unprotectable input; "tool was not executed" and no-side-effect assertions remain required for unsafe restoration. Tests identify these cases by behavior, not stale spec line numbers.
2. **Numeric and detector false-positive governance.** Telephone detection becomes opt-in (off in the default profile; the missed-phone trade-off is documented in the profile — no context-guard mechanism). The numeric-field scan is retained but bounded to content positions instead of every numeric value. A default-rule false-positive audit is added to scope: per-rule hit rates on clean, non-dev corpora, with overly broad keyword rules (NDA_KEYWORD-style) narrowed by domain constraints or demoted. Evidence: replay masked 236/237 messages — after refusals are narrowed, over-masking becomes the dominant experience cost.
3. **Deterministic, key-custodied reversible tokens (direction; not scheduled — trigger-gated).** The in-memory session-scoped mapping would be replaced by a deterministic reversible transformation whose key is held in the OS keychain; tokens become stable across restarts and sessions, restoration becomes decryption. When implemented, this replaces US7 (per-session mapping isolation), US8 (process-memory-only mappings), the single-process framing of US9, and the Out of Scope entry on persistent reverse mappings; key custody replaces session isolation as the protection boundary and key disclosure — re-identification of all history — becomes the documented central risk. Implementation is triggered only if resumed sessions showing literal placeholders become a real-world annoyance. The three examined reference integrations do not establish cross-restart restoration for this project. Use a distinct format version for ciphertext, coordinated with item 6; old tokens with valid mappings remain restorable, and tokens without mappings follow item 1. This direction does not retire current isolation or lifetime requirements before implementation.
4. **Default profile (tiering proposal withdrawn; Q6 gate removal reconfirmed).** New installations default to transparent pseudonymization once P1 lands and the existing C1–C19 harness C-matrix is green. The owner reconfirmed removal of the real-provider gate and rejected the review's proposed minimum smoke plus owner re-review gate; a post-P1 live pass is a non-blocking self-check, not a prerequisite. This accepts residual validation risk rather than claiming dogfooding outperforms or replaces repeatable tests, or that an unpublished package has no risk. C-matrix green proves only its covered cases, not complete provider/client end-to-end coverage; compaction still has only structural reasoning in the coverage matrix, remains a documented evidence gap, and does not add a separate default-flip gate. This item supersedes the 2026-10-06 revision item 2's real-provider and owner re-review prerequisites. One-way masking remains a degraded/conservative option, not the target default. Until P1 and the C-matrix pass, the shipped default remains `block`; explicit legacy settings and implicit-default migration requirements are unchanged.
5. **Layering posture.** Session hooks provide best-effort early protection and user-facing notices; the provider wire layer remains the enforcement and evidence boundary. Supported-route refusals (WebSocket, `aisdk` routes, unknown/mixed dialects) are unchanged — they are leak-risk refusals, not parse-uncertainty refusals.
6. **Token format compatibility and detector resilience.** T1 establishes safe marker handling before T3 introduces the SGP2 mapping-token format; T2 remains trigger-gated and must use a separate ciphertext version rather than repurposing SGP1 or SGP2. Keep SGP1 restoration for valid session mappings; mapping loss follows item 1, not unconditional preserve-only behavior. Short mixed-character payloads aim to reduce false positives from built-in detectors, not guarantee immunity to arbitrary custom rules or known-value matches. Acceptance covers full-token fixed-corpus measurements against a versioned built-in/default configuration, custom-rule and known-value collisions, mixed-version restoration, and marker-wrapped synthetic secrets; trusted-token recognition and boundary checks remain authoritative regardless of detector hit rate.
```

## 7. 票的草稿

### T1（bug）孤兒／malformed token 導致請求與工具被拒（舊 session 死鎖）

**現象**

- 2026-10-06 02:07–02:23 `~/.local/share/opencode/log/opencode.log` 共 5 次 `failed to protect a model request`，全部發生在 `SessionRunner.drain` 處理舊 dev session（`ses_ef35b33d5ffe…`）。
- 兩種 stack：`protectRequestKind` 直接 throw（結構／數字檢查階段）；`withOpaqueAttachments → protectJsonForModel` 回傳 `!ok`。
- `opencode.db` 至少 10 個舊測試 session 的 assistant 訊息含 token 字面值（35／66／16 則…），mapping 已隨重啟消失，全為孤兒。
- 同源注入：context-mode 記憶塊（舊 CLAUDE.md 摘要）含 token 化文字，會注入每個新請求。
- 本對話 `ses_ef0f6c75` 自身被擋兩次：shell 工具拒絕＋串流 `incomplete`。

**根因**

- 02:23 型（已重現，2026-10-06 DB 重放）：`overlapping_findings`——單一 assistant 訊息（seq 1332，無孤兒 token；掃描 3×SECRET＋2×NDA_KEYWORD、原座標無重疊）在 protect 路徑內部產生重疊 findings → 整請求 `!ok`。修法：有效 findings 聯集遮罩，完整覆蓋且 rescan 通過才放行；一併修巢狀遮罩破壞孤兒 marker 的缺陷（未驗證 payload 仍掃描，命中完整 marker 時整段替換，不授予前綴豁免）。
- 02:07 型（spec 現行要求）：`assertStructuralSafe`／`assertNumbersSafe` 對結構位置與全部數字做敏感性拒絕（wire 層已重現：token 放結構識別碼 → 拒絕）。
- 串流 `splitRestorable` 終止未清空 → `MALFORMED_STREAM`、`strayTokenIn` 對非 tool-args 之 token 字串拒絕（實作偏離，response 側）；工具側 strict 拒絕（spec 現行要求，P1 取代）。

**修法與驗收**

- 依決策紀錄 P1：token 型內容／mapping 遺失本身不拒；歷史重播仍需完整遮罩，工具僅在唯讀且 literal 語意安全時 best-effort＋可見診斷（in-band＋host log WARN）。
- Overlap 解重疊＝**聯集遮罩**；驗收含部分交疊 `[0,10)`＋`[8,15)` → `[0,15)`、完全包含、等長交疊與連鎖交疊。每個 actionable finding 均完整覆蓋，結果非重疊且 rescan／原文 absence 通過；聯集原文 restore 往返須精確。
- 驗收：舊 session drain 不因孤兒本身失敗；C1–C19 不回歸；新增孤兒於 history／結構／數字位置、bare prefix、跨 chunk 切半、**marker 包裹 synthetic secret 及缺少結尾仍不得外洩**、工具降級的可見診斷、寫檔／刪除／外送／未知工具與 shell glob／metacharacter 不安全時零副作用，以及 **seq 1332 型重放完整遮罩通過**。既有 canary 斷言不變；拒絕訊息可行動（原因＋修法），WS／`aisdk`／未知 dialect 於 `status`/`--doctor` pre-flight 可見。
- **測試斷言分類**：只將 marker 本身拒絕與已證明安全的唯讀降級用例改為 preserve＋diagnostic；保留外洩、unsafe restoration、input shape 與副作用拒絕斷言。實作時列出變更清單，不成批取消 fail-closed 測試。

### T2（design）確定性可逆 token ＋ OS keychain 金鑰

**動機**：消滅孤兒 token／session epoch／resume 死鎖三類問題；同時刪掉 mapping 容量、eviction、per-session 隔離等複雜度（`PseudonymLimits` 大部分、epoch 機制）。attribution 對 mapping 的依賴消失，但 sessionID 對 audit／notice 仍需要——勿期望整刪 attribution 機制。（2026-10-06 補充：孤兒／死鎖兩類已由 P1 政策回收，T2 剩餘價值＝resume 完整還原＋內部複雜度刪減；三家均無此機制，觸發條件見 P3。）

**方向**

- token ＝確定性可逆轉換（deterministic AEAD 如 AES-SIV；若評估 FPE，另須定義完整性驗證），使用**獨立密文格式版本**，不得把既有 SGP1／SGP2 重新解讀為密文；還原＝驗證後解密，免 mapping。T2 仍依 P3 觸發條件啟動，格式設計須與 T3 協調。
- 金鑰存 OS keychain（Keychain／DPAPI／libsecret），明令不得落地明文檔；keychain 不可用時的行為需定義（建議：降級為單向遮罩，不 fail-closed）。
- 同一原文在任何 session／重啟後得到同一 token。

**影響（需 spec 同意）**

- 實作落地後取代 US7 per-session 隔離、US8 記憶體-only；接受「key 洩漏＝全歷史可反查」為中心風險；確定性 token 意味同一原文跨 session 同 token——provider 側可關聯同一秘密（US7 隔離的妥協，須文件化）。落地前現行隔離／生命週期要求仍有效；舊 token 有有效 mapping 就還原，無 mapping 才依 T1 安全降級。

**未定項**

- token 格式與長度、金鑰輪替與版本前綴、與 block／redact／deidentify 的共用、keychain 授權提示 UX。

**驗收**

- 新密文 token 重啟後／跨 session 直接還原；金鑰缺失或驗證失敗路徑安全降級；與 SGP1／SGP2 混合歷史辨識正確，有有效 mapping 的舊 token 不退化，無 mapping 不猜測／誤解密。

### T3（design）SGP2 低誤報 token 格式＋類別標註

**動機**：現行 payload 是偵測器誘餌——32-hex epoch 像 hex 金鑰、計數器數字段中電話規則（隨機 token 命中率 0.24%）、已實證孤兒 marker 被巢狀遮罩破壞。T1 先建立安全 marker 處理；T3 在其後降低內建規則誤報，不取代信任邊界。T2 不因 T3 排期而提前啟動，若觸發則另用密文版本。

**方向**

- 版本位升級：`[SGP2:<CATEGORY>:<分段短混合字元>]`（如 `[SGP2:EMAIL:k3f9-m2a8]`，僅格式示意，非 token 容量規格）；payload 避免長 hex／數字連續，以降低內建 detector 誤報。自訂 regex、known-value 或類別字樣仍可能命中，不承諾格式對任意 detector 免疫；碰撞處理與安全性由 T1 的可信 token 辨識／完整掃描保證。
- 類別標註對齊主流 surrogate 慣例（Google DLP infoType surrogate、OV category marker）：模型知道替代物類型（回應更自然）、降級通知可描述「已隱藏一個 email」；類別僅 metadata，洩漏給 provider 可接受。
- 舊 SGP1 辨識與 restore 保留：本 session 有有效 mapping 就精確還原，無 mapping 才依 T1 preserve／整段遮罩或工具安全拒絕。無需 DB 資料遷移；新 token 鑄造切到 SGP2，不使仍有效的 SGP1 失效，也不把舊版重新解讀為密文。

**驗收**

- 新格式鑄造／restore 精確往返與不同原文可區分；以固定 token 語料對**完整 token（含類別）**跑版本化內建／預設規則，記錄各規則命中率及相對 SGP1 的改善，不把抽樣零命中宣稱為普遍免疫。新增自訂規則／known-value 碰撞與 marker 包裹 synthetic secret 用例，仍保持遮罩與還原安全；SGP1／SGP2 混合歷史中有效 mapping 可還原、無 mapping 安全降級；C-matrix 全綠的證據條件同 P4。

## 8. 待決小項（全部已決，2026-10-06 owner）

- 電話偵測 → **opt-in 預設關**（context guard 不做；漏報風險寫入 profile 文件）。
- Overlap 策略 → **聯集遮罩＋完整覆蓋／rescan 驗證**（入 T1，取代最長 span 勝出）。
- 拒絕／降級訊息文案 → 與 T1 一併產出（不變）。
- Revision 標題 → **`2026-10-06b`**。
- 降級紀錄載體 → **不建檔案**：in-band（token 字面值＋工具診斷）＋host log WARN 一行。
- 真實 provider gate → **維持刪除，owner 再確認**（default-flip＝P1＋既有 C1–C19 C-matrix 全綠；不新增 smoke／owner re-review／compaction 補證閘門，驗證缺口照實記錄）。
- 預設規則 FP 稽核 → **納入 P2**。
- Token 格式 → T1 僅豁免可信 token，未驗證 payload 照常掃描、必要時整段遮罩；**另開 T3（SGP2）** 降低誤報，保留有效 SGP1 restore；T2 使用獨立密文版本。
