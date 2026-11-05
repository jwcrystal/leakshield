# Transparent 模式

> 🌐 [English](./transparent-mode.md) | 繁體中文

[← README](../../README.zh-TW.md#opencode-plugin建議使用)

## 透明假名化

僅限 OpenCode v2，v2 預設。

不設定 `mode` 或設定 `"mode": "transparent"` 時，偵測到的敏感值會在模型請求快照中替換為穩定的不透明佔位符——帶類別的 `[SGP2:<TYPE>-xxxx-xxxx-xxxx]`（仍辨識舊 `[SGP1:…]` 映射）。反查映射預設僅在行程記憶體、以 OpenCode session 為界；持久化 opt-in。已知佔位符在工具執行前及支援的助理顯示文字中還原。

HTTP adapters 支援按路徑形狀判別的 Chat Completions、Anthropic Messages、Responses（含串流），另支援 native Responses-family WS；不依 provider 品牌設 allowlist。Hook-only 保護 content 快照，不設出站傳輸守門，也不為未知協定新增 adapter。失效或不安全的工具還原仍拒絕該次操作。

本機歷史、日誌與檔案可能含原文——保護的是模型邊界，不是磁碟。transparent 目前在 loopback provider 和一個真實 OpenAI 模型上驗證過；OS keychain 只驗證過 macOS，真實 Anthropic provider、其他 provider 的長歷史重播，以及 Windows／Linux keychain 都還沒驗證（[#26](https://github.com/jwcrystal/leakshield/issues/26)）。無法保護的路線會被拒絕，不會放行。

## 編碼內容與 tool schema

transparent 模式下，Base64、hex 或 URL 編碼片段解碼後若有命中，且能精確定位來源範圍，會整段遮罩為 `[SGP2:ENCODED-…]`；無法定位時則拒絕該次請求。

transparent 模式下，tool input schema 內的注解文字（`description`/`title` 的值）若命中掃描規則，會與一般內容一樣遮罩為化名 token；識別碼位置（tool 名稱、property key、enum/const 值、regex pattern）仍會拒絕整個請求而不會被改名。

## Shell 參數還原

macOS／Linux 的 POSIX shell 支援占位符作為完整的未加引號、單引號或雙引號參數；保留原引號，並檢查原值不會破壞該引號語境，含空格的原值仍是一個參數。支援單一、結尾的 `>`／`>>`，目標須為靜態字面檔名。命令／變數賦值位置、帶 token 的重新導向檔名、展開、引號拼接、管線、inline script、會跳出引號或以 `-` 起始的原值，仍在修改參數前拒絕該次工具呼叫。

不含 token 的命令不受影響。Windows 不啟用新增的引號／重新導向支援；這不是通用 shell parser。`wireProtection` 的兩種設定不會改變此工具防線。還原規則以欄位為單位：shell 工具（內建名單，或工具名稱含 `bash`、`shell`、`zsh`、`pwsh` 等片段）的所有欄位都套用 shell 規則；任何工具中名稱像指令的欄位（`command`、`cmd`、`commands`、`argv`、`shell` 等）也套用。名為 `code`、`script` 等的欄位中，只有符合受限單行字串規則的 placeholder 才會被還原。這是保守的啟發式判斷，不是跨語言的語法驗證，既可能誤拒，也可能漏判。被拒絕的呼叫是被擋下而非被遮蔽：工具不會執行，輸入中的 placeholder 維持原樣。會被拒絕的形式包括：裸 placeholder、插值區域（`f"{...}"`、`${...}`、`$(...)`）、反引號字串、多行字串（含任何含三引號的行）、反斜線續行之後的行、註解，以及原文含有 shell 不安全字元（包含空白）者。賦值上方有成對 docstring 的腳本仍可運作。改寫方式：把 placeholder 放進不含插值的一般引號字串，並寫在單獨一行，且該行不在任何多行字串或續行之內（`value = '<placeholder>'`），再引用該變數。這不是外送防護：程式仍可印出、傳送或重新解讀還原後的值，且未列出的語言結構（例如 Ruby 的 `%q`）可能被誤判。說明類欄位（`description`、`title`、`label`）與其他欄位直接還原。使用其他欄位名稱的執行型工具不會被偵測。shell 工具名單內建於 LeakShield 原始碼，無法設定。

## 重啟限制

兩種層級共通。

重播的原文可以建立新映射，但舊 token 無法從 token 文字重建。有些 provider 的工具呼叫參數寫入歷史時仍是 token，不過本機執行閘門會在執行前還原。因此完全不含 token 的歷史與無縫重啟復原都不成立；無法解析的寫入／執行參數仍會拒絕，不產生副作用。

本機歷史、日誌與產生的檔案可能仍含原文——這裡保護的是模型邊界，不是磁碟。
