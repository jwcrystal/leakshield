# 設定參考

[← README](../README.zh-TW.md#設定檔) · 🌐 [English](configuration.md) | 繁體中文

設定檔的搜尋位置、怎麼建立、改完何時生效，見 [README](../README.zh-TW.md#設定檔)。這頁列出所有欄位與規則。

## 欄位總表

每個欄位都可以省略。省略的欄位使用預設值；不認得的欄位會被忽略。

| 欄位 | 預設值 | 作用 | 細節 |
|------|--------|------|------|
| `nda_keywords` | `CONFIDENTIAL`、`INTERNAL ONLY`、`DO NOT SHARE`、`NDA` | 命中時回報 HIGH，不分大小寫。首尾是 ASCII 英數字的關鍵字以整字比對（`NDA` 不會命中 `agenda`）；中日韓關鍵字以子字串比對。列出清單會取代預設值；`[]` 代表關閉 | — |
| `private_domains` | 無 | 命中時回報 MEDIUM。不分大小寫的子字串比對；填完整 hostname 誤判較少 | — |
| `custom_rules` | 無 | 自訂正規表示式，含 `description`、`pattern`、`severity`（預設 `HIGH`） | [自訂規則](#自訂規則) |
| `settings.max_chars` | `200000` | 每筆輸入的掃描上限。CLI 掃描前 `max_chars` 個字元；transparent 模式遇到更長的內容會拒絕，不會截斷後送出 | — |
| `settings.show_line_numbers` | `true` | 命中結果是否附上行號與欄位 | — |
| `settings.preview_length` | `60` | 第一個命中周圍、已遮罩的 `safePreview` 摘錄長度 | [敏感資訊預覽行為](cli.zh-TW.md#敏感資訊預覽行為) |
| `settings.encoding_detection` | `false` | 掃描前先解碼 Base64、URL、Hex 文字（OpenCode plugin 一律開啟） | [編碼檢測功能](cli.zh-TW.md#編碼檢測功能) |
| `settings.env_files` | 無 | 要做精確值比對的檔案 | [`.env` 精確值偵測](#env-精確值偵測) |
| `settings.rule_overrides` | `{}` | 依 id 開關內建規則，例如 `{ url: true, email: false }`。不認得的 id 會讓設定載入失敗 | [內建規則 id](#內建規則-id) |
| `settings.private_cidrs` | RFC 1918、CGNAT、link-local | opt-in 的 `private-ipv4` 規則要偵測的 IPv4 網段。列出清單會**取代**預設網段，例如只偵測自己的 VPN。CIDR 格式錯誤會讓設定載入失敗 | — |
| `settings.allowlist` | 無 | 任何規則都不回報的精確值。**這是真正的 bypass**：值會原樣送到模型 | [自訂規則](#自訂規則) |

長度與數量上限見[設定檔驗證](#設定檔驗證)。

## 內建規則 id

`settings.rule_overrides` 使用這些 id。除了下面標示的六條 opt-in 規則，其餘預設都開啟。

| 類別 | id |
|------|----|
| API key 與 token | `openai-key`、`anthropic-key`、`google-key`、`aws-access-key`、`aws-secret`、`github-pat`、`github-fine-grained-pat`、`github-oauth-app`、`stripe-live-secret`、`stripe-live-publishable`、`slack-bot`、`slack-user-app`、`huggingface-token`、`jwt`、`generic-bearer` |
| 密碼與憑證 | `generic-secret`、`pem-private-key`、`url-userinfo`、`db-connection`、`db-connection-ado` |
| 個資與金融資料 | `email`、`id-tw`、`passport-mrz`、`credit-card`、`iban`、`public-ipv4`、`phone-tw`（opt-in）、`phone-intl`（opt-in）、`ssn-us`（opt-in）、`tw-business-no`（opt-in） |
| 網路 | `private-ipv4`（opt-in）、`url`（opt-in） |

以下範例保留預設關鍵字、加入一個私有域名，並開啟 `private-ipv4` 只偵測一個網段：

```yaml
nda_keywords:
  - "CONFIDENTIAL"
  - "INTERNAL ONLY"
  - "DO NOT SHARE"
  - "NDA"
  # - "Project Phoenix"     # 自己的詞彙

private_domains:
  - "internal.example.com"

settings:
  encoding_detection: false
  rule_overrides:
    private-ipv4: true
  private_cidrs:
    - 10.20.0.0/16          # 取代預設私有網段
```

## `.env` 精確值偵測

只有當檔案內的值絕不該進入 LLM context 時才啟用：

```yaml
settings:
  env_files:
    - .env
    - .env.local
```

所有入口都會套用：OpenCode plugin、pi extension、Claude Code proxy、CLI 和 Web UI。它們都透過 `loadConfig()` 載入設定，`loadConfig()` 會依 `settings.env_files` 建立精確值偵測器，共用的掃描器再使用這個偵測器。

- **路徑**相對於一個根目錄，且不能離開它。OpenCode plugin 用專案目錄；pi extension、Claude Code proxy、CLI 和 Web UI 用啟動它們時所在的目錄（`process.cwd()`）。所以請在專案根目錄啟動 pi 或 proxy，否則相對路徑會指到別的地方。
- **值**：只讀取非空且至少 8 字元的 value，掃描準備送往模型的內容是否出現完全相同的值。不會自動讀取 `.env` 或 process 環境變數，載入的 value 不會傳給模型、寫入 log 或序列化。
- **修改已啟用的 env 檔後**，請重啟載入它的宿主（OpenCode、pi）、Claude Code proxy 或 Web UI；CLI 下次執行就會套用。
- **驗證**：OpenCode 有 `scripts/e2e/compare/` 的端到端測試工具搭配 `env_files` 執行。pi 和 Claude Code proxy 的涵蓋是依上述程式路徑推斷，尚未做端到端驗證。

**`envQueries` 是另一回事，只有 OpenCode 有。** 選擇性開啟的 `envQueries` plugin 選項，會針對同樣這些檔案提供三個唯讀工具（`guard_env_list`、`guard_env_inspect`、`guard_env_compare`），讓 agent 不看到值也能回答設定問題；只有搭配 `mode: "block"` 或 `"redact"` 才會生效；在 transparent 模式（包括預設）下會被忽略並顯示警告，`--doctor` 也會出現 `env-queries` 的 warn 檢查。它是除錯輔助，不是保護機制：遮罩靠的是上面的 `env_files`。pi 和 Claude Code proxy 沒有這些工具，`.env` 的保護效果也不受影響。見[唯讀 env 查詢](plugin/env-queries.zh-TW.md)。

## 自訂規則

```yaml
custom_rules:
  - description: "Company token"
    pattern: "MYCO_[A-Z0-9]{32}"
    severity: HIGH
    flags: "i"            # gimsuy 的子集；一律隱含 g
    word_boundary: true   # 只在字面 ASCII 單字字元的邊緣加 \b
    allow:                # 這條規則永不回報的完整字串
      - "MYCO_EXAMPLE0000000000000000000000000"
    # path: ["src/**"]    # 可設定，但尚未實作（見下方）

settings:
  allowlist:              # 任何規則都不回報的完整字串（見繞過警告）
    - "qa@example.com"
```

- **`flags`** — `gimsuy` 的任意子集；一律加上 `g`。預設為 `i`，既有規則仍維持不分大小寫。未知旗標（例如 `x`）會讓設定載入失敗；pattern 以最終旗標編譯，所以只在 `u` 下才無效的 pattern 也會載入失敗。零長度比對會被略過（沒有可回報或脫敏的值），掃描會繼續找後面的非空比對，Unicode 旗標下也一樣。
- **`word_boundary`** — 只在 pattern 邊緣是字面 ASCII 單字字元時加上 `\b`。CJK 邊緣（「機密」）不處理：兩個非單字字元之間不會成立 `\b`，加上去反而比對不到。邊緣是群組、字元類別、量詞或跳脫序列時無法安全加上，所以不會加，`--doctor` 會警告這條規則比看起來寬鬆——請自己在 pattern 寫 `\b`，例如 `\bEMP-\d{6}\b`。最外層的 alternation（`a|b`）是設定錯誤，請寫成 `(?:a|b)`。
- **`allow`／`settings.allowlist`** — 與命中文字完全相同才算，不是子字串也不是 regex。`allow` 只作用於該規則；`settings.allowlist` 作用於所有規則，包括內建規則與 `.env` exact value。上限：每條規則 32 筆、全域 64 筆、每筆 200 字元。
  **把真實密鑰加入 allowlist 是真正的繞過**：該值仍會不經遮罩離開本機，LeakShield 也不會把它回報為規則或 `.env` 命中。只用於你已判定不敏感的值。
  Unicode 規避診斷是另一回事：零寬字元或形似字母的警告，代表移除這些字元後會露出原文隱藏的命中，對原文設 allowlist 不會消除警告。單純的西里爾或希臘文字不會被標記。`--doctor` 會回報 allowlist 筆數、實測最多八筆，並回報無法實測的筆數（依賴上下文的 pattern 只能在實際位置判斷）。被抑制的次數會計數，不是靜默略過。
- **`path`** — 可設定也會驗證，但路徑範圍**尚未實作**：掃描器拿不到 prompt 或工具輸出的來源路徑。這些規則目前套用於所有掃描文字，設定 `path` 時 `--doctor` 會警告。

Allowlist 項目屬於設定檔的一部分，所以會改變設定檔指紋（檔案的 sha256），而授權比對的正是這個指紋。

### 需要標籤的 PII

內建規則認得的是能自己成立的格式。姓名、地址、生日、病歷號與裸護照號碼不是：同樣的字元在程式碼與一般文字裡到處都是。`config/guard.config.example.yaml` 附了一組註解掉的樣式，每一條都要旁邊有欄位標籤才會命中；唯一的例外是台灣地址，它靠城市名清單定位。

其中兩種已經有規則：`ssn-us`（opt-in，不需要標籤）與 `passport-mrz`（機器可讀區那一行，不需要標籤）。範例不再重複它們，改用 `rule_overrides`；MRZ 以外的護照號碼與 MAC 位址仍需要下面其中一條樣式。

寫這些樣式時量到四件事，也是它們長成這樣的原因：

- **姓名規則要保留 `flags: ""`。** 預設旗標是 `i`，所以 `Name` 標籤也會命中程式碼裡的每個 `name:` 鍵、CI 工作名稱，以及「Name this route」這種句子。以 18 行普通程式碼與文字實測，不分大小寫會有 4 筆誤報，區分大小寫則為 0。
- **自由文字的值要和標籤一起遮。** lookbehind 從右往左比對，分隔符長度可變時會從冒號本身開始，冒號一起被遮掉；把「標籤＋分隔符＋值」當成一個單位比對就沒有這個邊界，還原時仍是原文。
- **JSON 的鍵是帶引號的。** 像 `"mrn"` 這種鍵，名稱與冒號之間還有一個 `"`，所以分隔符類別要包含它；否則工具參數與設定檔 dump 一律不命中。
- **英文地址分支要求冒號與數字。** 程式碼裡叫 `address` 的賦值很常見（`address = server.address()`），在這個 repo 上還沒加這道閘門前有 5 筆誤報。台灣地址則用城市名清單：泛用的「市…區…路…號」樣式會把地址前面的動詞一起吃進遮罩。

這個 repo 自己的文字不是這幾種形狀的語料：掃 `src/`、`docs/`、`tests/`、`config/`（249 個檔案）完全沒有命中。零代表形狀不存在，不代表樣式安全。請用自己的流量量測，並刪掉用不到的標籤。量測紀錄見 [2026-11-25 label-gated PII](evidence/2026-11-25-label-gated-pii.md)。

## 設定檔驗證

動態規則的輸入長度在載入時會透過 Zod 驗證：

| 欄位 | 最大長度 |
|------|---------|
| `nda_keywords` 每個項目 | 200 字元 |
| `private_domains` 每個項目 | 255 字元 |
| `custom_rules` 的 `description` / `pattern` | 200 字元 |

超過長度限制的值會導致 `loadConfig()` 拋出 Zod 驗證錯誤，避免過長的 pattern 進入掃描器。

清單項目數也有上限，超過上限的設定檔會載入失敗：

| 欄位 | 最多項目數 |
|------|-----------|
| `nda_keywords` | 4096 |
| `private_domains` | 4096 |
| `custom_rules` | 1024 |

`custom_rules` 的 pattern 若無法編譯成正規表示式，`loadConfig()` 也會拋錯，並指出規則的索引和 `description`（不會印出 pattern）：無法執行的規則不能載入。可以編譯、但在固定測試輸入上跑得太慢的 pattern 會被當成疑似 ReDoS 而略過，stderr 會印警告，`leakshield --doctor` 也會出現 `custom-rules` 警告。這個檢查只是計時啟發式，不是保證：它只執行 pattern 一次，而且無法中斷執行，所以不能證明 pattern 安全。
