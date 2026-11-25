# 唯讀 env 查詢（選擇性開啟）

> 🌐 [English](./env-queries.md) | 繁體中文

[← OpenCode plugin](../opencode.zh-TW.md)

`envQueries` 選項（預設 `false`）針對 `settings.env_files` 所列檔案提供三個唯讀工具，讓 agent 能回答設定問題而不看到任何 value。這個選項是給 `block` 與 `redact` 模式用的。在 transparent 模式（未設定 `mode` 時的 v2 預設）下會被忽略：plugin 照常啟動，但不註冊這些工具，會記錄一則警告，`--doctor` 也會顯示 warn。transparent 模式下 agent 可以改為直接讀 env 檔，但遮蔽並不完整：8 字元以上的 value（以及掃描規則偵測到的內容）會換成穩定的佔位符，`PORT=3000`、`DEBUG=true` 這類較短的 value 會原樣出現，也只有被遮蔽的 value 能透過佔位符比對是否相同。若 env 檔內容不能進入對話，請搭配 `block` 或 `redact` 使用 envQueries：

| 工具 | 契約 |
|---|---|
| `guard_env_list` | 回傳不透明、僅限當前 session 的 file id 與 key 名稱——永遠不含路徑、value、長度或預覽。 |
| `guard_env_inspect(file_id, key)` | 回傳 `missing` \| `empty` \| `nonempty`；非空時再給粗略詞彙形態 `boolean_like` \| `number_like` \| `multiline_text` \| `text`。形態只是提示，不代表該值是有效的布林或數字。 |
| `guard_env_compare(left_file_id, left_key, right_file_id, right_key)` | key 對 key（同檔或跨檔）相等性比較，回傳 `equal` \| `different` \| `unavailable`。缺少的 key 或無法讀取的檔案回 `unavailable`。 |

```jsonc
{ "package": "/絕對路徑/leakshield/dist", "options": { "mode": "block", "envQueries": true } }
```

## 基本規則

只有 `settings.env_files` 內的檔案可查（最多 16 個、各 1 MiB）。file id 只在列出它的 session 有效。每次呼叫都重新讀檔，比較的兩個運算元取自同一份單次呼叫快照。

任何輸出都不會出現原始 value、value 長度、預覽、指紋或反查映射。若 setup 後 guard 設定檔變更，工具會回傳固定的「請重啟」錯誤直到 OpenCode 重啟——絕不悄悄退回新舊任一份授權。

## 檔案存取

檔案存取採「盡力而為的路徑身分驗證」，不是 sandbox。Workspace root 在 setup 時凍結（解析後的路徑加上 device/inode 身分）；每次查詢都會在開檔前與讀取後重新 lstat root 與每個祖先目錄、拒絕任何路徑元件上的 symlink（包括解析到別處——即使仍在 workspace 內——的祖先目錄 symlink）、要求一般檔案、以 `O_NOFOLLOW` 與 `O_NONBLOCK` 開啟完整解析後的 canonical 路徑，並以讀取前後的 size/mtime 檢查把開啟的 descriptor 綁定到 lstat 過的 inode。限制（據實以告）：同一擁有者的惡意並發檔案系統變動不在本威脅模型內——在兩次檢查之間替換又還原（ABA 競態，發生在 root、祖先目錄或檔案上）無法靠路徑檢查偵測；hardlink 與原始檔案不做區分（不檢查出處）；保留 size 與 mtime 的就地覆寫無法分辨；且 agent 仍可透過其他工具修改 env 檔案——因此結果描述的是檔案當下狀態，而非可信任的基準。

key 名稱本身照原樣回傳，並照常通過既有的輸出／歷史保護。
