# LeakShield Roadmap

更新：2026-11-26。這是跨宿主的產品規劃，區分既有能力、近期優先工作、候選功能與研究；階段可並行，不是發版日期或已支援能力的承諾。

> A local-first, verifiable privacy protection layer for coding agents.
>
> Invisible by default. Observable on demand. Fail-closed at the model boundary.

## 基準與安全邊界

- 本次核對的基底為 [PR #142](https://github.com/jwcrystal/leakshield/pull/142) 的 `24ea25511f459ceed0ca738b23638a63b6460746`。`package.json`、[Changelog](../CHANGELOG.md) 與最新 [GitHub release v0.5.0](https://github.com/jwcrystal/leakshield/releases/tag/v0.5.0) 一致；v0.4.0 已交付 pi，v0.5.0 已交付偵測與設定硬化，不能再把兩者當成尚未發版的整合里程碑。本次未另查 npm registry。
- [ADR-0008：Transparent Protection & Native UX](adr/0008-transparent-protection-and-native-ux.md) 保持 accepted 且原文不變。安全不變量、原生體驗、生命週期與驗收要求沿用該 ADR，不另建 ADR，也不把規劃文字當成實裝證據。
- 當前能力以[宿主能力矩陣](host-capabilities.md)、各 adapter 文件及[驗證紀錄](evidence/README.md)為準。設定通過、proxy 健康、實際請求受保護是不同證據；本文件不改 doctor、矩陣狀態或現有預設值。
- LeakShield 保護受支援的模型請求邊界，不是工具對外連線防火牆。宿主／相依套件的 telemetry、analytics、crash reports、遠端 MCP 與 shell 自行送出的資料不因此受到保護；ZDR 是 provider 的資料處理政策，也不會擴大 LeakShield 的攔截範圍。見 [README 的邊界說明](../README.md#what-this-protects--and-what-it-does-not)與 [SECURITY.md](../SECURITY.md)。
- 安全失敗處理沿用 ADR-0008：出站遮罩／初始化失敗拒絕受影響請求；不安全的工具還原拒絕呼叫；入站顯示還原失敗則保留 placeholder，不猜測、不借用其他 session 的 mapping。

既有[透明防護硬化執行計畫](plans/2026-10-05-transparent-hardening-execution-plan.md)、[偵測補強計畫](plans/2026-10-07-detection-hardening-plan.md)及[核心套件遷移計畫](plans/2026-11-22-core-package-migration.md)保留各自的歷史基線與細部工作；本文件提供後續總覽，不重設其完成狀態或取代規格。

## 階段與交付順序

| 階段 | 定位 | 下一步與交付依據 |
|---|---|---|
| 1. 跨 Agent 防護 | 近期優先工作 | 補足既有三個 adapter 的工具與模型 transport 驗證；依既有 issues 交付 |
| 2. Security Hardening | 與階段 1 並行 | 共用驗證 harness、安全回歸與固定宿主版本的相容性證據 |
| 3. Privacy Observability | 中期候選 | Enhanced Doctor、本機隱私事件觀測；先設計資料最小化 |
| 4. Data Governance | 中長期候選 | 路徑政策、進階偵測、policy profiles 與 provider-aware policies |
| 5. Egress Awareness | 獨立長期研究 | 辨識非模型出口、研究還原目的地政策及外部安全工具整合 |

以下「優先」是本文件的排序建議，不是 GitHub priority 標籤或已核定時程。階段 1、2 是近期主線；階段 3、4 需先收斂設計再安排功能 PR；階段 5 與 mods 研究不阻塞主線發版。

## 1. 跨 Agent 防護

先讓 OpenCode、pi、Claude Code 的保護範圍可驗證，再評估第四個 adapter。統一的是安全契約與證據格式，各宿主的工具政策不必相同。

| 宿主 | 既有能力與限制 | 近期工作 |
|---|---|---|
| [OpenCode](opencode.md) | transparent＋wire protection 涵蓋支援的 HTTP 與 Responses WS；hook-only 為 PARTIAL，非 fetch transport 仍 unknown | [#110](https://github.com/jwcrystal/leakshield/issues/110) 的 Bedrock／Vertex／SDK transport 探測；[#26](https://github.com/jwcrystal/leakshield/issues/26) 的剩餘真實環境驗證 |
| [pi](pi.md) | fetch 邊界、指定本機工具及 Code Mode 內層還原已實作；拒絕不支援的 transport／未知工具，套件載入順序仍有限制 | 沿用已發版能力，持續 session、compaction、安裝與效能回歸；不將未知工具政策改成 OpenCode 的行為 |
| [Claude Code](claude-code.md) | 實驗性 local proxy 已遮罩支援的模型請求並還原 assistant text；工具參數尚未還原，背景請求與 WS 尚未證實覆蓋 | [#91](https://github.com/jwcrystal/leakshield/issues/91)、[#111](https://github.com/jwcrystal/leakshield/issues/111)、[#113](https://github.com/jwcrystal/leakshield/issues/113) |

Claude Code 工具還原沿用 #91／[PR #101](https://github.com/jwcrystal/leakshield/pull/101) 的工作脈絡；此基底尚未包含該 PR 的 ADR-0005，不當成已交付。工具只在已驗證的執行邊界依欄位還原，不在 proxy 直接把 `tool_use` input 換回原值。

Managed Proxy／原生 CLI、IDE 體驗依 ADR-0008 另行設計：首次設定後的目標是照常使用原生宿主，但自動啟停、健康檢查、行程所有權、連接埠衝突、多 session、crash／重啟與撤回設定都需驗收。現階段仍需依 Claude Code 文件手動接上 proxy；未宣稱已有自動 `setup`。

[#99](https://github.com/jwcrystal/leakshield/issues/99) 維持獨立 mods 研究。必須固定 Claude Code 版本，驗證 `tool.call`、`session.append`、`http.fetch` 的改寫與失敗語意後，才比較 proxy＋hook、proxy＋mod 或無 proxy mod；不先決定取代 proxy。

新增 adapter 的候選順序為 Codex CLI、Gemini CLI，再評估 Cursor／Windsurf 等宿主；T3 Code 先確認與既有 adapter 的重疊。這些都未承諾支援，需先盤點 provider transport、OAuth、背景請求、工具還原及原生權限；不能用名稱相近或一次成功推論完整覆蓋。

## 2. Security Hardening

在既有 `scripts/e2e/`、`scripts/diagnostics/` 與測試上整理共用 Security Verification Harness，不重寫已有效的驗證。對每個宣稱支援的宿主版本與 transport 記錄以下面向：

| 面向 | 驗收方向 |
|---|---|
| Secret leakage | 真實宿主＋錄製 loopback upstream，以合成 canary 斷言原值不在受保護 outbound body；UI 顯示不作為 payload 證據 |
| Fail-closed／未知 transport | 初始化、遮罩、mapping 失敗不得重送原文；區分可拒絕的路徑與根本不經攔截點的旁路，後者如實列 residual |
| 工具還原 | 允許欄位精確還原；危險位置、外 session mapping、失敗／逾時拒絕；工具後續歷史再次遮罩 |
| Session／連續性 | 多 session、resume、mapping 遺失、重啟、取消與重試不跨 session 洩漏，也不繞過保護 |
| 背景請求 | compaction、title／summary、subagent／MCP 逐路徑錄證；unknown 不因一般對話成功就提升狀態 |
| Persistence | 加密 mapping、key custody 與重啟分開驗證；doctor 不觸碰真實 keychain |
| 協定與效能 | JSON、SSE chunk、Unicode、畸形輸入的 property-based tests／fuzzing；冷暖啟動、p50／p95 延遲及記憶體量測 |

固定宿主版本的 compatibility matrix 與跨 adapter regression tests 應隨功能 PR 維護；共用 core 變更重跑其他 adapter。Host 升級需要重新確認真正的模型請求邊界，單元測試通過不足以擴大支援聲明。

沿用 #26 的剩餘驗證缺口，不把全部項目一律標為未驗證：[目前 README](../README.md#project-status) 記載 macOS Keychain 已於 2026-10-20 驗證，Windows／Linux custody 等仍需補證，本次未重跑。#26 原始範圍是 OpenCode；[pi 真實 provider 紀錄](evidence/2026-11-24-pi-real-provider.md)只涵蓋一個 provider／model，未錄製 outbound body，遮罩結論是推論，不代表所有 wire API 或長期使用都驗證完成。需要 owner 帳號或真實 keychain 的驗證另列人工步驟，不以本機 stub 取代。

## 3. Privacy Observability

以下均為後續候選功能，沿用既有 Web UI、doctor 與能力矩陣，不新增互相衝突的覆蓋分級。

- **Enhanced Doctor**：先沿用 [#67](https://github.com/jwcrystal/leakshield/issues/67) 補設定來源缺口，再區分註冊、行程健康與實際攔截證據；顯示宿主版本、模式、provider／transport、工具／背景覆蓋與 unknown／outside。
- **本機 Privacy Dashboard／audit**：研究受保護請求、遮罩類型、拒絕數與未知邊界的彙總；先定義事件 schema、容量、保存期限、刪除與完全停用方式。預設不外送 telemetry，不記錄原始 secret、完整 prompt、憑證或可逆 mapping；路徑、URL 與識別資訊也需最小化。
- **候選介面**：`leakshield status`、`leakshield audit --local`、`leakshield verify` 只是待設計提案，不是現有指令。既有查詢仍使用 `leakshield --doctor <host>`。

觀測資料不得反過來形成新的敏感資料出口；任何額外診斷由使用者按需開啟，事件缺失也不能被當成「沒有外洩」的證明。

## 4. Data Governance & Advanced Detection

| 方向 | 規劃與限制 |
|---|---|
| Path-based policy | 沿用 [#45](https://github.com/jwcrystal/leakshield/issues/45)。`custom_rules[].path` 目前接受但不生效；需可信來源路徑、workspace／glob／大小寫／symlink 語意。無可信路徑時仍套用規則，不從 prompt 猜路徑 |
| Local NER | 沿用 [#25](https://github.com/jwcrystal/leakshield/issues/25)，opt-in、本機限定；先量測大小、誤報、延遲與 unavailable 回報，不能弱化既有規則 |
| 進階偵測 | 保留 regex／checksum 核心；研究 context-aware detection、opt-in entropy 與 secret fingerprinting。不將敏感原文交給遠端 LLM 做偵測 |
| Policy profiles | 個人／專案／組織 profiles 先定義 precedence、glob、衝突與錯誤時 fail-closed，再決定 schema；不提供看似已支援的新設定格式 |
| Provider-aware policy | 研究使用者明確配置的信任等級與資料類型政策。ZDR 需核對帳號方案、endpoint、實際路由及條款，不能只看 hostname／模型名稱，也不因 ZDR 自動放寬憑證遮罩 |

Agent task-level blocking 沿用 [#21](https://github.com/jwcrystal/leakshield/issues/21)，它是 OpenCode 的行為契約設計票，仍需既有人工決策。不能把目前 text-level block／notify 寫成已能停止整個 task；CLI／CI／Web 行為也不隨這份 roadmap 改動。

## 5. Egress Awareness & 外部安全整合

獨立長期研究，不作為近期發版或 1.0 的必要條件。這是對非模型資料傳輸邊界的認知與整合方向，不代表開始提供全域 egress protection。

- **Awareness**：研究宿主 telemetry 設定檢查、已知 endpoint 清單、remote MCP endpoint 與 coverage reporting；network destination metadata 僅考慮 opt-in。payload inspection 僅在隔離測試環境用合成資料。未知設定不能被寫成已外洩，也不能將非模型流量塞入現有模型能力矩陣的新狀態。
- **Tool restoration destination policy**：研究限制 LeakShield 自己把原值還原到哪些工具／欄位／目的地；不宣稱能控制任意 shell 或工具網路。先處理 redirect、shell expansion、間接呼叫、目的地解析與執行間的落差；沒有可靠執行邊界就交給外部 permission engine／sandbox，維持現有拒絕政策。
- **外部整合**：評估 OS sandbox、防火牆、policy engine、secret manager、CI/CD 及本機 audit export。SIEM 只考慮去識別化且 opt-in 的事件；先設計安全 schema 與分享界線，再決定是否開票。

不規劃全域 TLS MITM、自行重寫防火牆、cloud dashboard 或遠端 AI secret detection；也不為此要求每次安全還原都由使用者確認，或在缺乏證據時重寫語言／大量增加 adapter。

## 既有 Issue 對照與待設計工作

2026-11-26 即時核對：以下 10 個 issues 均為 **open**，未設定 milestone；下表沿用現有票，不重複開票。狀態是日期快照，細部進度以 issue、PR 與 evidence 為準。

| Issue | 範圍 | 對應階段與排序 |
|---|---|---|
| [#91](https://github.com/jwcrystal/leakshield/issues/91) | Claude Code 工具執行時還原 | 1：近期優先 |
| [#111](https://github.com/jwcrystal/leakshield/issues/111) | Claude Code 背景請求探測 | 1、2：近期優先 |
| [#113](https://github.com/jwcrystal/leakshield/issues/113) | Claude Code WebSocket 探測 | 1、2：近期優先 |
| [#110](https://github.com/jwcrystal/leakshield/issues/110) | OpenCode 非 fetch transport 探測 | 1、2：近期優先 |
| [#26](https://github.com/jwcrystal/leakshield/issues/26) | OpenCode 真實 provider、keychain、長期測試的剩餘缺口 | 2：近期優先，部分需 owner 環境 |
| [#99](https://github.com/jwcrystal/leakshield/issues/99) | Claude Code mods 攔截能力驗證 | 1：獨立研究，不阻塞發版 |
| [#67](https://github.com/jwcrystal/leakshield/issues/67) | doctor 尚未涵蓋的設定來源 | 3：後續優先 |
| [#21](https://github.com/jwcrystal/leakshield/issues/21) | OpenCode task-level blocking 設計 | 4：先完成人工政策決策 |
| [#45](https://github.com/jwcrystal/leakshield/issues/45) | custom rules 路徑範圍 | 4：候選，沿用原驗收 |
| [#25](https://github.com/jwcrystal/leakshield/issues/25) | Optional local NER | 4：候選，先量測 |

本次 open issues 未找到專票的方向包括 Managed Proxy 生命週期、共用 harness 整理、本機隱私事件、policy profiles 與 Egress Awareness。這些是待設計 backlog，不是已建立的 issues；建立前需再查重，且先延伸既有驗證與觀測能力。

## 發版與研究分流

1. **近期交付**：階段 1＋2，依功能 PR 的安全不變量、相容性、證據與回歸結果決定；不等所有宿主達成完整功能才交付可驗證的增量。
2. **後續候選**：階段 3＋4，設計收斂後再安排到實際版本。先前討論中的 0.6.x／0.7.x／0.8.x 分配不作承諾；不改既有 v0.4.0／v0.5.0 的發版內容。
3. **研究**：#99、其他 adapter 可行性、telemetry／egress awareness、目的地政策與外部整合獨立推進，不作為目前版本或近期發版的阻塞條件。研究不能降低已宣稱支援功能的驗收標準。
4. **1.0 候選標準**：穩定的設定格式、adapter 契約、已驗證的支援範圍及明確 residuals；不要求 roadmap 所有候選功能先完成。日期與版本需另由實際 release 工作決定。

本文件僅更新規劃，不授權合併、打 tag、發布套件或擴大當前安全保證。
