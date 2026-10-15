# Transparent 容量與 session 回收修正驗證

日期：2026-10-14。範圍：目前工作樹的 OpenCode V2 transparent plugin；保留既有未提交變更，不 commit／push。

**後續更新：** 已依使用者授權補做 [實機與 native 刪除重測](2026-10-14-live-capacity-and-lifecycle-retest.md)：回收通過，但原長歷史仍因 `invalid_encrypted_content` 失敗，另有可重現的 opaque-state 改寫 red。下文是先前容量修正的驗證紀錄，不代表最新整體驗收已通過。

## 結論

**本地可重現的兩項限制已修正：** 約 104 萬字元的分段歷史不再套用 standalone core 的小操作預算；同一 guard 的第 129 個 mapping session 可正常使用，且舊 mapping 保留。正式 `session.deleted` 事件會回收該 session 的 RAM、回覆準備證明及 WS 緩衝。

**這不是全面穩定宣告。** 仍有有限容量及單字串 scanner 限制，不能接受任意大小的歷史；原真實模型歷史分叉尚未重跑。沒有新增原文 fallback、任意 LRU 丟 mapping、持久化 opt-in、Keychain 存取或全域 enablement。

## Red → green

先新增 `tests/opencode-transparent-capacity.test.ts`，以目前 source 的公開 `session:context`、HTTP／WS 和 `tool:execute.before` hooks 建立本地回歸，不呼叫真實模型。

初次執行：

```sh
npx vitest run tests/opencode-transparent-capacity.test.ts --reporter=verbose
```

結果 **6 failed／1 passed**：

| 案例 | 修改前 | 修改後 |
|---|---|---|
| 約 104 萬字元的歷史＋最後一則合成 email，wire=false／true | `prepare.mask / operation_limit` | 全部一般文字保留；最後 email 被遮罩且工具可還原 |
| 同 guard 超過 128 個 mapping session | 第 129 個 `session_limit` | 140 個通過；第一個 mapping 仍可還原 |
| 收到某 session 的正式刪除事件 | 仍可用該 session 的 RAM mapping 還原 | memory-only 下該 mapping 不再可還原；其他 session 不受影響 |
| 填滿有限 session 容量，刪除一個後建立替代 session | 先被 128 個 core 上限擋住 | 4,096 個可用；第 4,097 個原子拒絕；刪除一個後替代 session 可用 |
| dispose 中止 lifecycle 訂閱 | 沒有訂閱／abort | 訂閱收到 abort，iterator 結束 |
| 明確超過總操作預算 | 原子拒絕 | 仍原子拒絕，不部分發布，不破壞既有 mapping |

另補驗證：

- 超過 10,000 nodes 的合法內容可遮罩；超過新 node ceiling 或深度 32 仍原子拒絕。
- 長歷史通過真正的 final HTTP request hook；最後新增的合成 email 也被重新遮罩，非只檢查 early hook。
- `session.idle`／execution completion 不回收 mapping，避免破壞後續 resume。
- 刪除只清該 session 的 WS lane／held prefix，名稱相近的另一 session 仍可跨 frame 還原。
- event stream failure 保留 live mapping、不中止保護；WARN 不輸出原始錯誤或 email。
- 刪除不等同 durable `forget`：加密 store 的既有 row 保留，其他 live session 正常，第二個 guard 仍可依原 TTL／hydration 政策還原保留資料。測試注入合成 key，不使用真實 Keychain。

## 實作與安全邊界

### 操作預算

`src/opencode-transparent.ts` 的 transparent profile 設定：

| 限制 | 本輪後的 transparent guard | 本輪未變的邊界 |
|---|---|---|
| 操作 work units | 輸入＋輸出合計 8 Mi UTF-16 units | 仍先計費、超限拒絕；不是 process RSS 保證 |
| JSON value nodes | 100,000 | 仍有有限 ceiling |
| Session tracking／mapping sessions | 每 guard 4,096 | 無 live-mapping LRU eviction |
| HTTP body／WS frame | 4 MiB | unchanged |
| 單字串掃描 | guard config 的 `max_chars` | unchanged；超限不截斷後假稱安全 |
| JSON 深度 | 32 | unchanged |
| Mapping entries | 每 session 4,096／總共 65,536 | unchanged |
| Mapping units | 每 session 2 Mi／總共 16 Mi UTF-16 units | unchanged；保守計費，不是實際 RSS |

8 Mi units 是配合既有 4 MiB wire body／frame 與 input＋output 雙份計費選定的有限 guard 預算，不是移除保護上限或判定實機歷史的通用安全門檻。standalone `createPseudonymizer` 預設保持 1 Mi units／10,000 nodes／128 mapping sessions；CLI／其他 profile 不因本輪改用較大的 guard profile。

`operation_limit` 目前仍合併深度、node 與 units 等原因；本輪沒有宣稱已細分原實機錯誤的全部計數條件。guard tracking 超限另附靜態 `stage=session.track reason=session_limit`，不輸出 session 內容。

### Lifecycle

使用已安裝 V2 SDK 的公有 `ctx.event.subscribe({ signal })`。已核對 `SessionDeleted` schema：`type: session.deleted`、`data.sessionID`。只處理這個正式事件且只回收本 guard 已追蹤的 session，不把 idle、execution completion 或 interruption 推論成刪除。

- 刪除清理 core RAM、prepared scopes、WS lanes／buffers 及 per-session persistence bookkeeping。
- HTTP／WS 入站不藉未追蹤的舊 scope 重新 hydrate mapping；沒有新的跨 session／model 還原。
- stream 是選擇性的回收能力，不是保護前提。缺少／失敗時維持有限 retention，不放行未遮罩內容。
- dispose abort 訂閱；既有 fail-closed、工具安全與持久化 TTL／CAS／explicit forget 政策保持。

參考：[OpenCode V2 plugins](https://opencode.ai/v2/docs/build/plugins)、repo lockfile 對應的 `@opencode/plugin`／`@opencode/client` declarations。

## 完整測試與編譯

```sh
npm test -- --reporter=dot
npx tsc --noEmit
npx tsc
git diff --check
```

- **43 test files／946 tests passed**，相較修改前 933 tests 新增 13 案。
- TypeScript、直接編譯與 whitespace check 通過。
- 直接 `tsc` 更新 `dist`；沒有執行會先刪除整個 `dist` 的 clean/build script。
- 沒有新增 `DEBUG-` production instrumentation。

## 真實 OpenCode host＋本地模型替身

Host：**OpenCode v2.0.28**。使用編譯後的 `dist`，隔離 HOME／XDG，合成認證、本地模型 endpoint；不繼承使用者 provider 憑證，不修改全域設定。

```sh
node scripts/e2e/run-responses-ws.mjs
```

| 案例 | 結果 | 原合成敏感值未出站 | 工具內容正確 | Primary requests | WS connections |
|---|---|---|---|---|---|
| HTTP hook-only | PASS | 是 | 是 | 4 | 0 |
| HTTP wire | PASS | 是 | 是 | 4 | 0 |
| WS hook-only | PASS | 是 | 是 | 4 | 1 |
| WS wire | PASS | 是 | 是 | 4 | 1 |

四案都無 timeout，工具結果持續回放／遮罩通過；runner exit 0。這是既有正常工具流程的 host 回歸，不冒充實機長歷史或正式刪除事件 delivery 驗收。

本機保留的合成 evidence：`$TMPDIR/opencode/sg-ws-tools-XevZxV/summary.json`。

## 變更檔案與剩餘限制

- `src/opencode-transparent.ts`：有限 guard profile、正式刪除回收、入站 scope 保護。
- `src/opencode-transparent-ws.ts`：精確 session lane 清理及 buffer 計費釋放。
- `tests/opencode-transparent-capacity.test.ts`：新回歸與安全 ceiling 測試。
- `tests/opencode-transparent-hook-only.test.ts`：超限 fixture 對齊新的有限預算，保留 refusal／atomicity 驗證。
- `tests/transparent-persistence.test.ts`：刪除只回收 RAM、不誤刪 durable mapping 的驗證。
- `README.md`／`README.zh-TW.md`／transparent spec：記錄預算、刪除與 retention 邊界。

**未驗證／未做：** 原真實模型歷史分叉、真實 Keychain、實際 host 的刪除事件 delivery／長期效能、所有 provider 矩陣、全域 enablement／共用服務 restart 或 reload、commit／push。

4,096 個未刪除 session 仍會到容量上限；事件流故障也不會憑空回收 live mapping。單一過長字串、超深 schema、極大總歷史、未知 transport、unsafe tool restoration 等既有拒絕仍可能發生。若要宣稱原本的實機長對話已恢復，仍需另外重新載入並重跑該歷史，不能以本地測試 green 替代。
