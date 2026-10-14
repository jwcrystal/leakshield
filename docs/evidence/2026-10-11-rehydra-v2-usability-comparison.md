# Sensitive Guard 與 EightDoor V2：隔離安裝與可用性實測

日期：2026-10-11（UTC 原始測試檔時間為 2026-10-10）。

> **最新官方對照：** 本文件比較的是 EightDoor fork，不是官方版。官方 `@rehydra/opencode@0.14.0` 在 OpenCode V2.0.25 載入失敗；SG 的實際 WS 歸屬拒絕亦仍未解決。最新重跑及安裝建議見 [官方 V2 對照](2026-10-11-official-rehydra-v2-comparison.md)。

> **後續修正（同日）：** 下方比較矩陣保留的是修正前基準。使用者授權修正後，Sensitive Guard 已補完整單／雙引號參數與單一靜態輸出重新導向；原先 shell 拒絕案例已實際轉綠。WS 與記憶體模式下的舊 token 限制沒有修改。最新結果見文末「修正驗證」，不要將修正前矩陣當成目前 shell 能力。

## 結論

一般中英對話、含敏感值的對話、串流顯示還原，以及基本讀寫工具，兩家在本次本地模型替身上都能完成。

Sensitive Guard 的可用性限制已實際重現：**只在占位符參數外加單引號，shell 操作就被拒絕**。明確設定 WebSocket 也會中止對話；未指定 transport 時，插件的 native OpenAI HTTP preference 則有效，對話完成。`wireProtection: false` 不解除上述工具與 transport 守門。

EightDoor 在上述引號 shell 與 WebSocket 案例完成且正確還原，但 **AGENTS.md 注入的 system 敏感值未被遮罩**。不能以「操作成功」推論它是安全的完整替代品。

## 測試對象與隔離方式

- Host：目前機器上的 OpenCode **v2.0.25**。
- Sensitive Guard：本地工作樹副本，含未提交及未追蹤的 src/tests/config；基礎 HEAD `5abd1be`。修正前的隔離安裝階段只在測試副本 `npm ci --ignore-scripts` 後編譯，沒有改動原倉庫 dependencies/dist；修正後另在原倉庫安裝 lockfile dependencies、重建 dist 並重跑全套，見文末。
- EightDoor：實際安裝 npm 發布版 **`opencode-rehydar@0.14.3`**（不是官方 `@rehydra/opencode`，也不是直接跑 GitHub main）。npm registry 所載 gitHead 為 `82c4db7a69549f9e7ecdfb6346b94db05f9f948c`。
- 四組對照：無插件、Sensitive Guard hook-first（false）、Sensitive Guard final-wire（true）、EightDoor。
- 每個案例獨立 HOME、XDG config/data/state/cache、工作目錄；以 `opencode run --standalone` 啟動私有服務。
- 僅使用合成 email／env secret、loopback HTTP／WebSocket 模型替身；沒有使用真實模型帳號或 API key。
- 模型替身依請求中的占位符產生預定文字／工具呼叫，故可驗證整合與參數還原，**不能驗證真實模型的推理、工具改寫或恢復能力**。
- 除 default 專案 .env 探針外，兩家明確配置相同的專案 `.env` 已知值來源、最低長度 8；EightDoor NER 關閉。Sensitive Guard 的 NDA/private-domain/custom lists 為空，不代表測過使用者全部自訂規則。
- 未改全域配置、未註冊到現有對話、未重啟 shared service、未讀取或寫入 OS keychain；未提交 git。

## 編譯與既有測試

測試副本中 `npm run build` 成功，`npm test` 為 **38 files / 804 tests passed**。

## Chat Completions：正常流程與操作正確性

「成功」要求正常退出、實際收到最終回答；工具案例另外檢查 read 輸出或生成檔案內容。模型替身在工具出錯後仍回覆 `OK_DONE`，故特別區分「能繼續對話」與「工具正確完成」，不把 exit 0 當作任務成功。

| 案例 | SG hook-first | SG final-wire | EightDoor 0.14.3 |
|---|---|---|---|
| 普通中英對話（Foundation／agenda） | 成功 | 成功 | 成功 |
| email＋已知 env value 對話 | 成功，無原值外送 | 成功，無原值外送 | 成功，無原值外送 |
| 占位符跨 SSE chunks，顯示原值 | 成功 | 成功 | 成功 |
| 讀取含敏感值檔案，再回送模型 | 成功，重新遮罩 | 成功，重新遮罩 | 成功，重新遮罩 |
| tokenized 檔名還原後 read | 讀到正確檔案 | 讀到正確檔案 | 讀到正確檔案 |
| tokenized content 還原後 write | 寫入正確原值 | 寫入正確原值 | 寫入正確原值 |
| `printf %s TOKEN` | 正確執行 | 正確執行 | 正確執行 |
| `printf '%s' 'TOKEN' > file` | **工具拒絕**；對話繼續 | **工具拒絕**；對話繼續 | 正確執行、檔案含原值 |
| AGENTS.md system 含敏感值 | 成功且遮罩 | 成功且遮罩 | 對話成功，但 email／env value **原樣進 primary request** |
| 重啟 process 後 `--continue` | 成功且遮罩 | 成功且遮罩 | 成功且遮罩 |
| 重啟後模型沿用第一輪舊 token 寫檔 | **write 拒絕**；對話繼續 | **write 拒絕**；對話繼續 | 此 fixture 正確寫入原值 |

無插件對照中的相關原值確實進入本地模型替身，證明 capture 的漏值檢查可以抓到未保護內容。

### 最小 shell 重現

補充案例將重新導向與 format 引號移除，僅測：

```text
printf %s 'TOKEN'
```

無插件與 EightDoor 正確輸出原值；Sensitive Guard 的兩種 wire 設定皆拒絕 shell，錯誤為：

```text
Sensitive Guard transparent mode blocked this tool call because the shell command does not use a supported literal-argument form. Rewrite it as a simple command or use a non-shell tool.
```

這不是「所有帶引號的 shell 都被拒」：此案例**帶有待還原占位符**。也不是 final-wire 檢查造成；hook-first 有相同行為。

### 重啟案例的限制與持久化補充

舊 token 寫檔案例由模型替身刻意保留第一轮 provider-bound token，重啟後再次使用它；不是已證明正常模型看見重新遮罩的 history 後必然沿用舊 token。EightDoor 在此固定順序 fixture 重建相同 `<PII type="EMAIL" id="1"/>`，不代表其插件已有 durable mapping 或所有 fork/reorder 都安全。

補測 Sensitive Guard 的 production guard/store，透過測試 adapter 注入跨 process 相同的合成 key，**不碰使用者 keychain**：重啟續聊與舊 token 寫檔均成功且無原值外送。這驗證本 host 的持久化水合流程；**不是 production OS keychain ladder 的端到端驗收**。未啟用 persistence 的記憶體模式仍有上表限制。

## Native OpenAI Responses：HTTP／WebSocket

使用 built-in `openai` provider identity 加本地 endpoint／合成認證，回覆包含跨 delta 的占位符。以下「成功」均檢查回覆到達且顯示正確原值。

| 設定 | SG hook-first | SG final-wire | EightDoor |
|---|---|---|---|
| 明確 `transport: http` | 成功，無原值外送 | 成功，無原值外送 | 成功，無原值外送 |
| 明確 `transport: websocket` | **exit 1，無 primary 外送** | **exit 1，無 primary 外送** | WS 成功且還原，無原值外送 |
| 未指定 transport | 成功，primary 導向 HTTP | 成功，primary 導向 HTTP | primary 走 WS 且成功 |

無插件 HTTP、WS、default 對照均成功，且 raw canary 進本地模型替身。這排除了 WS fixture 本身不可用；也證明不是「OpenAI 預設都被 SG 擋」，而是**明確 WS config 覆蓋其 HTTP preference**的情境會被拒。

## EightDoor 發布版的 default .env 注意事項

額外以 `options: {}` 安裝發布版、只在專案根放 `.env`：email 被遮罩，但 `.env` 已知 secret 在 title／primary 請求原樣外送。

發布版 `dist/opencode-plugin/v2/options.js` 的預設 envBaseDirectory 是 OpenCode config directory，而不是專案 directory。主要對照實驗刻意明確指定 `anonymizer.secrets.envBaseDirectory`，因此没有把來源設定差異混成偵測引擎差異。若安裝此版給日常專案用，**應明確指定來源**，不能只照主分支 README 假定它自動掃到專案 `.env`。

## 建議順序

1. 優先改善 SG **帶占位符的常見 shell quoting**；正確保留原值／參數語意，不只是刪掉安全拒絕。
2. 使用 HTTP 的 native OpenAI 路線時，不必因這次測試再減少 wire 防護：兩種設定在成功案例均完成；未測全 provider variants。
3. 若實際需要 WebSocket，將它列為相容性需求；目前 SG 的明確 WS 設定必然拒絕，EightDoor 有可參考的還原實作。
4. 重啟後仍需沿用舊 token 的工具流程，可評估已實作的選用 persistence；本次不替使用者啟用。
5. 暫緩 NER／新增廣泛偵測；不能直接以 EightDoor 換掉 SG 而忽略 system 遮罩缺口。

## 原始證據與重跑

隔離安裝及測試工具全部保留於：

```text
$TMPDIR/opencode/sg-rehydra-test-4Uw7Wx/
```

- `sensitive-guard/`：測試副本、dependencies、compiled dist。
- `eightdoor/node_modules/opencode-rehydar/`：實際安裝的發布版。
- `compare.mjs`：Chat Completions 真實 host 對照；`--assert` 在對話／正確性／漏值斷言失敗時回非零。
- `protocols.mjs`：native Responses HTTP/WS/default 實驗，記錄能力差異而非把預期拒絕標成成功。
- `results/*/<suite>--<case>/`：每例 result.json、captures.json、stdout、stderr。
- `protocol-results/2026-10-10T19-24-12-848Z/`：native transport 矩陣。

主要 Chat Completions 的初測與矩陣在 `results/2026-10-10T19-22-01-495Z/`、`results/2026-10-10T19-22-19-059Z/`。持久化、default-env、重跑／最小化探針在 `19-25-*`／`19-26-*` 目錄。

兩個 `19-26` 並行探針曾共用毫秒級輸出目錄，各 case 子目錄完整保留，但頂層 summary.json 不宜視為全量紀錄；判定依各 case 的 result.json／原始捕獲。Runner 隨後改為 mkdtemp 唯一目錄，未刪除或覆寫既有 case 證據。

最小拒絕重現（預期回 exit 1）：

```sh
node "$TMPDIR/opencode/sg-rehydra-test-4Uw7Wx/compare.mjs" --suite=sg-hook --case=shell-quoted-only --assert
```

實測已執行過；對話 exit 0，但 shell 操作未完成，測試斷言回 exit 1。這個訊號不依賴人工看畫面，也不把「模型繼續說話」誤認為工具成功。

Temp 檔案不保證永久留存，本文件保存可審查的導出結論。

## 尚未驗證

真實 provider／API key／訂閱認證、AI SDK、Anthropic native、本次以外的 reasoning／hosted tools、compaction、fork/revert、附件與真實模型在工具拒絕後的自行恢復。此次不宣稱真實模型品質、長時間穩定性、完整資安審計或兩家性能優劣。

## 修正驗證（同日）

根因是工具還原 gate 將整個命令的引號／重新導向一律視為不支援，且只接受空格界定的未加引號 token。不是 scanner 漏值、模型拒答或 final-wire 檢查。

修正範圍：`src/opencode-transparent.ts` 的 shell literal-word 判別與 quote-context 檢查；沒有改 transport、scanner、mapping 或全域設定。

- 完整的 unquoted／single-quoted／double-quoted argument 均可還原，保留原引號，不自動重寫 shell 程式。
- 引號內原值不得跳出引號或觸發展開，含空格的已知原值仍是一個參數；leading `-` 與控制字元保留拒絕。
- 支援单一結尾 `>`／`>>` 與靜態 literal 檔名；不支援 tokenized redirect target、FD redirect、heredoc、管線或控制語法。
- 解讀被引號包住的 command/flag 後仍套用 wrapper／inline-script 守門，防止 `'sh' '-c' TOKEN` 等繞過。
- 新增的 POSIX quoting/redirect 支援不在 Windows 啟用。Windows shell dialect 尚未驗證；未宣稱通用 shell parser。
- 未知 mapping、無法安全還原，以及不可寫輸入，仍在任何參數修改前拒絕受影響工具。

驗證：

1. 新回歸案例在修正前 **7 個應成功案例失敗**，均指向 shell gate。
2. 修正後測試副本與原倉庫全套皆為 **38 files / 819 tests passed**，兩處 `npm run build` 成功，`git diff --check` 通過。原倉庫以 `npm ci --ignore-scripts` 安裝既有 lockfile dependencies；未改 package.json/package-lock.json，也未替使用者啟用另一個插件。
3. Unit tests 以受控 `/bin/sh` printf 驗證引號／空格／單引號內 metacharacter 的精確輸出，並保留 quote-breaking、展開、script、option injection 等反例。
4. 原生 host A/B 回測 **18 個應成功案例通過**：兩種 wire 設定各測 plain shell、最小單引號 shell、引號＋重新導向、敏感對話、tool-output replay、read-path restore、write-content restore、SSE display restore、process restart resume；每例正確完成且 provider capture 無原值。
5. Native OpenAI transport 回測 6 例：兩種 wire 設定各測 HTTP、default（primary 導 HTTP）、明確 WS（預期 exit 1，無 primary 外送）。WS 仍未實作，沒有以放行換成功。

新的 E2E 原始證據：

```text
results/2026-10-10T19-41-24-599Z-eyKLDQ/summary.json
protocol-results/2026-10-10T19-41-24-605Z/summary.json
```

位於上方隔離測試根目錄。修正前的最小重現命令現在應回 exit 0。原倉庫既有未提交工作保留；本次沒有 commit、全域註冊或 shared-service restart，不能宣稱現有服務已載入新版。
