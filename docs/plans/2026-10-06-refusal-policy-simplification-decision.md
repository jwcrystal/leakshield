# 拒絕政策重分類與簡化決策（Refusal Policy & Simplification Decision）

日期：2026-10-06
性質：決策紀錄。P1–P5 與全部待決項已由 owner 核可（2026-10-06）；第 6 節 revision block 套用進 spec，第 7 節 T1–T3 為工作票。本文件不修改程式碼。
上游文件：
- Spec：`docs/specs/2026-09-30-agent-transparent-pseudonymization.md`（含 2026-10-06 已套用的 owner-approved revision）
- 研究：`docs/evidence/2026-10-05-provider-transport-reference-research.md`（三方參考、hook 名稱）
- 比較：`docs/evidence/2026-10-05-three-way-comparison.md`（含 Phase 3 更新註記）
- 計畫：`docs/plans/2026-10-05-transparent-hardening-execution-plan.md`

---

## 1. 背景與 bug 判定

觸發是「舊 session 歷史經 `SessionRunner.drain` 重播」，不是 session 老化，也與本日稍早的 spec／文件調整無關（純文件；錯誤當下 dist 未重建——dist mtime 10:20 晚於 02:07–02:23 錯誤，錯誤時運行的是既有 build，同日 spec 修訂未觸及程式）。原因分三類：

1. **實作偏離 spec（bug）**：串流回應側把跨 chunk 切半的 marker 誤判 malformed（`splitRestorable` hold 終止未清空 → `MALFORMED_STREAM`），且 `strayTokenIn` 對回應中任何非 tool-args／非 display 路徑的 token 形字串直接拒絕——兩者都超出「unknown marker 留 literal」政策。protect 路徑另證實一個缺陷：孤兒 marker 的 payload 命中 detector 時被**巢狀遮罩**（`[SGP1:…[新token]…]`），marker 就地破壞，重播時製造更多 malformed（重放 236/237 訊息全被遮罩，佐證規模）。
2. **已重現（02:23 stack 根因；DB payload 重放 2026-10-06）**：reason＝`overlapping_findings`——237 則重放訊息中恰一則 assistant 訊息觸發（seq 1332、4,608 chars、**不含任何孤兒 token**；原始掃描 3×SECRET＋2×NDA_KEYWORD 且原座標無重疊，重疊係 protect 路徑內部產生，疑與 decoded-context／URL-window 映射有關，實作時以 `dist/scanner/engine.js` 之 `scanTextWithDecoding` 對照）。孤兒 token 與此失敗無關；早期假說「孤兒 payload → residual_sensitive_content」已被重放否定（payload 命中會被遮罩而非殘留）。新政策歸類：overlap 屬「解析不確定」→ best-effort 解重疊（最長 span 或聯集遮罩），不拒絕。
3. **spec 現行要求（政策待修）**：結構識別碼、數字、transport metadata 位置的 token 型內容一律 strict 拒送；工具側未還原即拒絕。failure contract 只設想「工具側 mapping 遺失」，沒設想「歷史重播」——結果是舊 session 永久過不了，死鎖。

Stack 對應：02:07 `protectRequestKind` 直接 throw → 類 3（結構／數字檢查階段）；02:23 `withOpaqueAttachments → protectJsonForModel` 回傳 `!ok` → 類 2（已重現）。

> **基準**：本文件行為描述對應 working tree（含未提交之 attachments／schema-prose 改動、dist 10:20 重建）；`pseudonymization.ts` 自 10-05 未動。重放環境＝現行 dist＋實際 plugin config（`withEncodingDetection` 後），語料＝`opencode.db` ses_ef35b33d 全部 266 列重建為 237 則可重放訊息（user text＋assistant content parts；system 列入 system）。

## 2. 共識原則

**fail-closed 只對「可能外洩」成立；「解析不確定」走 best-effort preserve＋notice。**

- 三家參考（VibeGuard／Rehydra／opencode-vibeguard）＝單點、best-effort、fail-open；主流（Google DLP／Presidio／Copilot 類）＝確定性金鑰、per-finding 處理、多為單向遮罩。兩邊指向同一結論：拒絕條件不該綁在解析完整度上。
- 架構取捨：wire 層留作唯一 enforcement 與證據邊界；容忍度抄三家。**不照搬** refs 架構——V1 plugin 不能跑 V2、V2 無 `experimental.text.complete` 一對一替代、V2 compaction 在 request hooks 之後 append、三家均無 payload 級證據層。

## 3. 修法（槓桿排序）

- **P1 拒絕重分類**（立即；解死鎖、也解現存 DB 孤兒——確定性金鑰落地前的遷移路徑）：
  - token 型內容（孤兒／foreign／expired／malformed／bare prefix／切半）本身永不構成拒絕理由。
  - 模型側文字：literal 保留，周圍文字照常掃描；歷史重播永不擋。
  - 結構識別碼／transport metadata／數字位置：原樣保留，可見性＝對話現場（token 字面值）＋host log WARN 一行（content-free），不拒絕、不注入 notice 進 body、不另建檔案。
  - 工具側同原則 best-effort：還原失敗不再擋整個呼叫；參數保留 token 字面值，回傳可行動的本地診斷（規則／型別＋復原步驟），降級以 in-band 診斷＋host log WARN 呈現。新政策下工具側無拒絕條件——敏感原文防線在模型邊界；本地寫入與外送真值本就是還原機制的設計目的。（此項修訂 2026-10-06 稍早「工具維持 standalone-or-refuse」的口頭共識：token 字面值執行＝安全失敗，不洩漏、不注入。）
  - **拒絕 UX（實作要求）**：僅存的每一個拒絕必須附可行動、不含內容的訊息——指明原因（detector／規則名、位置類型）與修法（調整 config、更換 provider 協定）；已知不支援路由（WebSocket、`aisdk`、未知 dialect）必須在 `status`/`--doctor` pre-flight 警告，讓使用者在配置期而非對話中第一次遇到；降級（preserve＋notice）可見於對話現場（token 字面值＋工具診斷）＋host log WARN 一行，不另建檔案、`--doctor` 不承諾降級史查詢，永不注入請求 body。
- **P2 誤報源治理**：電話 regex 改 **opt-in 預設關**（2026-10-06 owner 拍板；漏真電話風險寫入 profile 文件；context guard 不做）；`assertNumbersSafe` 縮到內容位置（**保留**，不砍）；新增**預設規則 FP 稽核**——以非 dev 乾淨語料跑各規則命中率列表，偏寬的關鍵字規則（NDA_KEYWORD 類）加 domain 限制或降權。證據：重放 236/237 訊息 100% 被遮罩——P1 把拒絕面縮到最窄後，「過度遮罩」（無辜文字被插 token、模型所見失真）成為剩餘的主要體驗傷害。
- **P3 確定性轉換＋持久金鑰（不排期，觸發條件制）**：token 改為確定性可逆轉換、金鑰存 OS keychain；孤兒／epoch／resume 三類問題結構性消失。代價：keychain 授權提示（新摩擦）、per-session 隔離作廢、key 洩漏＝全歷史可反查、確定性 token 跨 session 可關聯（皆寫入 spec）。**觸發條件：真實使用中 resume 降級（token 字面值）造成實際困擾才啟動。** 事實基礎：三家均無持久金鑰與跨重啟還原（research doc L78／L94-95／L118／L122-126——OV 為 per-session 隨機 secret＋TTL、Rehydra in-memory map 跨重啟拋錯、VG proxy 內 session manager），且同場景行為更差（OV 靜默壞、Rehydra 拋錯、VG 留原樣）；P1 之後本專案 resume 降級已是四者最佳。舊 token 由 P1 政策回收。
- **P4 產品分層（撤回，2026-10-06 owner 決策）**：以原始目標三要素（替換機敏、防外洩、無感體驗）檢驗後，單向預設與「無感體驗」矛盾（回覆中可見 token）。維持既有閘門並簡化：**P1 落地＋C-matrix 全綠 → 新裝預設 transparent**（真實 provider E2E gate 已刪除——實機 dogfooding 已證明檢出力高於腳本化 E2E，npm 未 publish 前影響面為零；「P1 後實測一輪」為常識性自檢註記，非 gate）。單向遮罩定位為退化模式（keychain 不可用之 fallback、保守場景選項），非預設。
- **P5 層級簡化（目標態）**：session hooks 定位＝序列化前遮罩優化＋使用者通知載點；wire 層為唯一 enforcement 與證據邊界。目標態＝移除 session 層（單層 wire＋`tool:execute.before`），移除前置條件：(a) wire-bypass 防護——確認除 WS／`aisdk`（既有拒絕）外無路徑繞過 wire 層；(b) notice／診斷遷移至 wire／doctor；(c) C-matrix 於拔除 session hooks 後重跑全綠。P1–P4 落地後啟動評估。

## 4. 明確不做

- doctor 掃 `opencode.db`／記憶注入檔（P1 之後多餘；context-mode 注入由 P1 政策涵蓋）。
- 直接移除 `assertNumbersSafe`、移除「敏感原文落在結構位置」的拒絕（這兩者是真實外洩風險，不在重分類範圍）。
- 照搬 refs 的覆蓋空白（system 不遮罩、title／compaction 缺口、無 binary 處理）。

## 5. 保留資產

- wire 層 `http.request/response`＋C1–C19／C6 對照組證據 harness。
- 差異化定義收斂為一句：**對「外送」fail-closed；其餘 best-effort。**

---

## 6. Spec revision 草案（English，待 owner 核可後以 dated revision block 套用）

> 套用注意：2026-10-06 已有一條 owner-approved revision（附件政策／預設閘門／NER／detector 措辭）。本條若同日套用，標題改用 `### 2026-10-06b policy revision (owner-approved)` 或併入同一節，避免同日期兩條混淆。

```
### 2026-10-06b policy revision (owner-approved 2026-10-06)

1. **Refusal reclassified: fail closed on leak risk, not on parse uncertainty.**
   - Reserved-marker-shaped content that cannot be resolved (orphaned, foreign, expired, bare-prefix, or split) is never by itself grounds to refuse a provider-bound request or to block history replay. In model-bound conversation/history and assistant display text it stays literal and the surrounding text is still scanned. In structural identifiers, transport metadata, and numeric positions it is preserved unchanged, visible via the conversation surface (literal token, tool diagnostics) plus a content-free WARN line in the host log — no side files; `--doctor` does not promise degradation-history queries.
   - A provider-bound request is refused only when detected sensitive originals would cross the boundary in a position that cannot be masked, renamed, or preserved without disclosure. History replay never refuses for unresolvable placeholders.
   - Every remaining refusal carries an actionable, content-free message naming the cause (detector/rule, position kind) and the remedy. Known-unsupported routes (WebSocket, `aisdk`, unrecognized dialects) are surfaced pre-flight by `status`/`--doctor` rather than first hit mid-conversation, and degradation notices never enter provider-bound bodies.
   - Tool-side restoration becomes best-effort on the same principle: an unresolved or unsafe placeholder no longer blocks the invocation by default. The affected argument keeps the literal placeholder, the local caller receives an actionable diagnostic naming the rule/type and the recovery step, and the degradation surfaces in-band and as a content-free host-log WARN line. Tool-side execution has no refusal conditions under this policy — the sensitive-original boundary is the provider boundary, and local writes or outbound transmission of restored originals are the intended behavior of restoration. (This revises the same-day earlier consensus of standalone-or-refuse tool restoration.)
   - Overlapping or colliding detector findings are resolved best-effort instead of failing the request: the longest span wins, ties take the earlier finding, and the non-overlap invariant is preserved.
   - This item supersedes: failure-contract bullet 1 (request-stop) to the extent it covered token-type content; failure-contract bullet 2 (tool refusal for unresolved mappings); and the Testing Decisions assertions at spec:156 ("no notice-substituted continuation") and spec:157 ("tool was not executed") for unresolved tool mappings.
2. **Numeric and detector false-positive governance.** Telephone detection becomes opt-in (off in the default profile; the missed-phone trade-off is documented in the profile — no context-guard mechanism). The numeric-field scan is retained but bounded to content positions instead of every numeric value. A default-rule false-positive audit is added to P2's scope: per-rule hit rates on clean, non-dev corpora, with overly broad keyword rules (NDA_KEYWORD-style) narrowed by domain constraints or demoted. Evidence: replay masked 236/237 messages — after refusals are narrowed, over-masking becomes the dominant experience cost.
3. **Deterministic, key-custodied reversible tokens (direction; not scheduled — trigger-gated).** The in-memory session-scoped mapping would be replaced by a deterministic reversible transformation whose key is held in the OS keychain; tokens become stable across restarts and sessions, restoration becomes decryption. This supersedes US7 (per-session mapping isolation), US8 (process-memory-only mappings), the single-process framing of US9, and the Out of Scope entry on persistent reverse mappings; key custody replaces session isolation as the protection boundary and key disclosure — re-identification of all history — becomes the documented central risk. Implementation is triggered only if resumed sessions showing literal placeholders become a real-world annoyance: none of the three reference projects ship persistent keys or cross-restart restoration (their resume behavior is worse — silent pass-through, thrown errors, or literal markers), so P1's visible degradation is already best-in-class. Placeholders issued before this change are orphaned and governed by item 1.
4. **Default profile (tiering proposal withdrawn).** The deferred default-flip gate of the 2026-10-06 revision stands, simplified: new installations default to transparent pseudonymization once P1 lands and the C-matrix is green. The real-provider E2E gate is removed — dogfooding has already caught what scripted E2E would not, and the audience before npm publish is the owner; a post-P1 live pass is a self-check note, not a gate. One-way masking is a degraded/fallback profile (keychain unavailable, conservative contexts), not the default — single-way display of placeholders contradicts the zero-friction experience goal. This item records the withdrawal; US1 is unchanged.
5. **Layering posture.** Session hooks provide best-effort early protection and user-facing notices; the provider wire layer remains the enforcement and evidence boundary. Supported-route refusals (WebSocket, `aisdk` routes, unknown/mixed dialects) are unchanged — they are leak-risk refusals, not parse-uncertainty refusals.
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

- 02:23 型（已重現，2026-10-06 DB 重放）：`overlapping_findings`——單一 assistant 訊息（seq 1332，無孤兒 token；掃描 3×SECRET＋2×NDA_KEYWORD、原座標無重疊）在 protect 路徑內部產生重疊 findings → 整請求 `!ok`。修法：best-effort 解重疊（最長 span 勝出），不拒絕；一併修巢狀遮罩破壞孤兒 marker 的缺陷（payload 不掃或 preserved span 豁免）。
- 02:07 型（spec 現行要求）：`assertStructuralSafe`／`assertNumbersSafe` 對結構位置與全部數字做敏感性拒絕（wire 層已重現：token 放結構識別碼 → 拒絕）。
- 串流 `splitRestorable` 終止未清空 → `MALFORMED_STREAM`、`strayTokenIn` 對非 tool-args 之 token 字串拒絕（實作偏離，response 側）；工具側 strict 拒絕（spec 現行要求，P1 取代）。

**修法與驗收**

- 依決策紀錄 P1：token 型內容永不拒；歷史重播永不擋；工具側 best-effort＋可見診斷（in-band＋host log WARN）。
- Overlap 解重疊＝**最長 span 勝出**（等長取先出現；結果保非重疊不變量）。
- 驗收：舊 session drain 能完成；C1–C19 不回歸；新增用例——孤兒 token 於 history／結構／數字位置、bare prefix、跨 chunk 切半、工具還原失敗的可見診斷、**overlap best-effort 通過（重放語料 seq 1332 型）**；既有 canary 斷言不變；拒絕訊息可行動（原因＋修法），WS／`aisdk`／未知 dialect 於 `status`/`--doctor` pre-flight 可見。
- **測試斷言翻轉**：既有 strict-refusal 單元測試成批翻轉為 best-effort 斷言（preserve＋diagnostic），清單於實作時列出；「既有 canary 斷言不變」僅指 E2E canary，不含此批。

### T2（design）確定性可逆 token ＋ OS keychain 金鑰

**動機**：消滅孤兒 token／session epoch／resume 死鎖三類問題；同時刪掉 mapping 容量、eviction、per-session 隔離等複雜度（`PseudonymLimits` 大部分、epoch 機制）。attribution 對 mapping 的依賴消失，但 sessionID 對 audit／notice 仍需要——勿期望整刪 attribution 機制。（2026-10-06 補充：孤兒／死鎖兩類已由 P1 政策回收，T2 剩餘價值＝resume 完整還原＋內部複雜度刪減；三家均無此機制，觸發條件見 P3。）

**方向**

- token ＝確定性可逆轉換（deterministic AEAD 如 AES-SIV，或 FPE），`[SGP1:<payload>]` 承載密文；還原＝金鑰解密，免 mapping。
- 金鑰存 OS keychain（Keychain／DPAPI／libsecret），明令不得落地明文檔；keychain 不可用時的行為需定義（建議：降級為單向遮罩，不 fail-closed）。
- 同一原文在任何 session／重啟後得到同一 token。

**影響（需 spec 同意）**

- 作廢 US7 per-session 隔離、US8 記憶體-only；接受「key 洩漏＝全歷史可反查」為中心風險；確定性 token 意味同一原文跨 session 同 token——provider 側可關聯同一秘密（US7 隔離的妥協，須文件化）；舊 token 由 T1 的 best-effort 政策回收。

**未定項**

- token 格式與長度、金鑰輪替與版本前綴、與 block／redact／deidentify 的共用、keychain 授權提示 UX。

**驗收**

- 重啟後／跨 session 直接還原、resume 直接可還原；金鑰缺失路徑降級正確；token 格式升級的相容政策。

### T3（design）SGP2 偵測器惰性 token 格式＋類別標註

**動機**：現行 payload 是偵測器誘餌——32-hex epoch 像 hex 金鑰、計數器數字段中電話規則（隨機 token 命中率 0.24%）、已實證孤兒 marker 被巢狀遮罩破壞。T1 的 payload 豁免是補丁；本票結構性除因。

**方向**

- 版本位升級：`[SGP2:<CATEGORY>:<分段短混合字元>]`（如 `[SGP2:EMAIL:k3f9-m2a8]`）；payload 無長 hex 連續、無長數字連續——任一 detector 皆不可命中。
- 類別標註對齊主流 surrogate 慣例（Google DLP infoType surrogate、OV category marker）：模型知道替代物類型（回應更自然）、降級通知可描述「已隱藏一個 email」；類別僅 metadata，洩漏給 provider 可接受。
- 舊 SGP1 辨識保留為 **preserve-only**（永不嘗試 restore），零資料遷移——版本位當初就是為此設計。

**驗收**

- 新格式鑄造／restore 往返；detector 惰性測試（新 payload 跑全部規則，命中率＝0）；舊 SGP1 preserve-only 行為；C-matrix 全綠。

## 8. 待決小項（全部已決，2026-10-06 owner）

- 電話偵測 → **opt-in 預設關**（context guard 不做；漏報風險寫入 profile 文件）。
- Overlap 策略 → **最長 span 勝出**（入 T1）。
- 拒絕／降級訊息文案 → 與 T1 一併產出（不變）。
- Revision 標題 → **`2026-10-06b`**。
- 降級紀錄載體 → **不建檔案**：in-band（token 字面值＋工具診斷）＋host log WARN 一行。
- 真實 provider E2E gate → **刪除**（default-flip＝P1＋C-matrix 全綠）。
- 預設規則 FP 稽核 → **納入 P2**。
- Token 格式 → T1 做 payload 豁免；**另開 T3（SGP2）**。
