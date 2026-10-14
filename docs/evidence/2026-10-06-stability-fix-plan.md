# Transparent plugin 穩定性修正清單

日期：2026-10-06
目標：在已驗證支援範圍內，提供類似 Rehydra OpenCode plugin 的安裝與正常對話體驗，同時保留出網前防護。本文是工作清單，不代表實作完成或發布就緒。

## 已確認設計決策

- 借鑑 Rehydra plugin 的記憶體 mapping／原文重播方式，不改成 hooks-only。
- 本機 history 保存原文；mapping 僅存記憶體。重啟後由原文重播重新遮罩並建立 mapping。
- 既有對話重啟後無感接續是必要驗收，不以開新對話或提示重讀替代。此方案尚需證明完整還原與 provider continuation 相容。
- 保留現有 HTTP wire 防護並修通 GPT。暫不新增加密 mapping 持久化、proxy 或 WS adapter。
- 新協定與擴大 AI SDK／WS 覆蓋列後續待辦，詳見 [wire 盤點](2026-10-06-opencode-wire-inventory.md)。未支援路線仍明確拒絕。

## 1. 已知狀態

| 項目 | 狀態 | 證據／限制 |
|---|---|---|
| NDA 子字串誤判 | 已有字界修正與回歸測試 | `Foundation`、`agenda` 不命中 NDA；真正 NDA 與 CJK 關鍵字仍命中。尚需端到端遮罩驗證與服務載入新版確認 |
| Config 範例 | 已調整，測試衝突已修正 | 空 NDA 陣列合法；缺省 fallback 值仍有獨立測試 |
| GPT transport | 本地 HTTP 已驗證，真實認證待驗 | native OpenAI HTTP preference 可卸載；明確 WS config 會覆蓋並被拒絕，不宣稱可強制覆寫 config |
| GPT 回覆 | 本地 C19 與 native identity 往返通過 | 主請求與顯示還原皆成立；初次錯誤是明確 WS 配置造成，不是已證明的 response parser 缺陷 |
| 可見 token | 有實際事件 | 參考 session `ses_eef9c5755ffecoT3FQNvbiNwAS` 的 reasoning 與 websearch input 含 token；確切還原／執行缺口尚未完成因果追蹤 |
| 重啟恢復 | 未證明可靠 | mapping 在記憶體；history 已持久化 token 時，重新啟動不能假設仍可還原 |

重要更正：live log 的共用拒絕字串不能區分 WS 或 AI SDK。固定版本 OpenCode source 的 native OpenAI 預設為 WebSocket；配置中的 SDK 名稱也不等於實際路線。必須依實際 hook／transport 證據判断。

最新驗證與剩餘限制：[HTTP recovery verification](2026-10-07-http-recovery-verification.md)。全套 644 tests 與 typecheck 通過；八個本地 E2E 案例通過各自驗收，但不等於所有流程完整回覆／真實認證通過。

## 2. 按優先級修正

### P0-A：定位 GPT stream 失敗，完成 HTTP 相容性

- 先由 reviewer 接手 [第一次失敗交接](../../.scratch/handoff-20261006-gpt-plugin.md)，取得新的診斷與驗證計畫，再續修。
- 找出 nested cause，區分 capture fixture、guard response rewrite 與 host Responses consumer 的相容問題。
- 驗證 provider transform 的載入順序、reload、卸載及設定覆寫效果；確認 endpoint、認證與其他 provider 不受誤改。
- 分別驗證 OpenAI API key 與 ChatGPT 訂閱認證；不能將一種認證的成功外推到另一種。
- 保留 WS／真正 AI SDK 未支援路線的拒絕。不得以移除拒絕或原樣放行掩蓋失敗。

驗收：本地 C19 完整退出成功，request 遮罩與 response 還原皆有證據；其後真實 GPT 完成多輪、串流與工具呼叫。只有 HTTP capture 不算完成。

### P0-B：讓錯誤能被看見、定位與恢復

- 分開 WS handshake/send/receive 與 AI SDK sdk/language 的固定診斷代碼。
- 在可見錯誤中呈現拒絕類型及有效下一步；WARN log 僅為輔助，不能是唯一通知。
- Request 保護錯誤區分數值、結構、序列化、操作限制等原因。
- 診斷只使用受控代碼與安全索引；不得包含 prompt、命中值、任意 JSON key/path、URL、headers 或未經評估的 identifier。

驗收：使用者能區分「改內容可重試」與「路線不支援，重試無效」；診斷通道本身不洩漏敏感資料。

### P1-A：完整還原與工具執行

- 追蹤 reasoning、文字與 tool-call arguments 從 wire → host → UI／store → tool execution 的流程。
- 釐清該 session 的 `executed:false`；不能單憑 DB 狀態判定 guard 阻擋或工具外送成功。
- 確認哪些欄位應還原、在哪層還原，以及重播時如何再次遮罩。不要盲目還原整個 response JSON。
- 工具仍保留 shell 安全、未知 mapping 與寫入／外送限制；hosted tools／MCP 覆蓋需明示，不直接宣稱全涵蓋。

驗收：已支援工具取得預期原始參數並成功執行；顯示內容沒有非預期 token；持久化與後續重播符合明確的資料策略。

### P1-B：重啟、resume、revert／redo 的恢復策略

- 驗證已選 mapping 生命週期：原文只留本機、mapping 僅存記憶體，重啟後由原文重新遮罩；排除依賴舊 mapping 的持久化 token。暫不保存敏感對照表。
- 驗證正常續聊、服務重啟、插件 reload、resume、fork、revert／redo。
- 驗證 revert 是否真的排除下一次模型 context 的問題內容，而非僅 UI 隱藏。
- 明示恢復邊界：內容 trigger 可藉回退／修改解除；路線拒絕不能靠換新對話解除；mapping 遺失不能靠 redo 自動恢復。
- 不新增直接修改 session DB 的修復指令，除非另行批准資料安全與備份流程。

驗收：正常重啟後，既有對話與已支援工具無感接續且正確還原。異常／損毀可以明確拒絕，但不能用拒絕或重開對話替代正常重啟驗收；其他支援的生命週期操作也需實證。

### P1-C：修正測試與驗收閘門

- 修正 `tests/config.test.ts` 非空 NDA 斷言：明確 `[]` 合法；缺省預設值用獨立測試驗證。不要為了讓測試通過重新啟用示例規則。
- 增加 Foundation／agenda 在實際 request 防護管線中保持原文的測試，搭配 standalone NDA 的正向控制。
- C19 等必要案例的 `observe`、缺少回覆證據或子程序失敗，必須阻止通過；harness exit 0 不應被當成完成。
- 測試矩陣區分協定、transport、認證方式與 host 版本；包含 title、compaction、重試、多輪與工具迴路。

驗收：相關測試、typecheck、全套測試與必需 E2E 閘門均通過；真實 provider 驗證獨立列出，不以 mock 替代。

### P2：文件與三家比較校正

- 更新 [三家比較](2026-10-05-three-way-comparison.md)：三家指 VibeGuard、opencode-vibeguard、Rehydra，不是模型／CLI 平台。
- 將「體驗與無保護時無差異」限縮為已通過的指定 host／本地案例；補上 GPT、可見 token、重啟恢復的現況。
- README 列出支援的協定、transport、認證與版本，以及拒絕與恢復方法。
- 不將「未證明覆蓋」直接等同「靜默洩漏」；不宣稱同類產品不存在，也不將三家的 source 能力當成本環境實測結果。

## 3. 暫不做

- 不新增 proxy／MITM／CA 安裝。
- 不新增 fail-open 的 `allowUnsupportedRoutes` 逃生口。
- 不順手修改 private-domain 匹配或做其他無關重構。
- 不自動重啟服務、修改全域 provider 設定或 commit。

只有實證顯示 host 無法提供必要安全攔截點時，才另行評估 proxy；不是目前預設修法。

## 4. 執行順序與完成定義

1. Reviewer 診斷 GPT 首次失敗；診斷不足時先補安全錯誤識別。
2. GPT HTTP 完整往返、必要驗收閘門與 config 測試修正。
3. 完整顯示／工具還原。
4. mapping 生命週期與 revert／redo 恢復策略。
5. 真實 provider 矩陣驗證後同步文件。

**穩定替代品的門檻**：已公布支援範圍內，正常對話、工具迴路與 session 恢復可靠；保護失敗可見且可處理；沒有以靜默放行換取成功。任何未驗證項目不得以「已修正」或「裝好就無感」呈現。
