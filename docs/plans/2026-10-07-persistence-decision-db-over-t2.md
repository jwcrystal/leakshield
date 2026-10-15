# 持久化路線決策：加密 SQLite 映射優先於確定性 AEAD（DB over T2）

日期：2026-10-07
性質：決策紀錄草稿。方向經 owner 於 2026-10-07 對話確認（重啟體驗斷崖＋兩項 T2 顧慮）；隨附 spec revision 草稿於落地時套用並回填核可記錄。本次僅修文件，不代表已實作。
上游文件：
- 決策：`docs/plans/2026-10-06-refusal-policy-simplification-decision.md`（P3/T2 觸發條件制、T3 SGP2、T1 前置）
- Spec：`docs/specs/2026-09-30-agent-transparent-pseudonymization.md`
- 研究：`docs/evidence/2026-10-05-provider-transport-reference-research.md`（三家參考之金鑰/重啟行為）
- 比較基準：EightDoor/opencode-rehydra-sdk（V2 repo，2026-10-07 檢視：`KeyProvider` 抽象＋`InMemoryKeyProvider` 範例＋`SQLitePIIStorageProvider` 為 SDK 端選配；plugin 路徑無證據顯示預設跨重啟還原）

---

## 1. 背景與觸發

1. **T2 觸發條件成立**。Spec item 3 明訂 T2（確定性可逆 token ＋ OS keychain）「Implementation is triggered only if resumed sessions showing literal placeholders become a real-world annoyance」。2026-10-07 owner dogfooding 回報：重啟後舊 token 孤兒化的體驗斷崖（副作用工具拒絕、唯讀工具降級、模型看到字面 `[SGP1:…]`），「原本想說重啟可以重新遮罩，但測試下來感覺差很多」。觸發條件由 owner 本人確認成立。
2. **與 rehydra V2 比較後浮現 T2 的兩個未解顧慮**（owner 於同日對話提出）：
   - 確定性 token 意味同一原文在任何 session／重啟後得到同一 token —— provider 側可跨 session 關聯同一秘密（US7 隔離的妥協）。
   - key 洩漏＝全歷史可反查：密文 token 散布於所有 transcript（`opencode.db`、筆記、log、貼上的對話），key 一旦洩漏全部可解，與時間無關、無法回收。
3. **加密 SQLite 映射儲存同時滿足**重啟存活與消除上述兩項顧慮，並額外提供有界保留（TTL／forget）。

## 2. 決策

1. **T2 不採用為目標方向**；保留為已評估並否決的選項，本文件即否決理由的正式記錄。T2 原文中的遺產條款續行：不得把 SGP1／SGP2 重新解讀為密文；金鑰不可用時降級單向遮罩、不 fail-closed 的設計由本路線繼承。
2. **改採：opt-in 加密 SQLite 映射持久化**。未啟用 `persistence` 時行為與現況完全一致（memory-only，零行為差）。啟用後：
   - US7（per-session 隔離）**保留不變** —— 持久化的仍是 session 隔離的映射與 epoch；
   - US8（process-memory-only）與 US9 的單一 process 框架、以及 Out of Scope 的「持久反向映射」條目，改寫為「加密持久、雙秘密保管、有界保留」語意；
   - 保護邊界從「process 生死」改為「key（OS keychain）＋ DB 檔（加密）雙秘密，且受 TTL／forget 約束」。
3. **T3（SGP2 型別化 token）照 2026-10-06 決策執行**（bracket 格式 `[SGP2:<CATEGORY>:<payload>]`），且**先於**持久化落地 —— 持久化儲存的應是最終 token 格式，避免 SGP1 大量入庫後再遷移。
4. 跨 session 穩定 ID（同一原文跨 session 同 token，等價 rehydra `existingPiiMap` 的 HMAC 衍生做法）**首版不做**，僅保留實作接口；若未來提供，必為 opt-in，不得成為預設。

## 3. 理由對照

| 面向 | 現況 memory-only | T2 確定性 AEAD | **加密 SQLite 映射（採）** |
|---|---|---|---|
| session 內還原 | ✅ | ✅ | ✅ |
| 重啟後還原 | ❌ 失憶，孤兒走 P1 降級 | ✅ 結構性（免映射） | ✅ 載回映射 |
| 跨 session 同 token（provider 可關聯） | —（無跨 session 存活） | ❌ 必然 | ✅ 避免；US7 隔離保留 |
| key 洩漏波及面 | —（無 key） | ❌ 全歷史、永久、不可回收 | ✅ 雙秘密：需 key＋DB 檔同時到手；TTL／forget 之外無暴露 |
| 有界保留／可遺忘 | ✅（process 死即忘） | ❌（密文永久有效） | ✅ TTL＋`forget`；已刪映射之 token 永久不可逆 |
| 新增複雜度 | — | 刪映射/預算/epoch（淨簡化） | 增儲存層、併發、TTL、金鑰管理 |
| 基礎設施 | 零 | 零 | SQLite 檔＋keychain |
| API 同步性 | sync | sync | sync（`node:sqlite`／`bun:sqlite` 同步 driver，服務介面簽名不變） |
| 跨 session 穩定 ID 選項 | — | 強制全局確定性 | 可選（本版不做，留接口） |

核心判斷：T2 用「永久可還原」換零基礎設施；對隱私防護工具，**有界保留是 feature**（被遺忘的權利），且雙秘密比單秘密更抗單點洩漏。基礎設施代價可由 opt-in 隔離：不開持久化的使用者完全不負擔。

## 4. 設計約束（落地時約束，W2 驗收依據）

1. **核心模組純度不變**：`src/decision/pseudonymization.ts` 維持純記憶體引擎（無 fs／db import）；持久化接在 adapter 層，核心僅新增「session 水合」接口（載入既有 session：驗證 epoch、重建正反向映射、計入預算）。
2. **加密**：per-entry AES-GCM（`node:crypto`），金鑰存 OS keychain（Keychain／DPAPI／libsecret）；**明文映射檔禁止**。key 與 DB 檔分開存放（雙秘密）。
3. **備份擴散文件化**：Time Machine／雲盤會備份 DB 檔，`forget` 無法回收備份 —— 寫入 README 風險章節與 doctor 說明。
4. **dispose 語意重定義**：guard `dispose()` 不再等同遺忘（僅卸載 hooks／in-memory 狀態）；遺忘＝TTL 到期或顯式 `forget`。
5. **預算改制**：`PseudonymLimits` 上限語意改為同時約束 in-memory 與 DB 列數／總大小；溢出行為維持 fail（不得靜默丟映射）。
6. **失敗模式**：
   - DB 損毀／不可用 → 該 process 降級 memory-only ＋ doctor WARN，不得 fail-closed 對話；
   - keychain 不可用／拒絕授權 → 降級單向遮罩（繼承 T2 原設計），不得 fail-closed；
   - 解密失敗的個別列 → 視同無映射，依 P1 政策降級，不影響其他列。
7. **併發**：WAL mode；CLI 與 plugin 跨 process 並行讀寫不得損毀；寫入以 transaction 為單位（對齊核心既有 all-or-nothing 語意）。
8. **Driver**：Node ≥ 22 用 `node:sqlite`（stable），Bun compile 產物用 `bun:sqlite`；薄封裝雙 driver，避免 native module（better-sqlite3）進 Bun binary。
9. **零行為差**：`persistence` 未啟用時，所有現有測試不修改即通過；啟用/未啟用各跑全套 C-matrix。

## 5. 明確不做

- 不把 SGP1／SGP2 重新解讀為密文（T2 遺產條款保留）。
- 不做跨機同步、雲端備份、映射匯出。
- 不在核心模組內引入 fs／db。
- 不做明文 DB 選項（「方便性明文模式」不提供；要方便就關 persistence）。
- 首版不做跨 session 穩定 ID（留接口，見決策 4）。

## 6. Spec revision（English；已套用於 2026-10-07，owner 核可經對話確認）

```
### 2026-10-07 (draft — apply with W2 landing; owner sign-off recorded in
### docs/plans/2026-10-07-persistence-decision-db-over-t2.md)

1. **Persistent encrypted mapping store replaces the deterministic-AEAD
   direction (item 3 of 2026-10-06b); trigger confirmed, direction changed.**
   The real-world annoyance trigger for resumed sessions showing literal
   placeholders was confirmed by the owner on 2026-10-07. Instead of
   deterministic reversible tokens, cross-restart restoration is provided by
   an opt-in encrypted SQLite mapping store: per-session isolation (US7) is
   retained and persisted; restoration remains a mapping lookup, never a
   reinterpretation of SGP1/SGP2 tokens as ciphertext. When enabled, US8
   (process-memory-only) and the single-process framing of US9 are replaced
   by dual-secret custody — the mapping file is encrypted per entry with a
   key held in the OS keychain, and both secrets together are required to
   re-identify; bounded retention (TTL plus explicit forget) replaces
   process death as the lifetime boundary. Key disclosure alone or DB file
   disclosure alone exposes nothing retained; backups of the DB file are a
   documented residual risk that forget cannot reclaim. When the store or
   keychain is unavailable the guard degrades per-process to memory-only
   operation (store) or one-way masking (keychain) — never fail-closed.
   Deterministic same-original-same-token behavior across sessions is
   explicitly rejected as a default; a cross-session stable-ID option is
   deferred and, if ever built, must be opt-in. With persistence disabled
   (the default), every existing requirement, guarantee, and test outcome is
   unchanged.
```

## 7. 票的草稿

### W1（P1 執行）SGP2 型別化 token（2026-10-06 T3 之具體化）

**動機**：沿用 T3 —— 現行 payload 是偵測器誘餌（32-hex epoch 像 hex 金鑰、計數器數字段觸發數字類規則、孤兒 marker 巢狀遮罩破壞）；類別標註對齊主流 surrogate 慣例（模型知道替代物類型、降級通知可描述「已隱藏一個 email」）。T1 前置已落地（聯集遮罩 P1、stray token 僅降級）。

**內容**
- `TOKEN_SHAPE` v2：`[SGP2:<CATEGORY>:<payload>]`；payload 分段短混合字元（避免長 hex／連續數字）；CATEGORY 取 scanner `FindingType` 的穩定子集（枚舉封閉，未知類別 fail）。
- 鑄造切至 SGP2；SGP1 辨識與 restore 保留：本 session 有有效 mapping 即精確還原，無 mapping 依 P1 政策（preserve／整段遮罩／工具安全拒絕）。混合歷史（SGP1＋SGP2 同請求）辨識正確。
- Shell-safety 字元集：payload 字元必須落在現行 shell-safe 字面參數白名單內（新增字元先驗證 `isShellSafeOriginal` 與 forbidden-word 集合）。
- 順手硬化：稽核 `TOKEN_SHAPE`（sticky）與共用規則 pattern（`/g`）的 `lastIndex` 重置 —— 2026-10-07 全套跑曾出現一次 `field-aware exemption` flake（單測／整檔／重跑全綠），無法重現，不阻擋 W1，但 W1 觸及同區域，補上重置審計與測試。

**驗收**（對齊 2026-10-06 T3 驗收，不重述全部）
- 新格式鑄造／restore 精確往返；不同原文可區分。
- 固定 token 語料（含類別）對版本化內建／預設規則跑命中率，記錄相對 SGP1 改善；不宣稱抽樣零命中＝普遍免疫。
- 自訂規則／known-value 碰撞、marker 包裹 synthetic secret 用例遮罩與還原安全。
- SGP1／SGP2 混合歷史：有效 mapping 還原、無 mapping 安全降級。
- C-matrix 全綠（證據條件同 P4）。

### W2（P2 設計＋執行）opt-in 加密 SQLite 映射持久化

**內容**
1. 設計 spike：schema（sessions: id/epoch/created/last_used/expires；mappings: session/token/encrypted_original）、加密格式（per-entry AES-GCM，AAD 綁 sessionID＋token 防列搬移）、雙 driver 封裝（`node:sqlite`／`bun:sqlite`）、DB 檔位置與權限。
2. Key provider：keychain 整合（macOS Keychain / Windows DPAPI / Linux libsecret），不可用時降級路徑與 doctor 呈現。
3. 核心水合接口：seed session（驗證 epoch、重建映射、計預算）—— 核心模組不得引入 fs/db。
4. Guard 生命週期：首次觸及 session 惰性載入；commit 後 write-through 持久化；`dispose()` 語意變更（見約束 4）。
5. `forget` 指令（CLI／doctor）＋ TTL 清掃。
6. Plugin options：`persistence: { enabled, path?, ttlDays? }`；doctor 報告 OFF／OK／DEGRARED（原因）。
7. 文件：README 風險章（備份擴散、雙秘密、TTL 語意）、CONTEXT.md 詞彙（Pseudonymize 條目更新「尚未實作持久化」字樣移除時點）。

**驗收**
- 重啟模擬：process A protect → 重啟 → process B 對同 session restore 精確往返；舊 token 於工具側可還原（副作用工具不再因孤兒拒絕）。
- `forget`／TTL 後：同 token 依 P1 政策安全降級（唯讀降級、副作用拒絕、模型側 preserve）。
- 雙秘密驗證：僅 key 洩漏或僅 DB 檔洩漏均不可還原（自動化測試模擬）。
- 併發：CLI＋plugin 同時開（WAL）不損毀；寫入中斷不留半交易。
- DB 損毀／keychain 拒絕 → 降級路徑如約束 6，doctor 可見。
- `persistence` 未啟用：全套既有測試零修改通過；啟用／未啟用各跑 C-matrix 全綠。
- Spec revision `2026-10-07` 套用並回填核可。

## 8. 待決小項（全部已決，2026-10-07 owner）

- TTL 預設 → **7 天**（`ttlDays` 可調；0＝不過期僅手動 forget）。
- DB 檔位置 → **全域 `~/.local/share/sensitive-guard/SGP.db`**（跨專案共用 session 命名空間對齊 OpenCode sessionID 全域性；檔名 `SGP.db` 對齊專案 token 命名空間，owner 指定 2026-10-07）。
- keychain 授權提示頻率：macOS 每次新增 item 會提示；以單一 service item＋ACL 降低摩擦，或提供 0600 keyfile 降級選項（文件標明較弱，預設不建議）。
- 跨 session 穩定 ID → 維持「首版不做」（決策 4）。
- Phase A（W1）動工：owner 核可 2026-10-07。

## 9. W1 落地紀錄（2026-10-07，agent 執行、owner 核可動工）

- **已落地**：SGP2 型別化 token（Phase A 全部）——雙版本 `scanOwnedTokenSpans`/`restoreStringTx`/`splitRestorable`/`TOKEN_SCAN`、類別取自 `FindingType`（聯集遮蔽時取最高嚴重度）、payload 純小寫字母 4-4-4（≈56.6 bits）、`containsTokenPrefix` 匯出供 adapter 使用。741/741 測試通過（含 9 個新 W1 驗收測試：類別正確性、混合版本歷史、payload 性質、lastIndex 衛生、FP 語料）。
- **格式偏離**：類別與 payload 分隔符由示意 `:` 改為 `-`——冒號會使 `[SGP2:SECRET:xxxxxxxx]` 自撞 built-in `generic-secret`（keyword+`:`+≥8 值）。量測與理由見 `docs/evidence/2026-10-07-sgp2-fp-corpus.md`。
- **量測結果**：SGP2 0/1020（0.000%）vs SGP1 基準 3/1020（0.294%，全為 `phone-tw`）。附帶發現：P2「電話規則 opt-in 預設關」**尚未實作**（量測顯示預設 profile 下 `phone-tw` 仍作用），P2 另行追蹤。
- **已知殘餘**：類別字樣仍可能命中使用者 NDA 關鍵字／自訂規則（如關鍵字設 "NDA" 會命中 `NDA_KEYWORD` 類別）——決策第 5 節既文件化，不承諾免疫。
- `stageToken` 的 epoch/counter 機制保留（session 簿記與未來 W2 水合相容），新鑄造不再使用計數器。

## 10. B2 前置查證：金鑰保管生態現況（2026-10-07，owner 提問觸發）

### 10.1 四家參考與主流現況

| 專案 | OS keychain | 實況 |
|---|---|---|
| VibeGuard | ❌ | 無持久金鑰（研究 doc L78） |
| Rehydra 舊版 | ❌ | in-memory map 跨重啟拋錯（研究 doc L94-95） |
| opencode-vibeguard | ❌ | per-session 隨機 secret＋TTL（研究 doc L118） |
| EightDoor/rehydra V2 | ❌ | `src/crypto/pii-map-crypto.ts` 僅 `generateKey`（隨機）＋`deriveKey`（PBKDF2 密碼衍生）；唯一隨附 provider 是 `InMemoryKeyProvider`；storage 有 SQLite/IndexedDB/in-memory，**key 存放留給呼叫者**。實務陷阱：InMemory key＋SQLite store → 重啟後 key 消失，映射永久解不開（repo tree 269 檔，`keychain/dpapi/libsecret/kms` 零命中） |
| Google Cloud DLP | ➖（非 keychain） | 確定性金鑰（AES-SIV/FF1＋surrogate），custody 在 **Cloud KMS** |
| Microsoft Presidio | ➖ | 可逆 operator 用**自帶金鑰**，無內建 OS provider |
| Copilot 類 | ❌ | 單向過濾，無可逆 custody |

結論：**keychain 是本地版的主流金鑰託管哲學**（custody＝保護邊界），四家參考皆未做——B2 落地即超越全部參考；不採 PBKDF2 密碼路線（每次啟動輸入違反無感體驗，rehydra 留它正因沒做 keychain）。

### 10.2 keychain provider 的差異（設計理由記錄）

- **key 存放位置決定「誰能解密」**：加密只決定偷檔者看到密文；keychain 讓 key 不落在任何可被備份／偷走的檔案裡——「磁碟／備份被偷」與「資料可解」脫鉤，此即 §4 雙秘密的實現載體。
- 情境對比：重啟（keychain ✅／in-memory ❌ DB 變磚／PBKDF2 ✅ 但每次輸密碼）；偷 DB 單檔（keychain ✅ 密文／keyfile ⚠️ 同目錄被拿即全解）；偷備份（keychain ✅ item 受登入密碼保護離機不可用／keyfile ❌ 通常一起備份）。
- **威脅模型邊界（誠實揭露，README 一致）**：keychain 防**離線竊取**（偷磁碟、偷備份、偷 DB 檔）；不防已在使用者登入 session 內執行的惡意程式（macOS 授權提示可被社工；DPAPI/libsecret 同 user 可解）。此為 OS 級保護共同邊界。


## 11. R 輪落地紀錄（2026-10-07 外審修正）

外審（gpt-6.1-sol，對抗性唯讀審查）判定阻塞後全數修正，細節見執行計畫「R 輪」表。對本決策文件的實質修訂：

1. **金鑰連續性（§4 修正）**：store 以 meta 記 `key_id`＝sha256(key) 前 16 hex（256-bit 隨機金鑰的摘要不構成離線爆破預言子）。金鑰來源漂移（keychain↔keyfile）從「靜默換 key」改為「立即拒開＋memory-only 降級」；`forget --all` 重置。首建競態以 write→read-back 收斂（keychain）與 `wx` exclusive create（keyfile）收斂；殘餘視窗明示。
2. **寫入並發（§4 新增）**：WAL 僅序列化、不防丟失更新。per-session version CAS（seed 時捕獲、寫入必帶 expectedVersion；row 消失且 expected>1 視為衝突）＋forget epoch tombstone（forgetAll 後舊 handle 一律拒寫，防復活）。忘記語意：外部 forget 時活 process 停用持久化但保留 in-memory 映射至重啟（RAM 殘留明示）。
3. **擦除語意（§4 修訂）**：forget 定調為「邏輯擦除＋檔內盡力」——`secure_delete=ON` 清零釋放頁、forgetAll 後 VACUUM＋WAL truncate；實體媒體與備份殘留明示不在範圍（原「不可逆」宣稱撤回）。
4. **有界保留補全（§4.5）**：TTL 之外新增 maxSessions 256／maxEntries 50k（owner 拍板），寫入交易內 LRU 逐出最舊 last-touched session。
5. **零行為差強化**：`node:sqlite` 改惰性載入（createRequire）——無 driver 的 runtime 上 persistence-off 使用者完全不受影響；載入失敗侷限於 open 呼叫並软為降級。
6. **Linux 可用性**：`secret-tool lookup` rc=1＝不存在（非不可用）——修正前 Linux 首次永遠建不了 key。
7. **核心攝入強化**：SGP2 category 閉枚舉驗證（FINDING_TYPES）、seed 尺寸上限前移（防 hand-edited store 耗盡記憶體）、聯集包含時 severity 一律比較。

測試 770→790 全綠；guard 整合測試全數注入 key（不碰真 keychain）。


### §11.1 R2 修訂（第二輪外審後）

§11 的並發與金鑰設計在 R2 複審後強化為最終形：

1. **version 血統（lineage）**：session row 的 version 不再因刪除歸零——`session_tombstones` 記住每個 session 的最後 version（forget／TTL 掃除／LRU 逐出皆寫入），重建續號。CAS 因而對 delete→recreate 免疫（無 ABA）。
2. **absent sentinel**：expectedVersion=0 專門表示「寫入者最後所見為無 row」；row 存在＋0→衝突，row 消失＋非 0→衝突。兩個首次 writer 不再能互相盲寫。
3. **初始化單交易**：DDL、v1/v2→v3 升級、meta bootstrap、key 釘入全在 `BEGIN IMMEDIATE` 內；meta 寫入一律 DO NOTHING——兩個首開 handle 序列化，不可能互相覆蓋身分。
4. **probe／erase 分際**：readOnly handle 不初始化、不釘 key、不掃 TTL、不 touch；`forget --all` 同交易清除 key pin（錯 key 重置路徑成立）。
5. **快照硬上限**：單一快照超過 maxEntries 直接拒寫（逐出他人無法滿足自己超限）。


### §11.2 R3 修訂（第三輪外審後，最終形）

1. **版本＝全域單調計數器**：所有 insert/update 的 version 取自 meta 計數器，永不重用——重建 session 不可能撞回舊 version（tombstone 之外的第二道 ABA 保險），也讓 tombstone 修剪安全。
2. **absent-look 攜帶 generation**：expectedVersion 編碼 -g-1；insert 要求該 session 的 tombstone generation 自查看後未變。跨刪除邊界（create→forget、TTL 掃除、LRU 逐出）的舊 absent-writer 一律拒絕。
3. **基礎保證入測**：WAL、secure_delete、busy_timeout 為每-handle 開檔設定，並由直接斷言的測試釘住（防「重寫時無聲消失」再犯）。
4. **有界性補全**：tombstones 上限 max(1000, 2×maxSessions) 修剪；guard 四組 per-session 狀態（seedAttempts/persistVersions/persistedEntries/noPersist）上限 1024 且只逐出非 live session。
5. **keychain 空值＝損毀**：present-but-empty 與 malformed 同等拒絕；非空 legacy store 升級前先驗 AEAD 再釘 key。
