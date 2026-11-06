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

macOS／Linux 的 POSIX shell 支援占位符作為完整的未加引號、單引號或雙引號參數；保留原引號，並檢查原值不會破壞該引號語境，含空格的原值仍是一個參數。`curl`、`http` 在字面上是第一個詞時，占位符可位於參數內部（例如 `-H 'x-api-key: <placeholder>'`、`-u user:<placeholder>`）；其他命令（含 `wget`）仍維持完整單詞規則。`rtk` 被視為包裝命令，依它實際執行的命令判斷（`rtk sh -c <placeholder>` 與 `sh -c` 一樣被拒絕）；會再執行另一個命令的 rtk 子命令（`err`、`test`、`summary`、`run`、`bypass`、`proxy`、`pipe`）一律拒絕。`rtk curl` 只適用完整單詞規則，因為 rtk 會把命令列保存在本機的明文歷史紀錄中；若你的環境中 `rtk` 會改寫 `curl`，可在 rtk 設定的 `exclude_commands` 加入 `curl`，以使用內嵌占位符。`rtk` 底下的完整單詞形式（`rtk git log <placeholder>`）仍會還原，原文因此同樣會寫進該歷史紀錄；rtk 的 OpenCode 外掛也可能把 `git log` 這類一般命令改寫成 `rtk` 形式，結果相同。以 `-` 開頭的參數只能用 `--name=value` 的形式放入占位符，請寫成 `-H x:<placeholder>`，不要寫成 `-Hx:<placeholder>`；`wget -e`／`--execute`（含縮寫） 會再次解析其值，因此一律拒絕。這只保護還原時的命令結構，不管制機密如何被使用：被允許的命令可以把該值送到任何地方。支援單一、結尾的 `>`／`>>`，目標須為靜態字面檔名。命令／變數賦值位置、帶 token 的重新導向檔名、展開、引號拼接、管線、inline script、會跳出引號或以 `-` 起始的原值，仍在修改參數前拒絕該次工具呼叫。

不含 token 的命令不受影響。Windows 不啟用新增的引號／重新導向支援；這不是通用 shell parser。`wireProtection` 的兩種設定不會改變此工具防線。OpenCode 內建 `execute` 工具（Code Mode，輸入 `{code}`）的原始碼不會被還原：它是 JavaScript，placeholder 會在程式碼呼叫工具時，依該工具的欄位規則還原；原始碼中的 placeholder 維持原樣。`execute` 原始碼若同時含有已對應的 placeholder 與 `fetch`，該呼叫會被拒絕，避免失敗的呼叫被誤讀為對該值的判定；這只是文字比對，不是網路管控，其他寫法不會被攔下，送出的也只是 placeholder。對 placeholder 做運算（長度、編碼）的 JavaScript 看到的是 placeholder，且不會報錯。若某個值明顯由本工作階段的 placeholder 衍生、但格式被改動（去掉方括號、改變或移除分隔符、改了大小寫），會被拒絕而不是直接放行；只遮蔽一部分的值，或模型完全改寫掉的值則無法偵測，會照原樣交給工具。僅在 OpenCode v2.2.5 驗證過。還原規則以欄位為單位：shell 工具（內建名單，或工具名稱含 `bash`、`shell`、`zsh`、`pwsh` 等片段）的所有欄位都套用 shell 規則；任何工具中名稱像指令的欄位（`command`、`cmd`、`commands`、`argv`、`shell` 等）也套用。名為 `code`、`script` 等的欄位中，只有符合受限單行字串規則的 placeholder 才會被還原。這是保守的啟發式判斷，不是跨語言的語法驗證，既可能誤拒，也可能漏判。被拒絕的呼叫是被擋下而非被遮蔽：工具不會執行，輸入中的 placeholder 維持原樣。會被拒絕的形式包括：裸 placeholder、插值區域（`f"{...}"`、`${...}`、`$(...)`）、反引號字串、多行字串（含任何含三引號的行）、反斜線續行之後的行、註解，以及原文含有 shell 不安全字元（包含空白）者。賦值上方有成對 docstring 的腳本仍可運作。改寫方式：把 placeholder 放進不含插值的一般引號字串，並寫在單獨一行，且該行不在任何多行字串或續行之內，再引用該變數。改寫時請原樣複製對話中出現的 placeholder，包含方括號。這不是外送防護：程式仍可印出、傳送或重新解讀還原後的值，且未列出的語言結構（例如 Ruby 的 `%q`）可能被誤判。說明類欄位（`description`、`title`、`label`）與其他欄位直接還原。巢狀的值也會還原，雖然 OpenCode 宿主會凍結巢狀輸入：LeakShield 會以還原後的複本取代最近的可寫入上層值（在 OpenCode 上即最上層的值），凍結的原物件不會被改動，沒有變動的子樹仍是同一個物件。被凍結的最上層輸入、proxy、共用或循環參照、accessor、symbol key，以及含 placeholder 的 key 仍會被拒絕，拒絕訊息說的是參數結構無法還原，不是該值看起來有問題。使用其他欄位名稱的執行型工具不會被偵測。shell 工具名單內建於 LeakShield 原始碼，無法設定。宿主儲存什麼取決於工具的呼叫方式，這個外掛無法改變儲存的內容。工具本身儲存的輸入仍是占位符（已在 shell 與 `execute` 呼叫上觀察到）。但 Code Mode（`execute`）呼叫工具時，宿主還會把每個內層呼叫連同還原後的原文以明文存進 `execute` 呼叫的 metadata；工具輸出若回顯該值，也會一併存下。在 OpenCode v2.2.5 上，OpenChamber 的 `openchamber_render` 只能從 Code Mode 呼叫，所以它儲存的內層呼叫含原文，依該 metadata 繪製的畫面可能會顯示原文。以上是在 v2.2.5 的本機 session 儲存中觀察到的；OpenChamber 介面本身未檢查。

## 重啟限制

兩種層級共通。

重播的原文可以建立新映射，但舊 token 無法從 token 文字重建。有些 provider 的工具呼叫參數寫入歷史時仍是 token，不過本機執行閘門會在執行前還原。因此完全不含 token 的歷史與無縫重啟復原都不成立；無法解析的寫入／執行參數仍會拒絕，不產生副作用。

本機歷史、日誌與產生的檔案可能仍含原文——這裡保護的是模型邊界，不是磁碟。
