# 對話優先：Shell 修正與 WS 支援建議

日期：2026-10-11。使用者要求：優先不妨礙正常對話、修正已重現問題，並建議功能／設定如何調整。

更新：使用者已授權實作。Native Responses-family WS adapter、共用 wire 開關與持久化狀態提示已完成；[最新驗證](../evidence/2026-10-11-responses-ws-verification.md)區分公開 hook 測試、真實 host／本地模型捕獲及尚未驗證項目。未更改全域設定或存取真實 Keychain。

後續 SDK 修正：已移除 AI SDK 初始化的一律拒絕，支援使用 host injected HTTP fetch 的 SDK。另修正 Responses easy-input 與 SDK guard 拒絕誤重試；[SDK 驗證](../evidence/2026-10-11-aisdk-http-verification.md)記錄 863 tests、三種 SDK 的實際 host 工具迴路，以及 Go／legacy 仍不支援的界線。

## 結論

常見工具參數還原已修正；**已按協定加入 native Responses-family WebSocket，不按 OpenAI 品牌限制**。其他協定仍需獨立 adapter，不直接移除守門。HTTP／WS 共用 `wireProtection` 選項；普通對話與工具已在本地捕獲測試完成，不以新增 NER／廣泛規則作為本輪優先事項。

證據：[隔離 A/B 實測與修正驗證](../evidence/2026-10-11-rehydra-v2-usability-comparison.md)。

## 1. 本輪已完成

- 完整單／雙引號參數、單一結尾靜態 `>`／`>>` 不再僅因語法被拒；引號語意與原值完整性仍檢查。
- 引號 command/flag 不得繞過 inline-script／wrapper 守門。
- 不放寬未知 mapping、quote-breaking、option injection、管線、展開等未支援語境。
- 819 tests、build、18 個真實 host／本地模型替身成功案例驗證；不是外部真實 provider 驗證。
- 原倉庫已安裝既有 lockfile dependencies 並重建 `dist/`；未修改全域 provider 配置或重啟現有背景服務。

## 2. 現在的設定建議

| 設定 | 建議 | 原因／限制 |
|---|---|---|
| native OpenAI transport | 保留既有 HTTP preference；明確 WS 設定現可使用已支援的 Responses-family 路線 | explicit config 仍優先；不修改使用者全域設定，也不宣稱所有 WS 協定已支援 |
| `wireProtection` | 保留既有選擇，不為修 shell 再降級 | 本輪 true／false 均能完成 shell 與基本對話；false 仍不遮罩 late-added body，true 保留 final-body 防護 |
| `persistence.enabled` | 常重啟續聊的個人使用建議 opt-in 開啟，先維持 7 天、不啟用 keyfile fallback | 注入測試 key 的 native host 案例成功；真實 Keychain、啟動延遲與個人備份政策仍待驗，尚未替使用者啟用 |
| NER／模糊偵測種類 | 暫緩增加 | 先降低操作阻礙，不增加誤遮罩、延遲與模型部署成本 |

不修改現有 `mode: block/redact`、wire choice 或 mapping retention 的預設與遷移契約。

## 3. WS 最小範圍與後續驗收

先支援 **native Responses-family 的已驗證 frame 形狀**，不依 provider 品牌拒絕相容實作。但不同 Responses extensions 仍須驗證，不能僅憑名稱或 URL 宣稱相容。其他 WS 協定透過獨立 adapter 擴充；不把「WS」等同所有 provider／AI SDK 協定。

1. `experimental.ws.send`：保護每次 `response.create` frame 的文字、工具描述／參數與 replay 內容；遵守 attachment policy，識別結構與不透明 provider state，不盲改整個 JSON。
2. `experimental.ws.receive`：分 session、請求種類、模型，再按 response ID 與內容 part 保留 tail buffer，支援跨 frame／delta 占位符還原；工具參數仍由本地 tool-before gate 安全還原。Host 不提供 connection ID，不能聲稱獨立驗證了實體連線歸屬。
3. 不只還原入站：EightDoor 可借鑑 tail-buffer 技術，但其 system 遮罩缺口不能照搬；send 邊界須涵蓋內容 hooks 後新增的資料，並保留 session 歸屬檢查。
4. Mapping loss 的顯示文字保持 literal＋可見診斷，不讓整個回答因占位符本身中斷；副作用工具的正確還原要求不變。
5. 重用連線、重試、取消、terminal frame、HTTP fallback、舊 response state 與多 session 不得混資料。
6. 未知 frame／協定不得原樣送出敏感內容。優先在設定／健檢時給支援狀態；fallback 若採用，須保留同等防護，避免重送已部分完成的請求或重複工具副作用。

### 建議推進順序

- 先以 opt-in WS 支援跑和 HTTP 相同的本地 capture／工具正確性案例。
- 通過既有範圍的 WS 主對話、title、compaction、重用／重啟與工具迴路後，再評估是否撤除 native OpenAI 的 HTTP preference（現況不是強制覆寫，explicit config 仍優先）。
- 擴大預設前，支援範圍與未驗證項目需明示；不另擅自加入「所有真實 provider 都通過」的發布閘門。

已解除 native Responses-family WS 的一律拒絕；未知 WS 路線／frame與錯誤 attribution 仍拒絕。後續 SDK 修正已允許 injected-fetch HTTP 路線，不能再概括為所有 AI SDK 都拒絕。現有 HTTP preference 與使用者設定未改。公開 hook 已覆蓋四種請求種類及 HTTP fallback 狀態失效，但完整 WS compaction、真實認證、實際 host retry/fallback 與取消恢復仍待驗。

## 4. Wire 設計評估：保留選項，不把 transport 相容性當成防護證明

結論：**保留 `wireProtection` 作為額外出站內容掃描的開關；transport 適配與回覆還原不隨開關關閉。** HTTP／WS 正常工作只證明相容性，不能證明 content hooks 之後新增的原值不會外送。

這張表區分功能與開關，避免把「不再掃最終 body」誤解成「完全不使用網路 hooks」。

| 職責 | `wireProtection: false` | `wireProtection: true` |
|---|---|---|
| content hooks 遮罩、工具執行前安全還原 | 保留 | 保留 |
| 支援路線／metadata 檢查、session 歸屬 | 保留 | 保留 |
| HTTP 回覆／SSE 還原 | 保留 | 保留 |
| 最終 HTTP body 驗證／再遮罩 | 不做 | 做 |
| 已支援 WS 的入站 frame 還原／狀態關聯 | 保留 | 保留 |
| 已支援 WS 的最終出站內容驗證／再遮罩 | 不做；仍解析 envelope 與檢查大小 | 做 |

**已驗證：** `src/opencode-transparent.ts` 的 `onHttpRequest` 在 false 時仍走 `admitModelRequest` 並建立 attribution；`onHttpResponse` 無論開關都走 `restoreModelResponse`。WS adapter 在兩種設定都執行 metadata／envelope admission 與顯示還原，只有 true 再遮罩最終 frame 內容。省略選項仍維持 true；沒有新增各 transport 一套開關。

**已核對官方契約：** content hooks 之後可套用 raw HTTP body overlays；後載入 plugin 的 hook 也能再修改內容。WS frames 不經 HTTP hooks。這些是額外出站防線仍有價值的原因。

**設計建議：** transport adapter 負責 HTTP/SSE 或 WS framing；protocol adapter 負責哪些欄位是文字、工具參數或 opaque state；共用 policy 決定是否掃描最終出站內容。收斂在同一個深 module 內，不讓呼叫端各自處理緩衝、mapping 與拒絕規則。沿用一個開關，不另增加 HTTP／WS 各一套開關。

此處的 wire protection 只涵蓋插件可攔截的模型流量，不是系統網路防火牆，不會自動涵蓋 shell 自行連線、遠端 MCP 或所有工具外送。掃描也只覆蓋既定規則與已支援內容，不保證辨識所有敏感資訊。

只有將來 host 提供可信的最終語意內容 hook，且證明所有入口、後續修改與回覆還原都受涵蓋，才值得評估移除獨立 wire 掃描；「HTTP 與 WS 都能聊」不足以支持刪除。

## 5. 持久化與 NER 評估

### 持久化

**建議：** 個人環境常重啟續聊，opt-in 啟用既有持久化，不改全體使用者預設。建議的 plugin options 片段如下，尚未套用到設定：

```json
{
  "persistence": {
    "enabled": true,
    "ttlDays": 7,
    "keyFile": false
  }
}
```

收益是讓已保存的同 session 映射跨 process 還原，減少為了舊 token 重讀／重寫工具參數的操作。它不修復已經遺失而從未持久化的映射，也不自動保證 fork、所有 provider continuation 或跨機搬移。

**已驗證：** 舊報告的 native host 重啟＋注入合成 key 案例成功。本輪重跑 `mapping-store`、`mapping-key`、`transparent-persistence`、`doctor` 四個 test files，共 67 tests 通過。未讀寫真實 OS keychain。

**已核對實作限制：**

- DB 原值採 per-entry AES-256-GCM，AAD 綁 session＋token；session/token 等 metadata 不等同全部加密。持久化不是整機資料保護。
- OS keychain 主要提高離線 DB 竊取的門檻，不防同登入身份的惡意程式。keyfile fallback 預設關閉，同目錄／同備份帶走 DB＋key 的風險較高。
- TTL 清理在 writer 開啟 store 時執行；保存 mapping snapshot 會更新到期時間，單純讀取不延長 TTL。長期開啟的 process 沒有定時清理，7 天不是嚴格刪除期限，也不是「最後聊天後 7 天」。
- 清除／TTL 不能收回 Time Machine 或雲端備份。不要將 `ttlDays: 0` 作為方便續聊的預設建議。
- keychain／store 失效會降級 memory-only，不因持久化失敗直接拒絕對話；但舊 token 的副作用工具仍可能因未知 mapping 被拒。
- keychain 存取採同步子行程，每次 timeout 10 秒；有啟動延遲／權限提示風險。首次建立金鑰的多 process 競爭仍有已記錄的殘餘窗口，不能宣稱完全無感。
- `doctor` 不讀真實 keychain，也不驗證解密；現在對已設定持久化標示 WARN／runtime 未驗證，不再僅憑 DB 可讀顯示 ok。Runtime 成功開啟 store 時記錄 active 與實際 key source；降級另有 WARN。

**待驗：** 若使用者決定啟用，先在授權下驗證真實 Keychain 的重啟還原、實際 key 來源／降級狀態及啟動延遲，再以合成資料跑一次本機 restart 工具還原。不要僅檢查 DB 存在，也不替使用者排除備份或更改保留政策。

### NER

NER（命名實體辨識）補的是姓名、地名、組織等語意識別，不補 transport 遮罩缺口或映射遺失。

**建議：** 暫不啟用，優先度低於 WS 相容性與 restart 恢復。需要補人名等漏偵測時，再評估本機、opt-in、限定類別的 NER；不要把整段未遮罩內容送到第三方 NER 服務。限定類別可降低模型／程式碼名被誤遮罩的機會，但改善幅度未量測。

**待驗：** 尚未選模型或執行 NER benchmark，不能宣稱中英混合的準確率、延遲、記憶體成本或工具可用性改善。應用既有真實失敗類型與合成語料測漏偵測、誤遮罩、延遲和工具成功率後再決定，不先擴大預設偵測範圍。

## 參考

- [OpenCode V2 plugins 官方契約](https://opencode.ai/v2/docs/build/plugins)：model request、raw body overlays、native HTTP／experimental WS hooks（線上文件，不等於所有 runtime 版本相同）。
- [既有 hook-first 行為與限制](../evidence/2026-10-07-hook-first-verification.md)。
- `src/plugin-options.ts`、`src/opencode-transparent.ts`、`src/decision/mapping-key.ts`、`src/decision/mapping-store.ts`、`src/doctor.ts`。
