# 2026-10-20 OS keychain 金鑰保管驗證（issue #26）

狀態：**現行，待重跑**（只涵蓋 macOS；Windows DPAPI 與 Linux libsecret 未測）

> 這筆結果在 2026-10-20 取得。之後 restart 子程序改為唯讀 probe（缺 key 就失敗，
> 不再走會建立的 production resolver），因此建議在目前 commit 上重跑一次再拿去
> 勾 #26。重跑步驟見文末。

## 這份文件回答什麼

Issue #26 的第一個勾：「Real OS keychain key custody for persistence」。此前的
測試一律注入測試金鑰（`opencode-transparent.ts` 的測試接縫），`--doctor`
也刻意不碰真 keychain，所以這條階梯從來沒有在真主機上跑過。這次用**正式
程式碼路徑**（`dist/decision/mapping-key.js` + `dist/decision/mapping-store.js`）
在真 keychain 上完成一次「寫入 → 另一個程序重讀 → 解密」。

## 環境

- macOS（darwin），登入 keychain 已解鎖
- 主機未參與（腳本直接呼叫編譯後的 key ladder 與 store）
- keychain 項目：service `leakshield`、account `sgp-mapping-key`（正式名稱）

## 方法

`scripts/diagnostics/verify-keychain-persistence.mjs --real-keychain`：

1. 以 `resolveMappingKeyWithProbe()` 走正式階梯（OS keychain → keyfile → memory），
   外層是一個記錄型 probe：key ladder 的第一次讀取就是「執行前是否已存在」的證據。
2. 在**暫存目錄**的 SGP.db 寫入一個合成 session mapping（加密）。
3. 關閉 store，啟動**另一個 Node 程序**：以唯讀 probe 重新解析金鑰（項目不見就
   失敗，不會補建）、比對 key id、以 read-only 開啟同一個 DB、載入並解密該 session。
4. 全程只輸出布林、來源名稱與計數，不輸出金鑰或原文。

## 結果

| 檢查 | 結果 |
|---|---|
| 平台支援（`createPlatformKeychainProbe`） | PASS |
| keychain 可讀 | PASS |
| 金鑰來源 | `os-keychain` |
| 寫入加密 mapping | PASS |
| 跨程序重新解析金鑰 | PASS（來源同為 `os-keychain`） |
| key id 一致 | PASS |
| 解密後 token 與原文一致 | PASS |
| 項目是否由本次驗證建立 | **是**（cdat `2026-10-20T02:58:02Z`，即 10:58:02 +0800） |
| keychain 項目被刪除 | 否（腳本不刪除） |

> 原稿此處寫「測試前該項目已存在：是（未建立、未覆寫）」，是錯的。舊版腳本
> 先讓 key ladder 解析（缺少時會建立），之後才讀存在性，所以該欄位必然為
> `true`。keychain 中繼資料顯示 `cdat`/`mdat` 都是 2026-10-20 02:58:02Z，
> 與這次驗證的執行時間一致：項目是**這次建立的**。腳本已改為記錄 ladder
> 的第一次讀取，且預設拒絕建立（`--allow-create` 才建立）。
>
> 同一個問題當時也存在於 restart 子程序：它走的是會建立的 production
> resolver，父程序到子程序之間項目若消失，子程序會自己補一把。現在子程序
> 改用唯讀 probe，缺 key 即失敗（`readOnly: true`）。上述 10-20 的結果是在
> 這個修正之前取得的，這也是它標成「待重跑」的原因。

## 邊界

- **只測 macOS**。Windows（DPAPI/ProtectedData）與 Linux（libsecret）
  尚未執行；`createWindowsDpapiProbe` 與 `createLinuxSecretProbe` 仍只有
  單元測試覆蓋。
- 這個 keychain 項目由本次驗證在 2026-10-20 10:58（+0800）建立，現在存在於
  登入 keychain。**不要刪除**：既有持久化 mapping 會無法解密。runbook 裡的
  `security delete-generic-password` 只供理解，不建議執行。
- 沒有人在場情況下，腳本無法驗證「keychain 授權彈窗」的實際 UX；本次
  讀取沒有跳窗（項目 ACL 已允許）。
- 證明了「重啟後金鑰可重讀、mapping 可解密」，**沒有**證明 plugin 端到端
  重啟後的自動 rehydrate（那需要一個真 session 的持久化流程；目前由
  `scripts/e2e/compare` 的 `sg-persist-test` 用注入金鑰覆蓋）。
- 這只是 #26 五個勾的其中一個；Anthropic／其他 provider／soak／latency
  仍未驗證。

## 重跑

```bash
npm run build
node scripts/diagnostics/verify-keychain-persistence.mjs --real-keychain
```

若這台主機還沒有項目，預設會以 exit 2 結束；確認要建立正式金鑰時再加
`--allow-create`。

通過條件：`source=os-keychain`、`restartFound`、`restartEntriesMatch`、
`restartKeyIdMatch` 皆為 true，且 `childReadOnly` 為 true（real 模式）。重跑後
把新的 `summary.json` 數字補進上表，並移除「待重跑」標記。完整清單見
`docs/plans/2026-10-20-issue-26-verification-runbook.md`。
