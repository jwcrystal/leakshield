# 目前 SG 的影響：哪些情況仍會被擋

日期：2026-10-11。範圍：純 hook-only 修正前的 transparent 模式快照。

> 後續契約已改為 pure hook-only：false 不再註冊出站傳輸／SDK admission 或改 provider transport；本文件的 false 傳輸拒絕盤點不再代表現況。輸入遮罩與工具防線仍在，見 [最新驗證](2026-10-11-pure-hook-only-verification.md)。

## 先講結論

**`wireProtection: false` 是相容性優先，但不是「不擋模式」。** 保留初始化、context、metadata 與工具安全；未知 route 只有同 session／kind／model 的 host 準備遮罩成功才可 hook-only。兩種 wire 都將 SG 回覆歸屬／解析失敗降為不還原，不再因這些入站失敗額外中斷回答。[本輪驗證](2026-10-11-experience-first-verification.md)。

**目前全域設定已移除 SG。** 以下是仍載入 SG 的實例，或重新啟用時的影響；本次沒有重啟共用服務，也沒有確認所有舊實例都已卸載。若仍出錯，不應直接假定現在每個錯誤都是 SG。

## 1. 仍會拒絕模型請求

「false 也會」指上述 hook-first 設定仍有這項限制。程式有拒絕條件，不代表每項都曾在你的日常對話發生。

| 情況 | 你會看到的影響 | false 也會？ | 證據／限制 |
|---|---|---|---|
| **不支援的模型 endpoint／transport** | true 拒絕；false 缺 scoped 遮罩證明或 metadata 不安全仍拒絕 | **有條件** | HTTP／WS 可採 hook-only，但沒有未知協定 adapter；非 HTTP／WS transport 不因此支援 |
| commandcode Go 或 `403 upgrade_required` fallback 至 **`/alpha/generate`** | true 拒絕；false 在準備 hooks 已遮罩時可繼續，顯示 placeholder | **有條件** | 本地兩模型族／八方案矩陣通過；沒有 legacy body／回覆 adapter，不是線上訂閱驗證 |
| WS 出站沒有匹配的 handshake、不是支援的 envelope 或 frame 超過上限 | 拒絕出站 frame | 會 | 未知 route 的 false hook-only 路線須先取得 scoped 遮罩證明；不是取消 send 守門 |
| AI SDK 缺可替換的 injected fetch，或 options/fetch 是 accessor、proxy、不可寫等不支援形狀 | SDK 初始化／模型呼叫被拒絕 | 會 | 不再全面拒絕 SDK，但仍有注入契約 |
| **context 遮罩無法安全完成** | 主對話、title、generate 或 compaction 的受影響請求被拒絕 | **會** | 例如掃描不完整、遮罩後仍有敏感內容、JSON 結構不能安全處理 |
| **編碼／變形後才看得見的敏感內容**，例如 Base64、URL／Hex 編碼或受檢測的 Unicode 變形 | 不能直接安全替換原始區間時，拒絕請求 | 會 | 不是所有 Base64／URL 都被擋；是偵測到敏感值且不能安全遮罩的情況 |
| 敏感值出現在不能改名的結構欄位，例如 tool name、message ID、role、part type；或數字值被判定敏感 | 拒絕請求，而不是改壞協定或將 number 變成字串 | 會 | 可受到自訂規則／誤報影響；不是一般文字命中就拒絕 |
| URL query 或非認證 header 含敏感值，無法在保持 transport 語意下遮罩 | 拒絕該請求 | 會 | 正常 `Authorization`、`x-api-key` 等認證 headers 有豁免；不是正常 API key 一律被擋 |
| 設定無效、初始化失敗、必要 hooks 無法完整註冊 | 進入 fail-closed，可能廣泛阻擋模型與工具 | 會 | 例如 YAML／選項 schema 錯誤、與 host API 不相容；不存在的 configPath 不一定造成此結果，loader 可能採 defaults |
| 輸入、mapping 或出站狀態超過上限 | 拒絕該請求／操作 | 會 | 大型工具輸出、極長內容或過多同時狀態仍可能影響；入站解析上限改為停止還原並接續原回覆 |
| **最終出站 body 使用 adapter 不支援的內容形狀** | 拒絕模型請求 | **此層只在 true** | 混合協定、未知 item／block、不合法 JSON tool arguments；false 不驗證最終 HTTP body，context 與工具防線仍保留 |

### 上限的實際意思

- 一般文字遮罩每個字串受 `settings.max_chars` 限制；最後使用的預設／全域規則值為 **200,000 字元**。超過不能只掃前半段後放行。
- 核心單次操作上限 **1,048,576 UTF-16 units**，JSON 深度 32、nodes 10,000；mapping 另有每 session／全域容量限制。
- final-wire HTTP body、非串流回覆 clone-read，以及單個已解析 WS frame 的上限是 **4 MiB UTF-8 bytes**；回覆 read／parse 超限不再是 SG 中止理由。
- SSE 待交付原始事件及改寫結果各有 **1 MiB** 上限、片段 bookkeeping 最多 **4096**；到上限釋出未交付原 bytes 後停止還原。SSE／WS 單次文字 channel 仍有 **64 KiB** 檢查及 channel 數量上限。
- **64 KiB 不是整段回答的總長上限。** 它約束單次 delta 與保留的片段；正常小 chunks 的長回答可能持續通過。

## 2. 只擋某次工具操作，對話通常還能繼續

下列全部不受 `wireProtection: false` 解除。實測的工具拒絕後對話可繼續，但不能保證每個模型都會自行重讀／改寫並完成任務。

| 情況 | 受影響操作 | 目前結果 |
|---|---|---|
| **placeholder 沒有本 session 的 mapping**，例如重啟後沿用舊 token、其他 session 的 token、token 被模型改壞 | write、edit、patch、shell、network／其他非唯讀工具 | 拒絕該次工具；這次重啟舊 token 寫檔實測失敗 |
| **shell 含 token，而且命令不在安全 literal-argument 子集內** | shell／bash 等 | 拒絕該次工具；不是所有複雜 shell 都被 SG 擋 |
| token 放在 shell command 名稱、assignment、redirect target，或只占參數的一部分 | shell | 無法安全還原，拒絕 |
| 還原值會跳出既有引號、觸發展開、注入 option 或包含控制字元 | shell | 拒絕；例如原值以 `-` 開頭，或單引號參數的原值也含單引號 |
| 參數包含 token-key、proxy、getter、symbol、frozen／不可寫結構或不支援的循環／共享結構 | 受影響工具 | 無法原子、安全套用還原時拒絕 |
| 工具還原超過操作上限 | 受影響工具 | 拒絕，需縮小參數 |
| 不在已知 non-shell 清單的新工具／自訂工具含 token | 該工具 | 採保守 shell-like 還原；無法符合安全形式時拒絕，而非自動相信它只是文字工具 |

### shell 範例

以下 `TOKEN` 代表真正的 SG placeholder，不是普通字串 `TOKEN`。原值也必須適合既有 quote context。

| 命令形狀 | 現況 |
|---|---|
| `printf %s TOKEN` | 支援 |
| `printf '%s' 'TOKEN'` | 支援完整單引號參數 |
| `printf '%s' 'TOKEN' > output.txt` | 支援單一結尾靜態輸出重新導向；`>>` 也可 |
| `printf %s TOKEN \| other-command` | 含 token 時不支援管線 |
| `command TOKEN && next-command` | 含 token 時不支援控制語法 |
| `sh -c '...TOKEN...'`、`node -e '...TOKEN...'` | 不支援將 token 還原到 inline script |
| `sudo command TOKEN`、`env command TOKEN` | wrapper 形狀不支援 |
| `printf %s prefixTOKEN` 或 `> TOKEN` | token 不是完整普通 argument，拒絕 |

**沒有 token 的一般 shell 不會因這個 literal-argument 還原 gate 被擋。** OpenCode 權限、作業系統、命令本身仍可能拒絕或失敗。POSIX quoting 支援不能當成 Windows 通用能力。

## 3. 不會直接擋，但有可見影響

| 情況 | 現況／影響 |
|---|---|
| **HTTP／WS 回覆歸屬不明或不匹配** | 不查錯誤 session／kind／model mapping，保留原回覆；不再拋 SG 入站拒絕。已用遺失 send registration 重現舊 WS 錯誤並驗證新政策 |
| SG JSON／SSE／WS 解析／還原失敗或超限 | 停止還原，顯示 literal placeholder；HTTP SSE 保留未交付原 bytes、順序及後續串流。WS 單 frame 介面不能補發任意多 channel 的 held tail |
| Provider 自己的錯誤、來源 stream error 或 abort | 仍可能中斷回答；SG 不捏造 completion，也不吞 provider error。壞掉的 provider 資料仍可能被 host 拒絕 |
| false 的未知 route／SDK injected HTTP fetch | 已核對 scoped 準備後可 hook-only；無 final body 掃描、無未知協定回覆還原，明示覆蓋有限 |
| 一般文字偵測到 email、secret、其他可安全遮罩的敏感值 | 替換成 placeholder 後繼續，不是命中就中止 |
| **顯示文字的 token 未知／mapping 已失效** | 保留字面 placeholder、記錄降級；歸屬／envelope 失敗時也不猜 mapping、不額外拋 SG 拒絕 |
| 已知唯讀工具的未知／壞 token | `read`、`grep`、`glob`、`list` 等可保留字面 placeholder 繼續；可能讀不到檔案／查無匹配，並非成功還原 |
| `attachments: block`（最後採用的設定） | 一般 media/file part 被略過並以通知替代；文字對話可繼續，但模型看不到附件。附件出現在無法安全替代的位置或未知 wire block，仍可能拒絕 |
| `attachments: allow`（未啟用） | 附件可未掃描地送出，有通知；這是保護缺口／使用者授權，不是已完成附件去識別化 |
| 記憶體 mapping、持久化未啟用 | 不阻擋正常啟動；但重啟後舊 token 可能無法還原，進而影響後續寫入／執行工具 |
| 選用持久化找不到 Keychain key、一般 DB 寫入失敗 | 通常降級為 memory-only／保留本次記憶體 mapping，不直接擋對話；不代表所有 persistence 錯誤都無影響。此功能目前未啟用 |
| native OpenAI 的預設 transport | SG 會偏好 HTTP；明確 provider 設定可覆蓋它，因此不能保證不會走 WS |
| SDK 自行使用 global fetch、private socket 或子程序，忽略 injected fetch | **不在覆蓋內，不保證被擋，也不保證安全**；SG 不是網路防火牆 |

`wireProtection: false` 的取捨：正常 context hook 仍遮罩，之後新增的最終內容不再掃描；未知 route 可以 hook-only，不等於已有協定 adapter 或保護範圍相同。回覆降級可能降低顯示還原能力，但不解除工具防線。

## 4. 對日常使用最重要的三個影響

1. **SG 不再因 WS／HTTP 入站歸屬／解析失敗直接中斷回答。** 隔離 host 故障案例已修正此拒絕政策；真實環境遺失歸屬的根因仍未知，可能看到 placeholder。
2. **需要還原 token 的複雜 shell、新工具及失效 mapping 仍可能拒絕操作。** 模型可以繼續聊天，不代表任務已完成。
3. **大型內容、編碼敏感值及結構欄位誤報仍可能擋整次請求。** 關 final-wire 無法解除 context 遮罩層的限制。

## 5. 與剛比較的兩個 Rehydra 版本有何不同

- **官方 `@rehydra/opencode@0.14.0`：** 在此 V2 host 載入失敗；對話沒有被它擋，也沒有被它保護。
- **EightDoor `opencode-rehydar@0.14.3`：** 回覆還原錯誤偏向記錄後保留原 payload；工具還原錯誤也可能吞錯後繼續。較少 SG 式中止不代表拿到正確工具參數；本地補測仍有 AGENTS.md system 原值外送。
- 不應用「官方／fork 不擋」推論可直接安全替換 SG，也不應用 SG 單元測試通過推論日常 WS 不會中斷。

## 6. 本輪已調整及後續

**第一階段已實作。** HTTP／WS 回覆歸屬／SG 還原／解析失敗不再直接中斷；工具正確性與本地執行安全維持。HTTP SSE 三種 adapter 共用有界原始事件交易、錯誤／取消與降級接續政策。

`wireProtection: false` 已增加 scoped hook-only；未知 route／SDK 的 injected fetch 只有相關 host 遮罩成功才降級。缺 fetch／私有 transport 不自動獲准。true 保留出站檢查；省略值仍等同 true。

大型內容、編碼敏感值及複雜 shell 應補有界分段、完整片段遮罩或安全 adapter，不能用原值放行及取消安全檢查換成功。附件 allow、持久化與 Keychain 不隨「體驗優先」自動啟用。

大內容分段、編碼區間遮罩與新工具 adapter **尚未實作**。完整狀態見 [政策方案](../plans/2026-10-11-experience-first-policy.md)及 [本輪驗證](2026-10-11-experience-first-verification.md)；沒有重新安裝或重啟共用服務。

## 來源及確定性

**已驗證於現行程式：** `src/opencode.ts`、`src/plugin-options.ts`、`src/opencode-transparent.ts`、`src/opencode-transparent-http.ts`、`src/opencode-transparent-stream.ts`、`src/opencode-transparent-ws.ts`、`src/opencode-transparent-aisdk.ts`、`src/decision/pseudonymization.ts`。

**實際發生／已實測：** WS 缺歸屬的服務日誌；重啟舊 token 的工具拒絕；目前本地 HTTP／WS 正常工具迴路。詳見 [最新三方比較](2026-10-11-official-rehydra-v2-comparison.md)。

**未解決：** 真實 WS 為何失去歸屬、所有舊實例是否均已卸載、長時間對話的拒絕／降級頻率。本輪修改工作樹政策，沒有重新全域啟用；本地故障注入不是線上根因證明。
