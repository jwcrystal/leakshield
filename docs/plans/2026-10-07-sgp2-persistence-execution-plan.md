# SGP2 型別化 Token ＋ 映射持久化執行計畫（SGP2 & Persistence Execution Plan）

日期：2026-10-07
性質：執行計畫。對應決策：`docs/plans/2026-10-07-persistence-decision-db-over-t2.md`（W1/W2 票的具體執行版本）；上游決策 `docs/plans/2026-10-06-refusal-policy-simplification-decision.md`（T3 設計、T1 前置、P1 政策）。
上游 Spec：`docs/specs/2026-09-30-agent-transparent-pseudonymization.md`（2026-10-07 revision 草稿隨 W2 落地套用）。

## 目標

1. **W1**：token 升級為 `[SGP2:<CATEGORY>:<payload>]` —— 類別可見（模型知道替代物類型）、payload 低誤報（不再偽裝成 hex 金鑰／數字欄）。SGP1 舊 token 相容（有效 mapping 精確還原，無 mapping 走 P1 降級）。
2. **W2**：`persistence` opt-in —— 加密 SQLite 映射持久化，重啟後同 session 可還原；US7 隔離保留；雙秘密（keychain key ＋ 加密 DB 檔）＋ 有界保留（TTL／forget）。

## 非目標

- 跨 session 穩定 ID（留接口，首版不做）。
- 跨機同步、雲端備份、映射匯出。
- 確定性 AEAD token（已否決，見決策文件）。
- NER / 語義屬性（gender/scope）—— 無 NER 前提下不可得。
- 未啟用 `persistence` 時的任何行為變更。

## 現狀基線（2026-10-07 已驗證）

- 732/732 測試通過（含 transparent 三協議 restore、串流切半 token 還原、工具還原與降級）。同日全套跑曾出現一次 `field-aware exemption` flake（單測／整檔／重跑皆綠，無法重現）—— W1 順手審計 `lastIndex`，不另立票。
- T1 已落地：聯集遮罩（`pseudonymization.ts` P1 2026-10-06b）、stray token 僅降級（`strayTokenIn` → `warnDegradation`）。
- Token 文法集中：`PSEUDONYM_TOKEN_PREFIX`（`pseudonymization.ts:142`）、`TOKEN_SHAPE`（`:144`）、`scanOwnedTokenSpans` 唯一掃描函式（6 個呼叫點）。
- 核心模組為純記憶體引擎（模組頭明載 persistence 由 adapter 層接）。
- 服務介面全同步；`node:sqlite`（Node ≥22 stable，本機 Node 26）與 `bun:sqlite`（Bun compile 產物）皆同步，介面簽名可維持。

## Phase A（W1）：SGP2 型別化 token

### A1. 格式與類別枚舉
- 定義 `SGP2` shape：`[SGP2:<CATEGORY>:<payload>]`；CATEGORY 封閉枚舉（`FindingType` 穩定子集：EMAIL／PHONE／ID／CARD／IBAN／IP／URL／API_KEY／SECRET／TOKEN／DB_CONNECTION／NDA…，以 `types.ts` 實際型別為準），未知類別 fail（沿用嚴格驗證語意）。
- Payload 產生器：分段短混合字元（如 `k3f9-m2a8` 三段），字元集落在現行 shell-safe 字面參數白名單內；避免 ≥8 連續數字、≥16 連續 hex。產生器需通過「固定語料零內建規則命中」量測（見 A4）。
- `scanOwnedTokenSpans` 支援雙版本辨識（SGP1＋SGP2 同字串混合）。

### A2. 鑄造與還原切換
- 新鑄造走 SGP2（带類別）；restore 路徑：SGP1 token 查既有 mapping（不失效）、SGP2 token 查新 mapping；兩者無 mapping 皆依 P1 政策（模型側 preserve／整段遮罩、工具側唯讀降級／副作用拒絕）。
- 對外行為不變的錨點：`PSEUDONYM_TOKEN_PREFIX` 常數保留（"[SGP1:"），新增 `PSEUDONYM_TOKEN_PREFIX_V2` 與版本判定 helper；所有錯誤 reason 枚舉不變。

### A3. 相容與安全
- Shell-safety：`restoreLeaf` 對 SGP2 payload 的前導/禁用字元規則重驗（`opencode-transparent.ts:93/173` 兩個字元集合）；含 `<>"=` 之任何形式明確不在格式內（決策記錄：不走 XML）。
- `lastIndex` 稽核：`TOKEN_SHAPE`（sticky `/y`）與共用規則 pattern（`/g`）在所有提早返回路徑重置；補回歸測試（同一 regex 連續兩次掃描結果一致）。

### A4. 驗收（DoD）
- 鑄造／restore 往返精確；不同原文可區分；同原文同 session 穩定。
- 固定語料（≥1000 token 樣本，含類別）對版本化內建規則量測命中率，書面記錄相對 SGP1 改善（`docs/evidence/`）。
- 自訂規則／known-value 碰撞、marker 包裹 synthetic secret、SGP1+SGP2 混合歷史（有效/無效 mapping 交錯）用例全綠。
- C-matrix 全綠；未修改之既有測試全數通過。

## Phase B（W2）：opt-in 加密 SQLite 映射持久化

> 相依：Phase A 完成（DB 儲存最終 token 格式，避免 SGP1 大量入庫後遷移）。
> **進度（2026-10-07 第三輪，W2 全數完成）**：B1–B6 已落地（各節 ✅）。B5：`src/forget.ts`（`--forget --all/--session`，content-free 輸出）＋cli 接線＋doctor `persistence` 檢查（OFF/OK/DEGRADED，`persistenceCheck` 匯出可測）。B6：README 中英持久化＋風險章（備份擴散、雙秘密、TTL、keyfile 弱點）、CONTEXT.md 假名化詞彙更新、spec `2026-10-07` revision 套用。前輪：B1–B4 已落地（各節 ✅）。`src/decision/mapping-key.ts`（三平台 keychain probe＋keyfile＋降級階梯）、guard 接線（惰性水合／write-behind／dispose 語意／corrupt 降級）、plugin option `persistence`（opt-in，預設記憶體）。新增 12 測試（`tests/mapping-key.test.ts`＋`tests/transparent-persistence.test.ts`，含**重啟還原走完整 guard hooks**）。全套 761/761、tsc/build 乾淨、未啟用者零行為差。B5（forget CLI＋doctor）、B6（完整驗收＋spec revision 套用）未做。

### B1. 設計 spike（先決）✅ 2026-10-07
- ✅ Schema：`sessions(session_id PK, epoch, created_at, last_used_at, expires_at)`；`mappings(session_id, token, enc_value BLOB, PK(session_id, token)) WITHOUT ROWID`（`src/decision/mapping-store.ts`，schema v1 + migrations 版本表）。
- ✅ 加密：per-entry AES-256-GCM（`node:crypto`），AAD＝`session_id || token`（防列搬移）；金鑰由 key provider 供應，DB 檔內零金鑰材料、零明文原文（測試驗證磁碟位元組無原文）。
- ✅ Driver：`node:sqlite`（Node ≥22／Bun 皆支援；`src/types/node-sqlite.d.ts` 補 @types/node 20 缺的型別）；WAL；寫入單交易（replace 語意）。
- ✅ TTL：開檔被動清掃（無背景執行緒）；`ttlDays 0`＝永不過期。
- 檔案位置與權限：接線時（B4）套用決策 §8——全域 `~/.local/share/sensitive-guard/SGP.db`、0700 目錄。

### B2. Key provider ✅ 2026-10-07
- ✅ `src/decision/mapping-key.ts`：macOS Keychain（`security`）／Linux libsecret（`secret-tool`）／Windows DPAPI（ProtectedData, CurrentUser）probe；0600 keyfile（opt-in）；`resolveMappingKey` 階梯（keychain → keyfile → null 記憶體降級，每步 content-free WARN）。降級階梯細節見決策文件 §10。測試以 fake probe 注入，不碰真 keychain。
- macOS Keychain／Windows DPAPI／Linux libsecret；單一 service item（降低授權提示頻率）。
- 不可用路徑：降級單向遮罩（不 fail-closed）＋ doctor WARN；可選 0600 keyfile 降級模式（文件標明較弱，預設不建議）。

### B3. 核心水合接口 ✅ 2026-10-07
- ✅ `PseudonymizerService.seedSession(sessionId, { epoch, entries })`：all-or-nothing（任何失敗 registry 不動）、雙版本 token 形狀嚴格驗證（SGP1 舊映射可水合還原）、`token_collision`/`key_collision` 衝突拒絕、預算全檢（session/entry/capacity/aggregate）、epoch 唯一性。核心模組維持零 fs/db import——介面只收資料，不做 I/O。

### B4. Adapter 與生命週期 ✅ 2026-10-07
- ✅ 核心 `hasSession`/`exportSession`（唯讀快照）；guard 於四個 hook handler 首觸 session 惰性 `ensureSeeded`、protect 成功後 `persistIfChanged`（無變更跳過寫入）；`dispose()` 關閉 store handle 但**不刪持久映射**（決策 §4.4）；store 損毀→該 process 記憶體降級＋WARN；plugin option `persistence: { enabled, ttlDays(7), path?, keyFile(false), keyfilePath? }`，refine 限 transparent 模式；預設路徑 `~/.local/share/sensitive-guard/SGP.db`（決策 §8）。
- 新模組 `src/decision/mapping-store.ts`（暫名）：讀寫 DB、加解密、TTL 清掃；guard 於首次觸及 session 時惰性載入、核心 commit 後 write-through。
- `dispose()` 語意變更：僅卸載 hooks 與 in-memory 狀態；持久映射存活至 TTL／forget（決策約束 4，測試需覆蓋「dispose 後重進同 session 仍可還原」）。

### B5. 忘卻與觀測 ✅ 2026-10-07
- ✅ `sensitive-guard --forget [--all|--session <id>] [--path <store>]`：刪除不需要解密（拋棄式金鑰開檔），輸出僅計數；缺 store＝no-op 成功；損毀＝exit 1＋指引。金鑰保留（不含資料）。測試：`tests/forget.test.ts`（4 forget＋5 doctor 檢查）。
- ✅ doctor `persistence` 檢查：OFF（skip）／OK（store 路徑＋session 數＋TTL＋key 源）／DEGRADED（corrupt→warn＋forget fix）；不改變整體 status（降級不減弱防護）。TTL 被動清掃已隨 B1 落地。
- `forget`：CLI 指令（`--all`／`--session <id>`）＋ doctor 整合；輸出僅計數，不含內容。
- TTL 清掃：開啟 DB 時被動清掃（不另起背景執行緒）。
- doctor／plugin options：`persistence: { enabled, path?, ttlDays? }`；狀態 OFF／OK／DEGRADED(原因：db_corrupt／keychain_denied／driver_missing)。

### B6. 驗收（DoD）✅ 2026-10-07
- ✅ 重啟模擬往返：`tests/transparent-persistence.test.ts` 走完整 guard hooks（guard A protect→dispose→guard B 副作用工具直接還原真值）；forget/TTL 後 P1 降級由 `tests/mapping-store.test.ts`＋memory-only 對照測試覆蓋。
- ✅ 雙秘密：錯誤金鑰→空 session（B1 測試）；磁碟位元組零明文（B1 測試）。
- ✅ 併發（R 輪補強）：WAL 僅提供序列化，不防丟失更新——現以 per-session version CAS＋forget epoch tombstone＋absent-row CAS 防護（見 R 輪），測試釘住 stale-writer 拒寫與 forget 復活阻擋。
- ✅ DB 損毀／keychain 拒絕→降級不擋對話＋doctor 可見（B4/B5 測試）。
- ✅ 零行為差：未啟用 persistence 的路徑行為不變；W2 相關測試全綠（761→770；W1/P2 曾修改部分既有測試，故不宣稱「零修改」，僅宣稱行為等價——R 輪外審指正）。
- ✅ 文件：README 中英（持久化選項＋風險章）、CONTEXT.md、spec revision `2026-10-07` 套用回填。
- 開放項：真實 keychain（macOS Keychain）端到端與 Linux secret-tool／Windows DPAPI 平台煙霧測試未自動化——需要各平台環境，留 doctor 實務回報。
- 重啟模擬往返：process A protect → 新 process B seed＋restore 精確；工具側副作用呼叫因 mapping 存在不再拒絕。
- forget／TTL 後：同 token 走 P1 降級（唯讀降級、副作用拒絕、模型側 preserve）—— 直接重用 T1 測試資產。
- 雙秘密：僅 key 或僅 DB 檔皆不可還原（自動化模擬）。
- 併發：CLI＋plugin 同時開不損毀；寫入中斷（模擬 kill）不留半交易。
- 降級：DB 損毀／keychain 拒絕 → 對話不 fail-closed，doctor 可見。
- 零行為差：`persistence` 未啟用，全套既有測試零修改通過；啟用／未啟用各跑 C-matrix 全綠。
- 文件：README 風險章（備份擴散、雙秘密、TTL 語意、keyfile 降級模式之弱點）、spec revision `2026-10-07` 套用回填、CONTEXT.md 詞彙更新。

## 執行順序與依賴

```
A1 → A2 → A3 → A4（W1 完成）
                ↓
        B1（spike，可與 A4 並行啟動文件工作）
        B1 → B2 → B3 → B4 → B5 → B6
```

- A 與 B1 spike 無程式相依，可並行。
- B3（核心接口）不依賴 B1/B2 完成，可先以 in-memory fake store 開發測試。

## 主要風險

| 風險 | 緩解 |
|---|---|
| SGP2 payload 字元集與 shell-safety／掃描器互動 | A1 產生器即約束字元集＋A4 語料量測；不明確時縮小字元集 |
| 語料量測被當成「免疫保證」 | 決策文件已明文：抽樣零命中≠普遍免疫；版本化規則+固定語料 reproducible |
| keychain 授權提示摩擦（macOS） | 單一 service item＋ACL；必要時 keyfile 降級選項（明標較弱） |
| 備份擴散（Time Machine） | 無技術解；README 風險章如實揭露，forget 文案說明不可回收備份 |
| 跨 process 寫入競爭 | WAL＋交易寫入＋中斷模擬測試 |
| DB 列數成長 | 預算改制（約束 5）＋ TTL 被動清掃 |
| `dispose` 語意變更破壞既有假設 | B4 明列新語意測試；所有「dispose 清空」斷言改為「dispose 卸載＋持久層不動」雙版本驗證 |
| flaky 測試（field-aware exemption）無法重現 | W1 順手 lastIndex 稽核；若重現以 `--sequence.seed` 保存後另立票 |


---

## R 輪（2026-10-07 外審修正，gpt-6.1-sol 對抗性審查）

整體判定原為「阻塞」；以下 findings 全數處置，測試 770→790。

| # | Finding（severity） | 處置 | 位置 |
|---|---|---|---|
| F5.1 | `node:sqlite` 靜態 import：driver 缺失時 persistence-off 也全掛（HIGH） | ✅ createRequire 惰性載入，失敗侷限於 openMappingStore→降級 | mapping-store.ts |
| F4.1 | loadSession 例外逃出 hook 擋對話（HIGH） | ✅ catch→WARN→該 process 停用 store，memory-only 續走 | opencode-transparent.ts |
| F3.2 | 快照覆寫無版本檢查：lost-update＋forget 復活（HIGH） | ✅ seed 時捕獲 version；putSession(expectedVersion) CAS；row 消失＋expected>1→衝突；forgetAll bump epoch→舊 handle 寫入拒絕 | mapping-store.ts＋guard |
| F2.1 | 金鑰首建競態分叉（HIGH） | ✅ keychain write 後必 read-back 收斂勝者；keyfile `wx` exclusive create，EEXIST 收養勝者（partial-write 重試 100ms） | mapping-key.ts |
| F2.2 | 金鑰身分漂移：keychain↔keyfile 切換換 key（HIGH） | ✅ store meta 釘 sha256(key) 前 16 hex；不符→MappingKeyMismatchError→memory-only，絕不混寫 | mapping-store.ts |
| F2.3 | Linux secret-tool rc=1 誤判不可用；DPAPI 未建父目錄（MEDIUM） | ✅ interpretSecretToolLookup 區分 absent/unavailable；DPAPI 寫前 mkdir 0700 | mapping-key.ts |
| F2.4 | 既有 keyfile 0644 照用（MEDIUM） | ✅ 收養時收緊 0600，失敗即拒（降級） | mapping-key.ts |
| F3.1 | forget 只 DELETE，freelist/WAL 殘留（HIGH） | ✅ `PRAGMA secure_delete=ON` 常開；forgetAll 後 VACUUM＋WAL truncate；語意定調「邏輯擦除＋檔內盡力」，實體媒體／備份殘留明示不在範圍 | mapping-store.ts＋README |
| F3.3 | store 全域無上限（HIGH） | ✅ maxSessions 256／maxEntries 50k（owner 拍板），寫入交易內 LRU 逐出 | mapping-store.ts |
| F3.4 | 初始化失敗洩 handle（MEDIUM） | ✅ 統一 catch→close→rethrow | mapping-store.ts |
| F4.2 | 水合被拒 session 仍可覆寫原快照（HIGH） | ✅ noPersist 集合，拒絕即禁寫 | opencode-transparent.ts |
| F4.3 | tool-only 水合 session 漏 disposal（MEDIUM） | ✅ 水合成功即 track，dispose 一併清除 | opencode-transparent.ts |
| F4.4 | seedAttempts 無界（MEDIUM） | ✅ Map 上限 1024 FIFO 逐出；dispose 清空 | opencode-transparent.ts |
| F4.5 | setup 失敗不關 store（MEDIUM） | ✅ 失敗路徑 close | opencode-transparent.ts |
| F1.1 | 聯集包含不比 severity（MEDIUM） | ✅ 所有重疊一律比較；LOW 包 HIGH 改標 HIGH | pseudonymization.ts |
| F1.2 | 水合不驗 category 白名單（MEDIUM） | ✅ FINDING_TYPES 閉枚舉（types.ts），seed 攝入驗證 | types.ts＋pseudonymization.ts |
| F1.3 | seed 預算後檢可先耗記憶體（MEDIUM） | ✅ session/entry 上限前移＋迴圈內單位上限早退 | pseudonymization.ts |
| F6.1 | 整合測試打真 keychain＋降級斷言軟跳過（MEDIUM） | ✅ guard 注入 keyProvider（同 key 跨重啟）；null 注入可確定性走階梯底；斷言全部無條件 | transparent-persistence.test.ts |
| F6.2 | doctor 拋棄式 key 驗不了 key 健康（MEDIUM） | ✅ readOnly probe（不讀真 key、不 prompt）＋detail 明載「key health not verified」；runtime setup log 為權威訊號 | doctor.ts |
| F6.3 | 執行計畫 ✅ 過度宣稱（MEDIUM） | ✅ 「零修改」→「行為等價」；「WAL 支援並發」→ CAS/epoch 語意；磁碟零明文測試補掃 `-wal`；本節即回填 | 本文件 |

**殘餘風險（明示不修）**：
- keychain 首建仍存 write→read-back 之間的微小分叉視窗（無跨程序原子 create-if-absent；收斂把「必然分叉」縮為「最後寫入者勝＋讀回收斂」）。實務觸發需要兩個 OpenCode 首啟在同一瞬間。
- forget 的實體媒體層殘留（SSD wear-leveling、快照、備份）不在保證範圍——README 風險章明載。
- 真實 macOS Keychain／Linux secret-tool／Windows DPAPI 端到端煙霧測試仍需各平台環境（doctor 實務回報）。


---

## R2 輪（2026-10-07 第二輪外審修正，gpt-6.1-sol @ high）

R1 的 CAS／金鑰釘住只做了半套——R2 複審以重現級證據指出 4 個 HIGH 全是真傷。15 項 findings 全數修畢，測試 790→799。

| # | Finding（severity） | 處置 |
|---|---|---|
| R2-1（HIGH） | absent 與 v1 共用 expectedVersion=1：兩個首次 writer 後寫者覆蓋先寫者 | expectedVersion=0 專職 absent sentinel；row 已存在＋expected 0→衝突 |
| R2-2（HIGH） | 刪除後 version 歸零重用→ABA 復活（forget/TTL/LRU） | `session_tombstones` 表：所有刪除路徑記住最後 version，重建續號；舊 version 永不再命中 |
| R2-3（HIGH） | meta 初始化非交易＋OR REPLACE 可互覆 key_id | DDL／升級／bootstrap／key 釘入放進單一 `BEGIN IMMEDIATE`；meta 一律 `ON CONFLICT DO NOTHING` |
| R2-4（HIGH） | Linux rc=1＋空 stdout 也可能是真錯誤（stderr 有訊息）→誤判 absent→建 key | 分類納入 stderr：僅「rc1＋stdout空＋**stderr空**」為 absent；其餘 throw 降級 |
| R2-5（MEDIUM） | keychain 既有值 hex 不合法被當 absent→覆寫換 key | present-but-malformed→throw 降級（keychain step-down warn），絕不自動換 key |
| R2-6（MEDIUM） | `openSync("wx")` fd 洩漏 | writeFileSync 包 try/finally closeSync |
| R2-7（MEDIUM） | statement prepare 在 init catch 外，失敗漏 handle | prepare 移入同一 cleanup 邊界 |
| R2-8（MEDIUM） | guard 降級兩路徑丟 store 引用不 close | `disableStore()`：先 close（容忍再丟）再清再 warn |
| R2-9（MEDIUM） | FIFO 逐出活 session 的 seedAttempt→重 seed→invalid_session→永久 noPersist | ensureSeeded 先查 `pseudonymizer.hasSession`；CAS 狀態（persistVersions）本就不受逐出影響 |
| R2-10（MEDIUM） | 當前 session 永不逐出自己：單快照超 maxEntries 仍 commit | 快照本身超限→`MappingSnapshotTooLargeError` 直接拒寫（guard 收到→noPersist＋一次 WARN） |
| R2-11（MEDIUM） | v1→v2「migration」加欄後仍拒開 schema_version=1 | 真升級：v1/v2→v3 於 init 交易內完成；v1 形狀 store 升級測試釘住 |
| R2-12（MEDIUM） | readOnly probe 會 bootstrap＋釘拋棄式 key——doctor 先跑即種錯 key | readOnly：零 DDL／零 meta 寫／零掃除／loadSession 不 touch；未初始化檔回零副作用 stub（空檔案 byte-size 不變由測試釘住） |
| R2-13（MEDIUM） | 宣稱 forget --all 可重置 mismatch 但 forgetAll 保留 key_id | forgetAll 同交易清 key pin；下一個 writer 重新釘——錯誤訊息與文件宣稱現為真 |
| R2-14（MEDIUM） | seed 的 unit 上限在 Map hashing 之後（超長 original 先耗記憶體） | seedSession 兩階段：先純驗證＋單位累計（先拒後配），再建 forward/reverse |
| R2-15（MEDIUM） | WAL 測試 catch 吞斷言可假綠 | existsSync 判存在＋斷言移出 catch |

**R1→R2 誠實記事**：R1 宣稱「全數修畢」過早——F3.2（CAS）、F2.2（釘住）、F2.3（Linux）、F3.3（上限）、F3.4（close 衛生）、F1.3（預算順序）六項在 R2 複審被判定修復不實，本輪以重現為準重新落地。教訓已記：修復宣稱必須附帶能失敗的測試（本輪 ABA／absent-sentinel／stub／升級測試皆為可紅設計）。

**殘餘風險（明示）**：不變項同 R1（keychain 首建微小視窗、實體媒體／備份殘留、三平台 keychain 煙霧）。


---

## R3 輪（2026-10-07 第三輪外審修正，gpt-6.1-sol @ high）

第三輪判定 R2 13/15 屬實、2 項不實，另 9 個新 findings（含 R2 全量重寫時**弄丟的 pragmas**——WAL 與 secure_delete 一併消失，屬實打實的回歸）。9+2 全數修畢，測試 799→804。

| # | Finding | 處置 |
|---|---|---|
| R3-F1（HIGH） | `secure_delete` 設定消失（實測 0）——forgetSession 後密文仍可從檔案解回 | 每個 handle（writer 與 erase）開檔即 `PRAGMA secure_delete=ON`；新增密文殘留測試：forget 後原始 blob bytes 不在檔案 |
| R3-F2（HIGH） | absent 狀態仍有 ABA：舊 absent-writer（gen 0）在 create→targeted forget 後照樣重建 | absent look 攜帶 tombstone generation：token 編碼 -g-1；insert 要求 generation 未變。`absentGeneration()` 進 store API，guard 接線 |
| R3-F3（MEDIUM） | `journal_mode=delete`（WAL 也丟了）、`busy_timeout=0`；WAL 測試因 wal 不存在而跳過斷言＝假綠 | writer 設 WAL＋全部 handle `busy_timeout=5000`；WAL 測試改為斷言 `journal_mode=wal` 且 `-wal` 存在且無明文 |
| R3-F4（MEDIUM） | statement prepare 仍在 cleanup 邊界外（schema 缺欄即洩 handle） | prepare＋return 包進 try/catch→close→rethrow |
| R3-F5（MEDIUM） | present-but-EMPTY 的 keychain 值被當 absent→`add -U` 覆寫 | 三平台 probe：rc0＋空值→throw「present but empty」；resolver malformed/empty 一律拒絕降級，絕不覆寫 |
| R3-F6（MEDIUM） | tombstones 無上限（歷史 session ID 永留） | 版本改全域單調計數器（永不重用）＋tombstone 修剪上限 `max(1000, 2×maxSessions)`；修剪只影響 ≥ceiling 個版本之後的理論 absent-look，殘餘有界並記錄 |
| R3-F7（MEDIUM） | guard 的 persistVersions/noPersist 無界（實測 1100–2200） | `evictStaleBookkeeping`：超過 1024 只逐出**非 live** session（live 由 MAX_TRACKED_SESSIONS 有界），live 的 CAS／禁寫狀態永不丟 |
| R3-F8（MEDIUM） | 非空 v1 store＋錯 key：升級成功、釘錯 key、解密全空，正確 key 從此 mismatch | 升級釘 key 前先驗一筆 AEAD：非空舊 store 解不開即拒（回滾降級）；空 store 才信任第一個 opener |
| R3-F9（MEDIUM） | ABA 回歸只守住 forget/session-cap 兩路 | 補 TTL 掃除、entry-cap 逐出兩路的「stale 拒絕＋fresh absent-token 插入」斷言＋F2 的 targeted-forget 版本 |

**R2→R3 誠實記事**：R2 的兩項「修復不實」（F4 prepare 邊界、F5 空值）與 pragma 回歸證明——全量重寫檔案時，未受測試保護的既有保證會無聲消失。教訓（累積第三條）：**基礎保證（WAL、secure_delete）必須有直接斷言的測試，不能只靠「改動時記得」**。本輪起的測試清單：journal_mode、wal 存在性、密文殘留、generation CAS、tombstone 上限，全為可紅設計。
