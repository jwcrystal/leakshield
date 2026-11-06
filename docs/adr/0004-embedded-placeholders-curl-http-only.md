---
status: accepted
date: 2026-11-06
---

# 只有 `curl`、`http` 允許參數內嵌 placeholder；`wget` 與 `rtk curl` 維持完整單詞規則

shell 還原的預設規則是：placeholder 必須是完整的參數單詞。只有第一個詞是未加引號的 `curl` 或 `http` 時，placeholder 才能放在參數內部，例如 `-H 'x-api-key: <placeholder>'`、`-u user:<placeholder>`（#78）。實測中，模型帶金鑰呼叫 API 時都用 `curl`。

`wget` 被**刻意排除**。它的 `-e`／`--execute` 會再交給 wgetrc 解析，值可以改變它上傳的檔案（例如 `post_file`）。Codex 連續三輪在縮寫、數字組合旗標（`-4e`）上找到繞過，繼續修補等於逐一列舉另一個程式的選項語法。因此 `wget` 回到完整單詞規則，`wget -e` 則一律拒絕。

`rtk` 被視為包裝命令，依它**實際執行的命令**判斷（#79）。會再執行其他命令的子命令（`run`、`proxy`、`pipe`…）一律拒絕。`rtk curl` 不適用內嵌規則，因為 rtk 會把命令列以明文寫進本機歷史資料庫。

## Consequences

- `wget --header='x: TOKEN'` 不能用，要改用 `curl`。`curl`、`http` 也可能有類似的二次解析選項，不能視為已完全驗證。
- `RTK_COMMAND_RUNNERS` 取自 rtk 1.1.0 的 `--help`，rtk 新增 runner 時會漏判，需要隨版本更新。
- 如果環境中 rtk 的 OpenCode 外掛會把 `curl` 改寫成 `rtk curl`，內嵌 placeholder 就會失效。使用者可以在 rtk 設定的 `exclude_commands` 加入 `curl`。
