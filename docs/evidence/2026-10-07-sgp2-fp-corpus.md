# SGP2 Token 語料誤報量測（W1 / A4 驗收證據）

日期：2026-10-07
對應：`docs/plans/2026-10-07-sgp2-persistence-execution-plan.md` Phase A（A4）、`docs/plans/2026-10-07-persistence-decision-db-over-t2.md` W1
量測者：agent（owner 委託）；腳本一次性執行，語料與規則版本如下。

## 設定

- 語料：
  - **SGP2**＝1020 枚（6 偵測家族 × 170：email / api key / IBAN / 信用卡 / 公網 IP / URL），經真實 `createPseudonymizer().protectText` 鑄造，隨機 payload。
  - **SGP1（基準）**＝1020 枚合成 token（隨機 32-hex epoch + 隨機 8 位計數器，重現歷史 0.24% 量測的隨機 token 形態）。
- 掃描：`scanTextInternal(token, config, { honorIgnoreDirectives: false })`，逐 token 獨立掃描（命中可歸因到規則）。掃描對象為**完整 token（含類別欄位）**。
- 規則版本：27 條 built-in（工作樹 2026-10-07，含 NDA standalone-word 修正 `5abd1be`）。
- 兩組 profile：`{url: on}`（其餘預設）與 `{url: on, phone-tw: on, phone-intl: on}`。
- NDA/custom 規則為空（自訂規則碰撞屬既文件化殘餘風險，不在此測）。

## 結果

| 語料 | profile | 命中數 | 命中率 | 命中規則 |
|---|---|---|---|---|
| SGP1（基準） | url on（預設） | 3 / 1020 | **0.294%** | `PII_PHONE_TW/台灣手機號碼` ×3 |
| SGP1（基準） | url+phone on | 3 / 1020 | 0.294% | 同上 |
| **SGP2** | url on（預設） | **0 / 1020** | **0.000%** | — |
| **SGP2** | url+phone on | **0 / 1020** | **0.000%** | — |

## 判讀

1. **SGP1 的電話誤報在今天 的預設配置下仍存在**：量測顯示 `phone-tw` 在未開 override 時仍作用 —— 對應 2026-10-06 決策 P2「電話規則改 opt-in 預設關」**尚未實作**的事實（該決策為未排期修法項）。SGP1 基準 0.294% 與 T3 票所述歷史量測（0.24% 量級）一致。
2. **SGP2 結構性歸零**：payload 純小寫字母（零數字）→ 電話／信用卡／IBAN／身分證等數字型規則家族不可能命中；分段（4-4-4）＋連字號 → hex-like run ≤4；類別與 payload 以 `-` 分隔 → `generic-secret` 的 `secret\s*[:=]\s*value` 形狀無法自撞（`SECRET-xxxx` 破壞 `[:=]`）。
3. **限制（照實記錄）**：1020 枚抽樣零命中≠對任意自訂規則／known-value／NDA 關鍵字免疫（類別字樣如 `NDA_KEYWORD` 本身含 "NDA"，若使用者 NDA 關鍵字設為 "NDA" 即命中——已於決策文件明文為接受的殘餘風險）。可信賴邊界仍是 T1 的 token 辨識／完整掃描，與命中率無關。

## 附註（2026-10-07 同日修訂）

量測完成後，P2「電話規則 opt-in 預設關」已於同日實作（`phone-tw`、`phone-intl` 加 `optIn: true`，tests 全綠 742/742）。因此上表「url on（預設）」profile 的 SGP1 基準在 P2 之後降為 0/1020 —— 0.294% 的數字對應 P2 之前或明確開啟電話規則的 profile。SGP2 在兩種 profile 皆為 0，不受 P2 影響。

## 分隔符偏離設計示意之說明

2026-10-06 決策文件 T3 的格式示意為 `[SGP2:<CATEGORY>:<payload>]`（冒號）。實作改用 `-`：冒號會使 `[SGP2:SECRET:xxxxxxxx]` 完整滿足 built-in `generic-secret` 規則（keyword `secret` + `:` + ≥8 字元值）—— 每一枚 SECRET/ENV_SECRET 類 token 自撞一條 HIGH 規則，量測前即以規則形狀推導證實。`-` 破壞該形狀且不引入 shell 中介字元（`|` 會破壞 standalone-argument 還原規則，不可用）。此偏離記錄於本文件與決策文件 W1 附註。
