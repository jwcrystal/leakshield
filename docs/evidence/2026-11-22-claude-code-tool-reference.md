# Claude Code 2.1.330：ToolSearch 的 `tool_reference` 經過 proxy（#102）

日期：2026-11-22 · Claude Code 2.1.330 · 修正前：leakshield `main` `047e5aa`；修正後：分支 `claude/tool-reference-passthrough`。都以 `npm run build` 產生的 `dist/cli.js --claude-code-proxy` 執行。

## 方法

- 真實的 `claude -p "Load the WebFetch tool." --model sonnet --max-turns 4 --allowedTools "Bash(echo:*)"`，以 `env -i` 只保留 `PATH`、`HOME`，獨立的 `CLAUDE_CONFIG_DIR`，合成的 `ANTHROPIC_API_KEY`。
- 上游是 [`stub-upstream.mjs`](../../scripts/e2e/claude-code/stub-upstream.mjs) 的改寫版，只換掉腳本：第一輪回 `tool_use ToolSearch {"query":"select:WebFetch","max_results":1}`，第二輪回 `tool_use Bash echo second-turn`，第三輪回文字。**沒有使用真實模型，也沒有連到 Anthropic。** 改寫版未納入 repo。
- 每種設定跑一次：直接連替身、經修正前的 proxy、經修正後的 proxy。

## 結果

| | 直接連替身 | 修正前的 proxy | 修正後的 proxy |
|---|---|---|---|
| `claude` 結束碼與輸出 | 0，`Loaded the tool.` | 0，`Loaded the tool.` | 0，`Loaded the tool.` |
| proxy 拒絕次數 | — | 3（全部 `[anthropic-tool-result-part]`） | **0** |
| 第 2、3 個請求的 `tool_result` | `[{"type":"tool_reference","tool_name":"WebFetch"}]` | `[{"type":"text","text":"[Tool references removed - tool search not enabled]"}]` | `[{"type":"tool_reference","tool_name":"WebFetch"}]` |
| 第 2、3 個請求的工具定義數 | 13 | **23** | 13 |
| `anthropic-beta` 含 `advanced-tool-use-2025-11-20` | 是 | **否** | 是 |

- 修正前：被拒 3 次之後，Claude Code 自己關掉 tool search，把 `tool_reference` 換成一段文字、拿掉 `advanced-tool-use` beta、改送全部 23 個工具定義。之後的請求維持關閉，不再被拒（整個 session 共 3 次）。使用者看不到錯誤，代價是每個請求都帶全部工具定義。
- 修正後：與直接連替身相同，tool search 保持開啟。
- 修正後的 [`run.mjs`](../../scripts/e2e/claude-code/run.mjs) mask 情境 8/8、refuse 情境 4/4 仍然通過。

## 未涵蓋

- WebSearch 的 `server_tool_use`／`web_search_tool_result` 仍會被擋，本次沒有測。
- 真實模型下 ToolSearch 一次載入多個工具時，`tool_result` 會帶多個 `tool_reference`；修正逐一接受，本次只觀察到單一個。
