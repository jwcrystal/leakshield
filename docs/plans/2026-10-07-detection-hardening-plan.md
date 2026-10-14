# 偵測補強計畫（checksum PII ＋ NER opt-in 評估）

日期：2026-10-07
背景：`docs/evidence/2026-10-05-three-way-comparison.md` §6（EightDoor／Rehydra 偵測廣度差距）。
血統註記：EightDoor `opencode-rehydra-sdk@4b892b0` 的 recognizers 為 `rehydra-ai/rehydra-sdk@5d4fb85` 衍生（上游 `src/recognizers/` 25 檔一致），兩者皆 MIT。

## 已完成（2026-10-07 第一輪）

1. **`Rule.validate` 機制**（`src/types.ts`、`src/scanner/engine.ts`）：規則可附語意驗證（regex 框形狀＋驗證碼把關），`scanText` 與 `redactText` 兩條路徑都貫通。
2. **三條 checksum／可路由性 PII builtin**（`src/rules/builtin.ts`）：
   - `PII_CREDIT_CARD`（HIGH）：13–19 位＋空格／連字號，**Luhn 必過**
   - `PII_IBAN`（HIGH）：緊湊／四字一空格，**mod-97 必過**
   - `PII_IP`（MEDIUM）：**僅公共可路由 IPv4**（私有／回環／link-local／CGNAT／保留段排除，避免 config 常數誤報）
3. **測試**：`tests/detection-pii.test.ts`；README Detection Coverage 同步（原「credit card／IP 不涵蓋」documented gap 關閉）。

## 已完成（2026-10-07 第二輪：toggle 機制＋URL opt-in）

4. **`Rule.id`／`Rule.optIn`＋`settings.rule_overrides`**（`src/types.ts`、`src/config/loader.ts`、`src/scanner/engine.ts`）：
   - 每條 builtin 有 stable id（tests 強制，未來規則不得漏）；`BUILTIN_RULE_IDS` 匯出
   - `rule_overrides` 明示覆寫優先；無覆寫時 opt-in 規則關、其餘開
   - **未知 id／非 boolean 值 → config parse 失敗（fail-closed）**，接上既有「無效配置＝每個 hook 拒絕」的接線
5. **URL 規則以 `optIn: true` 回歸**（id `url`）：預設關閉，`rule_overrides.url: true` 啟用；wire 回歸測試在預設組態下通過。
6. **測試**：`tests/rule-toggles.test.ts`（id 完整性、opt-in 預設關、關閉既有 builtin、配置驗證 fail-closed、redact 貫通）；`config/guard.config.yaml` 範例註解同步（含移除過時的「信用卡自訂規則」範例，改指引 builtin `credit-card`）。

## 決策記錄：URL 規則曾以 always-on 實作後回退，改為 opt-in

第一輪曾實作 always-on `PII_URL` builtin，**測試證實在 transparent wire 模式造成回歸**：provider endpoint URL 被視為 PII → 請求 url／header 欄位遮罩破壞形狀 → fail-closed 拒絕（`opencode-transparent.test.ts` 可重現）。第二輪以 toggle 機制＋`optIn: true` 解決：規則存在、預設關、使用者明示開啟。與 Rehydra「URL／IP 預設關」政策同型。~~剩餘開放項：欄位感知豁免~~——第三輪已完成（見下）。

## 未做項（延後理由）

| 項目 | 理由 | 出路 |
|---|---|---|
| 地址／郵遞區號 | 純規則誤報率高（任意 5 位數字＝郵區） | NER 或 dynamic rules |
| 日期 | 程式碼／log 語境到處是日期，always-on 不可行 | NER（生日語境）或 dynamic |
| IPv6 | `::` 壓縮與 MAC-derived 位址誤報複雜 | 後續單獨評估 |

## 已完成（2026-10-07 第三輪：欄位感知豁免）

7. **Transport 位置 PII_URL 豁免**（`src/opencode-transparent.ts`、`src/opencode-transparent-http.ts`）：
   - `TransportMaskingService` 新增 `transportDetectSensitive`／`isTransportIdentifierSafe`；request URL、query value、header value 的檢查改用 transport 變體（name 維持嚴格）
   - 實作採**中性化**：URL 規則啟用時，transport 檢查前先將 URL 命中 replace 為 `"url"` 再走嚴格掃描——一次解決兩層問題（直接 findings＋percent-decoding hazard 視窗；第一版嘗試在 decision 層過濾 findings，擋不住 `urlContextHazard` 的解碼視窗硬失敗，已回退）
   - 豁免只在 URL 規則啟用時生效；非 URL 敏感值（如 query 裡的 API key）仍拒絕；body 內容 URL 照常遮罩
   - 測試：`tests/opencode-transparent.test.ts`（回歸場景 endpoint+query token、header URL 保留、body URL 遮罩為 `[SGP1:…]`、`x-key: sk-…` 仍拒絕）

## 已完成（2026-10-07 第四輪：電話規則 opt-in —— P2 補實作）

8. **`phone-tw`／`phone-intl` 改 opt-in 預設關**（`src/rules/builtin.ts`）：
   - 對應 2026-10-06 拒絕政策決策 P2「電話 regex 改 opt-in 預設關（owner 拍板）」——該決策當日未實作，由 2026-10-07 SGP2 語料量測再次證實（SGP1 基準 0.294% 誤報全來自 `phone-tw`；見 `docs/evidence/2026-10-07-sgp2-fp-corpus.md`），同日補上。
   - 漏真電話風險已寫入 README 偵測表（中英雙語，P2 決策要求的文件化）。
   - 測試：`tests/scanner.test.ts` 新增「opt-in 開啟時偵測」與「預設關閉」雙斷言；`tests/opencode-transparent.test.ts` 四個以電話為敏感種子的測試改用 `phoneConfig`（明確開啟）。742/742 全綠。

## NER opt-in 評估項（未實作）

- 形態：**opt-in、預設關閉**（與 Rehydra 政策同型；使用者明確下載模型才啟用）。
- 參考實作：EightDoor `src/ner/`（model-manager、onnx-runtime、tokenizer、token-window）＋ `src/pipeline/`（semantic enrichment）；MIT，衍生鏈授權乾淨，**引用須 attribution**。
- 前置依賴：~~builtin default-off toggle 機制~~ **已滿足**（2026-10-07 第二輪 `rule_overrides`）。
- 驗收條件：模型檔不進 repo／套件；啟用前 doctor 可檢知；fail 行為明確（模型載入失敗＝規則不啟用，不得影響其他規則）。

## 開放驗證

- 新規則對真實語料的誤報率（尤其 13–19 位數字序號通過 Luhn 的 10% 偽陽性）尚無統計；E2E harness 案例可後續擴充。
