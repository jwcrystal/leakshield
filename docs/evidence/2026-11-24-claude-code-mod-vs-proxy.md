# Claude Code：Mod-based interception 與 Local Proxy + Hooks 研究

日期：2026-11-24。狀態：**文件研究與實驗計畫，未執行 Mod runtime 驗證，未決定替換架構**。

結論：優先驗證官方 Mods，保留現有 Local Proxy 基線；`tool.call` 單獨通過可支持「Proxy + Mod 工具閘門」，不能據此移除 Proxy。只有最終請求、工具還原、失敗阻斷、更新、認證與 UX 都有對等證據後，才另提架構決策與實作 PR。這份文件不修改 runtime、設定、能力宣告、套件版本或 pi 發版條件，也不阻塞 pi 優先發版。

## 1. 既有工作與去重

本次先讀取原始討論與先前 Work 產出，再查 GitHub 的 ADR、開啟／已關閉 PR、Issues 與分支。討論中的「已建立 Work」不是 PR 已提交的證據；未找到已提交的同題研究 PR。快照基底為 `main` [`459a08b`](https://github.com/jwcrystal/leakshield/commit/459a08b4ab66670fe21fc95316ce4d1a820ce488)。

| 工作 | 查核結果與本研究邊界 |
|---|---|
| [#99：驗證 mods](https://github.com/jwcrystal/leakshield/issues/99) | 已有 `tool.call`、`session.append`、`http.fetch` 實測任務；本 PR 擴充證據比較與決策門檻，沿用 #99，不另開 Issue、不宣稱完成實測。 |
| [#91：工具執行前還原](https://github.com/jwcrystal/leakshield/issues/91) | 仍為 Proxy + `PreToolUse` 實作工作；本研究不重做、不關閉。 |
| [#101：工具格式、hook 證據與 ADR-0005](https://github.com/jwcrystal/leakshield/pull/101) | 查核時開啟、尚未合併；其設計與測量應依 PR 固定版本引用，不當作 main 已具備功能。 |
| [#103：ToolSearch 相容性](https://github.com/jwcrystal/leakshield/pull/103) | 已合併；維持 `tool_reference` 原生行為是比較的必要回歸案例。 |
| [#111：背景請求](https://github.com/jwcrystal/leakshield/issues/111)、[#113：WebSocket](https://github.com/jwcrystal/leakshield/issues/113) | 仍有覆蓋缺口；不能宣稱 Proxy 或 Mod 已保護全部背景／transport。 |
| [ADR-0008／Draft PR #128](https://github.com/jwcrystal/leakshield/pull/128) | 已提交的 Transparent Protection & Native UX 提案，狀態 proposed、尚未合併；本研究沿用其驗收方向，不重建 ADR 或宣布接受。 |
| [跨宿主原則 ADR](../adr/0007-experience-first-privacy-balance.md) | main 已接受；沿用出站 fail-closed、入站還原 P0 降級、工具守門與如實揭露邊界。main 另有 [pi Code Mode ADR](../adr/0007-pi-codemode-restore-at-inner-calls.md)，兩者同編 0007，引用用完整路徑避免混淆；不在本研究改號。 |
| [#126：0.4.0](https://github.com/jwcrystal/leakshield/pull/126)、[#127：pi provider 證據](https://github.com/jwcrystal/leakshield/pull/127) | 兩者已合併；本研究編寫期間 #126 使 main 前進至 `17beb197`（版本與 changelog）。本 PR 保持研究分支獨立，不重開發版工作；pi 優先不代表從共用套件移除已存在的實驗性 Claude Code Proxy。 |

先前 [2026-10-15 調查](2026-10-15-agent-interception-capabilities.md) 只是當時的文件研究。#99 在 11-22 留下「`http.fetch` 能否改 body、`session.append` 是否送到模型」的疑問；下列新文件已提供更明確的契約，但仍需要在指定 binary 上重現。

## 2. 證據分級與候選機制

**既有實測**指 repo 記錄的結果，本次沒有重跑；**官方契約**指當日一手文件／型別描述，並非實測通過；**候選／未知**必須由 #99 的後續實驗取得證據。官方網站會更新，不能把網頁版本當成已安裝版本。

一手來源：官方 [Mods overview][mods]、[建立 Mod][create]、[事件與失敗處理][events]、[組織管理][admin]、[reference][reference]。宣告固定到 Anthropic repo [`a4cdd71` 的 `claude-code.d.ts`][types]（本次查得該路徑最新 commit；不是 Claude Code binary 版本）。實驗時仍須保存該 binary 產生的 declarations 與雜湊。

| 候選 | 證據與可能用途 | 目前限制／定位 |
|---|---|---|
| M1：官方 Mod `http.fetch` | [型別][types] 明寫 engine 的每次模型 send 觸發，可改 URL、method、headers、body，或回 `{ deny }` 讓 caller 得到 403。 | 最優先的最終請求候選；發生在 signing 後、compression 前，改動已簽章請求會破壞簽章。啟用內建 guard 時，僅符合組織身分的 Mod 能收到 engine 請求。[admin][admin] |
| M2：官方 Mod `tool.call` | 可包覆工具執行、改 input／result 或拒絕，候選為 #91 的行程內工具閘門。 | 必須證明還原後的值只進允許的執行欄位，歷史仍保留 placeholder；有工具控制能力不代表有最終模型請求保護。 |
| M3：內容與 session Mods | `prompt.submit`、`prompt.section/context/attachment`、`skill.prompt` 可處理各類內容；`session.append` 可改文字與工具結果。 | [型別][types] 說 append 改寫會存入並送給模型，但 thinking／tool-use／未知 blocks 與 tool-result IDs 受保護，媒體不能任意改寫；engine append 不能靠 deny 阻斷，UI、SDK、Remote Control 可能先看到原列。不能當成全欄位 DLP。 |
| M4：launcher + Node preload／transport wrapper | Node 官方支援 [`--require`／`--import`][node-cli]，Node fetch 可用 [Undici dispatcher][node-fetch]；launcher 可選擇啟動的 binary／環境。 | 僅為一般 Node 機制。[現行安裝文件][setup] 說 npm 也裝 native binary、執行時不啟動 Node；因此不能假設 `NODE_OPTIONS` 或 patch `globalThis.fetch` 能攔目前 Claude Code。launcher 本身也不會取得 body。 |
| M5：修改 JS bundle／native binary、外部 instrumentation | 未找到 Anthropic 維護的 patch 攔截契約；只是不同於官方 Mods 的研究候選。 | 未驗證覆蓋、完整性與更新；本 PR 不提供 patch／注入程式、不檢查或修改 executable。先通過條款與授權門檻，否則停止此分支。 |

官方 Mod 是 plugin 內的 JS／TS event handler，不等於修改 Claude executable；有宿主版本、載入方式與權限條件。[建立文件][create] 要求 v2.1.287+；engine `http.fetch` 欄位文件要求 v2.1.321+，但最低版本不是支援保證。[reference][reference]

## 3. 與 Proxy + Hooks 的證據比較

比較基線是「已存在的 Proxy + #91 規劃中的工具 hook」，**不是宣稱工具還原已完成**。

| 面向 | Local Proxy + Hooks | 官方 Mods 候選 | 決策含義 |
|---|---|---|---|
| 最終模型請求 | [現行文件](../claude-code.md) 與 [2.1.321 實測](2026-11-21-claude-code-proxy.md)：指定 base URL 的 Messages 與 count_tokens 可遮罩；不支援形狀拒絕。背景、其他 transport 與旁路未全面驗證。 | `http.fetch` 官方契約涵蓋每次 engine 模型 send，但組織 guard／provider／實際 build 覆蓋待測；內容 hooks 不等於 wire 覆蓋。 | 用獨立接收端與 socket 清單比對，不能只數 handler 執行次數。 |
| 工具還原與模型歷史 | [#101 的固定證據][pretool]：2.1.330 `updatedInput` 用於執行，下一次模型歷史保留原 `tool_use.input`；工具真實輸出仍需重新遮罩。這是 stub 測量，不是 #91 已實裝。 | `tool.call` 可改執行輸入與結果，但相同歷史語意、subagent／MCP／權限排序尚未重現。 | 先比較工具閘門，允許保留 Proxy 的混合方案。 |
| Fail-closed | Proxy 已有 stub-backed refusal 證據；endpoint 必須確實指向它。#101 測得 hook crash／timeout 預設放行，`onFailure: "block"` 可阻斷。 | [事件契約][events]：throw／timeout／無效結果可跳過；`.catch` 可回 deny，但 catch 再失敗仍可跳過。 | `.catch` 是必要控制，並非無條件 fail-closed 證明。載入失敗、停用、更新與 catch 失效都要零明文送出。 |
| 回覆還原 | JSON／SSE 與跨 delta placeholder 有既有測量。入站還原失敗沿用 P0：保留字面 placeholder，不中斷收到的回覆。 | `http.fetch` 的 engine response 通常 `isStreaming: true`、`text` 為空；不能假設可任意改串流 body。`turn.step`／顯示事件是候選，仍須驗證。 | 另證明顯示還原不會把原值寫回模型歷史，且不中斷串流。 |
| 原生功能 | #103 具體顯示新 block 可造成三次拒絕後 ToolSearch 被停用；修正後恢復。 | 行程內可能減少 HTTP 轉譯，但仍需支援簽章、cache、工具 schema、串流與排序；沒有更相容的測量。 | 用同一 ToolSearch、Compact、Agent 等情境比功能與 token 成本。 |
| 安裝與維護 | 需管理本機服務、port、endpoint、token 與生命週期；Managed Proxy 屬後續工作。 | 可能省去服務與每次 command hook 的行程啟動；也增加 Mod 載入、組織部署、reload、事件版本與 handler 排序成本。 | 不能先宣稱更快或更省維護；測 setup、延遲、資源與故障恢復。 |
| 信任邊界 | Proxy 接收並轉送 credential，loopback 不代表 credential 隔離；#101 token 不能阻止同使用者程序。模型外的工具網路出口不因此受保護。 | [overview][mods] 說 Mod 以使用者權限執行，無 sandbox；同程序／其他 Mods 與本機資料也在信任評估內。 | 只承諾量測過的模型出口保護，另列 transcript、工具與 telemetry 殘留。 |

[#101 的 2.1.330 Proxy 重測][proxy330] 為 mask 8/8、refuse 4/4；使用真實 CLI、合成值與 loopback stub，**沒有真實 Anthropic／訂閱登入證明**。這份研究不把它提升成現版本、所有 provider 或帳號的通過結果。官方 settings Hooks 能改特定工具 input／output，但不提供完整最終 request 改寫契約，仍須另外的模型出口邊界。[Hooks reference][hooks]

## 4. 實驗設計（全部待執行）

沿用 [`scripts/e2e/claude-code/`](../../scripts/e2e/claude-code) 的 real CLI + recording stub 方法，另開 #99 的實驗 PR。不得讓兩個遮罩層把缺口藏起來：分別執行 A：Proxy + Hooks、B：Mod only、C：Proxy + Mod，另有直接 stub 的控制組。B 的接收端只記錄、不替它遮罩。不能用「模型回答像 placeholder」替代完整接收 bytes 證據。

每次保存版本／binary hash、OS、安裝通路、原生／npm、設定來源、auth 類型、guard／組織 tier、所有 Mods 與 hooks 順序、declarations hash、LeakShield commit、觸發步驟、期待與實際結果。只用合成 canary；credential 值不進公開 artifacts。每個案例記錄 request ID、所有重試／連線、接收 body 中原值／placeholder 的機械斷言、工具副作用、stdout／歷史／持久化結果；公開去敏化摘要與可重現步驟。

| 編號 | 情境與注入點 | 必須觀察的結果／失敗條件 |
|---|---|---|
| T1 最終請求 | user prompt、貼上、`@` 檔案、CLAUDE.md／system、skills、schema、history、tool_result；包含 Unicode、JSON escaping、超限／未知 blocks、thinking／signature、media。 | 每個支援的 send／retry 在獨立接收端都不含合成原值，結構仍有效；不支援形狀在送出前阻斷。記錄 late hook／另一 Mod 在掃描後重新加入值是否可繞過。 |
| T2 背景與原生功能 | 手動／自動 Compact、resume 摘要、title／suggestions（版本有才測）、Agent／background Agent、WebFetch 摘要、ToolSearch deferred tools。 | 每條路徑分列真實 endpoint、event、body、重試與 socket；保留 ToolSearch／compact 功能。未觸發或無法觀察標 unknown，不能算 pass。關聯 #111／#113。 |
| T3 執行邊界 | Read／Write／Edit／Bash／code、MCP（本機與遠端）、unknown tools、subagent；允許與不允許的欄位、近似 token／缺 mapping／跨 session。 | 僅政策允許的位置在執行前取得原值；危險 shell／code、外送／跨 session 欄位依既有宿主政策拒絕；不安全案例工具完全不執行。不擅自把 pi unknown-tool 規則套到 Claude Code。 |
| T4 歷史與回覆 | 工具印出原值、下一輪 history、JSON／SSE、跨 delta token、取消／截斷、resume／fork／clear、並行 sessions、Mod reload／Proxy restart。 | 模型接收的每輪仍遮罩，session mapping 不串用；顯示可還原但模型歷史不可被顯示還原污染。mapping 遺失不猜值；入站失敗保留 placeholder。另盤點本機 transcript 與 SDK／Remote Control 的原值可見性。 |
| T5 故障注入 | handler throw／async reject／timeout／無效結果，`.catch` throw／timeout；初始化／import 失敗、缺模組、禁用 hooks、`--safe-mode`／`--bare`、guard 不授權、熱重載中斷。 | 對宣稱受保護的啟動路徑，任何遮罩前故障皆零明文 provider send；工具閘門失敗不執行工具。只顯示警告但仍送出原值就是 fail。驗證錯誤發生在 `next` 前；send 後 deny 無法撤回。 |
| T6 旁路與協定 | 其他 Mod、hook 排序、WebSocket／非 fetch、provider 切換、base URL 被 host 覆寫、redirect、compression、signed request、count_tokens。 | 對照 socket 與 request inventory；未覆蓋出口明列 outside／unknown 並禁止受保護模式使用不支援 provider。不能把「測試未見 WS」推論成宿主永不使用 WS。 |
| T7 更新與還原 | 固定上一個／目前支援 build；stable／latest、native／套件管理更新、冷啟動與 hot reload、Mod 升降版、卸載、半完成更新。 | binary 與 declarations 漂移可偵測；新版本未核准時不靜默送出。還原到已驗證 Proxy 路徑後重測健康／mask／refuse；不能自動退成無保護直連。 |
| T8 認證與 UX | API key、個人訂閱 OAuth、Team／Enterprise、managed API key／組織 Mod；宣稱支援才測 Bedrock／Vertex／Foundry。互動 CLI、`-p`、IDE／Desktop／SDK 分列。 | `/login`、refresh／過期、登出、權限對話與 native session 可用；記錄哪種組合真的收到 engine 事件，不能以 API-key 成功代替 OAuth。比較 setup 步數、診斷可理解性、失敗訊息、無聲功能退化。 |
| T9 效能／維護 | 同機同 build 同情境，固定 warmup 與至少 30 次重複；A／B／C 比 startup、TTFT、總時間、p50／p95、RSS／CPU、併發與長 session。 | 區分 stub overhead 與真模型網路時間；公布樣本數、環境與變異。使用者／維護者先訂可接受預算，再判定收益，不事後調門檻。 |

Mod 缺失而宿主仍可啟動，是獨立的部署邊界問題。若宿主沒有可證明的強制載入／中止機制，僅靠 Mod 自我 health check 不足以阻止自己不存在時的 send；保留 Proxy 或另有可驗證的部署控制。不得繞過組織 guard 取得事件。

## 5. OAuth、條款與供應鏈門檻

[認證文件][auth] 有 provider、環境變數、helper、OAuth／profile 等優先序；[gateway 相容指南][gateway] 記載 claude.ai-authenticated 請求的 Authorization 保留需求，但不能據此推論 LeakShield 的登入／refresh 已通過。原生登入成功也不證明請求經過任何指定攔截層。實驗保留官方登入流程，不匯出、重用或記錄訂閱 token；需要不同 auth 組合時使用各自正式流程。

[Claude Code 法律頁][legal] 區分個人方案與商業／API 條款，並對把 Claude Code 放進產品／服務提出未修改 binary、保留原生認證與使用者各自授權等條件；其適用範圍不能任意擴張。[Consumer Terms][consumer] 與 [Commercial Terms][commercial] 對 reverse engineering／規避保護有約束，具體契約可能另有約定。本研究不是取得授權的證明；M5 必須先確認適用條款／書面授權與再散布權，無法確認就不進入實作。官方 Mods 和 binary patch 應分開判斷。

[安裝文件][setup] 記載 native 背景更新於重啟生效、各套件管理通路更新方式不同，並有 checksum／平台簽章；改 binary 的完整性與支援成本不能忽略。候選方案應固定支援版本、檢查實際執行檔路徑與版本、記錄依賴／更新來源。正式採用前再次查核文件與條款，不能把當日網頁當永久許可。

## 6. 決策 gates 與目前判定

| Gate | 通過所需證據 | 目前狀態／未通過時 |
|---|---|---|
| G0 可用性與合法部署 | 指定版本、平台、auth／guard 組合可正式載入並取得所需事件；條款、完整性、組織授權與散布範圍明確。 | 未驗證；無事件的組合不列支援，停止 patch 分支或保留 Proxy。 |
| G1 最終請求覆蓋 | T1／T2／T6 所有承諾路徑（含 background／retry）零原值；未知／不支援路徑有強制阻斷；不能靠第二層掩蓋缺口。 | 未執行；不能移除 Proxy。 |
| G2 還原與隔離 | T3／T4 證明執行欄位還原、歷史重遮罩、session 隔離、P0 顯示降級與殘留如實揭露。 | 未執行；僅 M2 通過可另提 Proxy + Mod 工具閘門。 |
| G3 Fail-closed | T5 覆蓋 handler、catch、載入／禁用／reload 的失效；每個承諾的受保護路徑都不送明文、不執行不安全工具。 | 官方預設 skip 使此為關鍵阻擋項；catch 單獨通過仍不夠。保留獨立邊界。 |
| G4 更新與原生相容 | T7／T8 的支援矩陣、簽章／認證、native features、版本漂移阻斷、卸載與回到 Proxy 的復原全部可重現。 | 未執行；不把未知新 build 視為受保護。 |
| G5 UX／效能收益 | T8／T9 有同條件數據與事前預算，維護／部署成本可接受，沒有 #103 類型的無聲退化。 | 未量測；不宣稱 Mod 更快、更好用或較容易維護。 |

目前選擇：**繼續既有 Proxy 基線與 #91；#99 做獨立實驗。** G0～G5 全部通過後，也只允許提出有明確支援矩陣的後續架構決策；不自動採用。部分通過可選混合方案，任何模型外洩或無法強制失敗阻斷都否決 proxy-less 路線。合併這份研究文件不代表 gates 已通過，也不改變 pi 的發布時程。

[mods]: https://code.claude.com/docs/en/plugins/mods/overview
[create]: https://code.claude.com/docs/en/plugins/mods/create
[reference]: https://code.claude.com/docs/en/plugins/mods/reference
[events]: https://code.claude.com/docs/en/plugins/mods/events#handle-a-hook-that-fails
[admin]: https://code.claude.com/docs/en/plugins/mods/admin
[types]: https://github.com/anthropics/claude-code/blob/a4cdd71b3df8927105db205f5b6ec7cdef8708b3/mods/types/claude-code.d.ts
[hooks]: https://code.claude.com/docs/en/hooks
[setup]: https://code.claude.com/docs/en/setup
[auth]: https://code.claude.com/docs/en/authentication#authentication-precedence
[gateway]: https://code.claude.com/docs/en/llm-gateway-protocol
[legal]: https://code.claude.com/docs/en/legal-and-compliance
[consumer]: https://www.anthropic.com/legal/consumer-terms
[commercial]: https://www.anthropic.com/legal/commercial-terms
[node-cli]: https://nodejs.org/api/cli.html#--importmodule
[node-fetch]: https://nodejs.org/api/globals.html#custom-dispatcher
[pretool]: https://github.com/jwcrystal/leakshield/blob/a2deda365ef5c35300b7cb62fb98592816bee9c1/docs/evidence/2026-11-22-claude-code-tool-shapes-pretooluse.md
[proxy330]: https://github.com/jwcrystal/leakshield/blob/a2deda365ef5c35300b7cb62fb98592816bee9c1/docs/evidence/2026-11-22-claude-code-proxy-2.1.330.md
