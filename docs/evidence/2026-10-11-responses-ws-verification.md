# Native Responses-family WS 與持久化狀態驗證

日期：2026-10-11。修正前基準：[同日 SG／EightDoor 對照](2026-10-11-rehydra-v2-usability-comparison.md)。

> 後續修正：[AI SDK HTTP 驗證](2026-10-11-aisdk-http-verification.md)已解除 injected-fetch SDK 的全面拒絕，並新增 Responses easy-input 支援。下方 WS 階段的 844 tests 與限制是該階段快照；最新工作樹為 863 tests，不表示所有 private SDK transport 都受保護。

> 更新：[體驗優先驗證](2026-10-11-experience-first-verification.md)已改為入站歸屬／SG 解析失敗不還原、保留原 frame，而非中斷串流；false 可在 scoped 準備遮罩成功後讓未知 route hook-only。下文的「拒絕」及 test 數字保留為當時快照，不代表新回覆政策。WS 單 frame／無 connection ID 的限制不變。

## 結論

Native Responses-family WebSocket 已從一律拒絕改為協定形狀適配；相容 gateway 不受 OpenAI 品牌限制。HTTP／WS 共用 `wireProtection`，關閉最終出站掃描不會關閉顯示還原、metadata／attribution 檢查或工具防線。

持久化仍 opt-in，未修改使用者設定。Runtime 現在回報 store active 與實際金鑰來源；doctor 明示設定／DB 可讀不等於啟用或能解密。

## 實作範圍

- `src/opencode-transparent-ws.ts`：native `ws:`／`wss:` `/responses`，flat `response.create`；session／kind／model lane，加上 response ID／內容 channel，跨 frame token 緩衝與顯示還原。
- 出站使用既有 HTTP Responses 原子 masker；continuation／event／conversation 字串 ID 保持原樣，敏感 ID 拒絕。未知 frame、混形內容與未支援 attachments 在 final-wire 模式拒絕；hook-first 不宣稱防護 late-added 內容。
- `src/opencode-transparent-http.ts`：共用 token split／display restore 與完整 Responses part/item/display 欄位規則。function-call arguments 留給本地工具防線，encrypted reasoning 不還原。
- `src/opencode-transparent.ts`：實際 hooks、持久化水合／保存、唯讀 frame 先拒絕、拒絕後狀態清理。HTTP fallback、新 handshake／模型切換與 dispose 使舊 lane 失效；terminal 清理 held text 與 channel bookkeeping。
- 記憶體限制：frame UTF-8 4 MiB、單次 delta＋tail 64 KiB、每 lane 256 display channels、全部 lane 的 held text＋channel keys 1 MiB、1024 lanes、identity key／response ID 4 KiB。容量不足時不放行未知內容。
- `src/decision/mapping-key.ts`／`mapping-store.ts`：provider 的 content-free source label；`active; key=os-keychain|keyfile` 是實際來源，不依是否允許 fallback 猜測。測試注入 provider 顯示 `injected`。
- `src/doctor.ts`：持久化為 CONFIGURED／WARN，明示 runtime activation／decryptability 未驗證，不查真實 Keychain；keyfile 選項標示「允許 fallback」，不是聲稱目前使用 keyfile。

## 已驗證

最終原倉庫驗證：**39 test files／844 tests 全部通過**，`npm run build` 與 `git diff --check` 成功。這是所有既有未提交原始碼加上本輪修改的工作樹結果，不是只測乾淨 HEAD。

### Red → green 與公開 hooks

- 第一個相容 gateway 的 WS 遮罩／跨 frame 還原測試在修改前因 WS 守門失敗，修改後成功。
- 持久化 active-source 提示在修改前缺少紀錄而失敗；doctor 原本把 DB 可讀／未建立顯示 ok，修正後不再誤認 runtime 啟用。
- 模型切換的舊回覆失效測試曾揭示同 session／kind 的舊 model lane 仍可收訊；現在新 handshake 會清除同請求種類的舊模型狀態。
- 公開 hooks 覆蓋：兩種 wire 設定、late-added 值的保護差異、primary／title／compaction／generate、session／model／內容 part 隔離、continuation ID、terminal/error、重試新 handshake、HTTP fallback hook、未知／malformed frame、不可寫輸入、UTF-8／channel caps、unknown token、工具參數不在 wire 入站提前還原。
- 注入固定合成金鑰的兩個 guard 模擬 process 重啟，驗證 WS 首次接入前水合舊 token，顯示與 write-tool 參數都可還原。沒有存取真實 OS Keychain。

### 真實 OpenCode host＋本地模擬模型

Host：OpenCode **v2.0.25**，`/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode`。沒有使用外部模型、真實 provider credentials 或 shared-service restart。

最初 transport 回測的 6 個案例均成功：兩種 wire 設定各測 HTTP、明確 WS、default。default 仍因既有 preference 使用 HTTP；不把 default 的成功當成 WS 證據。

```text
$TMPDIR/opencode/sg-rehydra-test-4Uw7Wx/protocol-results/2026-10-10T20-34-06-353Z/summary.json
```

最新工具 E2E 直接載入原倉庫 compiled dist，使用可保留重跑的 `scripts/e2e/run-responses-ws.mjs`：

| 案例 | 對話／顯示 | write、read、單引號 shell | 主請求 | WS 連線 | 模型 capture 原值 |
|---|---|---|---|---|---|
| HTTP hook-first | 成功／原值還原 | 成功，兩個檔案為精確 email 原值 | 4 | 不適用 | 0 |
| HTTP final-wire | 成功／原值還原 | 成功，兩個檔案為精確 email 原值 | 4 | 不適用 | 0 |
| WS hook-first | 成功／原值還原 | 成功，兩個檔案為精確 email 原值 | 4 | 1（重用） | 0 |
| WS final-wire | 成功／原值還原 | 成功，兩個檔案為精確 email 原值 | 4 | 1（重用） | 0 |

每案包含 AGENTS.md 合成 email／env secret、出站工具／結果 replay、function argument 分 frame、回覆 token 刻意切在占位符內。後續三輪主請求均含 function_call_output。Title 請求也被捕獲且無原值，但此 host 在這組測試使用 HTTP title；不宣稱 native WS title 已做真實 host 驗證。

最新原始 capture、stdout、stderr、summary 保留於：

```text
$TMPDIR/opencode/sg-ws-tools-eKIf4K/
```

早一輪相同工具案例也全數通過，位於 `sg-ws-tools-216gOq/`。暫存目錄不是永久證據備份；下方命令可重新產生。

## 重跑

```sh
npm ci --ignore-scripts
npm run build
npm test
OPENCODE_BIN=/absolute/path/to/opencode node scripts/e2e/run-responses-ws.mjs
```

Runner 建立外部唯一暫存工作目錄，隔離 HOME／XDG、設定合成認證、保留所有 capture；不修改全域配置。可用 `E2E_WORK_ROOT` 指定預先存在的外部暫存父目錄。它依賴 lockfile 的 plugin SDK 提供的 `ws` 開發套件。任何期望完成／還原／工具檔案／無原值外送／WS 重用檢查失敗，exit 1，不把程序 exit 0 當成工具成功。

## 限制與未驗證

- 目前只支援已列形狀的 native Responses-family，不等於任何 WS dialect、所有 provider extensions、AI SDK 或所有 Responses-hosted tools 都支援。
- OpenCode hooks 沒有實體 connection ID；buffer 隔離依賴其 session／kind／model 事件契約。模型切換／fallback 會清舊 lane，但不宣稱具備額外的跨 socket 驗證。
- WS hook 只能取代單一 frame，不能插入額外 delta。若 provider 沒有最後文字 delta，完整 `.done` 欄位仍還原且保留事件型別，固定 WARN；只讀 delta 的 consumer 可能漏顯示尾段，不宣稱能修復任意不完整 provider 串流。
- 真實 provider 認證／訂閱、完整 compaction／title／generate 的 WS host 流程、host 自動 retry/fallback、取消後續接及長期效能未驗證。相關狀態轉換的 mock hook 測試不替代這些證明。
- Native OpenAI HTTP preference 仍保留為相容預設，不改既有 wire／persistence 預設或使用者全域設定；明確的 supported WS 設定不再被一律拒絕。
- 未存取真實 Keychain，不能宣稱此使用者的持久化已啟用或健康。TTL 仍在 store-open 清理，不保證準時刪除；備份殘留、同步 keychain 啟動延遲與既有競爭限制不變。
- 本輪未加 NER，沒有 commit／push，也沒有替使用者重啟背景服務。使用者曾在工作期間通知 server 自行重啟；不據此斷言新插件已正確載入該服務。
