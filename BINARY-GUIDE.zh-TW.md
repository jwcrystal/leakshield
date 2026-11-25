# leakshield — Binary 快速入門

你手上是一個 `leakshield`（或 `leakshield.exe`）單一執行檔。不用 Node.js、不用 npm，直接跑。

它是 LeakShield CLI 的執行檔版本：用來明確掃描、脫敏和開 Web UI，本身不會保護 AI agent。OpenCode plugin 和 pi extension 由宿主從 npm 套件載入，Claude Code proxy 也還沒在這個執行檔中驗證過；要保護這些宿主，請安裝 npm 套件（`npm install -g leakshield`），並參考 [README](https://github.com/jwcrystal/leakshield/blob/main/README.zh-TW.md#快速開始)。

## 執行

```bash
# 掃描文字
./leakshield --text 'OPENAI_KEY=sk-xxxx secret="supersecret"'

# 掃描檔案
./leakshield --file ./config.ts

# 掃描目錄
./leakshield --dir ./src

# 從 stdin 讀取
cat .env | ./leakshield --stdin

# 啟動 Web UI（預設 port 3000）
./leakshield --web
```

## 脫敏（分享前遮蔽敏感值）

```bash
# 從 stdin 脫敏
cat .env | ./leakshield --redact --stdin

# 檔案脫敏後輸出到新檔
./leakshield --redact --file .env --out .env.redacted

# 只預覽會命中哪些，不輸出內容
./leakshield --redact --dry-run --file .env
```

## 結束代碼

| 代碼 | 意義 |
|------|------|
| 0 | 安全 — 無敏感內容 |
| 1 | 偵測到敏感內容 |
| 2 | 路徑錯誤（找不到檔案等） |

## 自訂設定

執行檔內建預設值可直接使用。若要自訂規則，將設定檔放在以下任一位置：

| 位置 | 範圍 |
|------|------|
| `./config/guard.config.yaml` | 當前目錄 |
| `~/.leakshield/guard.config.yaml` | 所有目錄（家目錄） |

```bash
# 把設定放到家目錄（全域生效）
mkdir -p ~/.leakshield
# 複製範例或自行建立
# 完整選項請參考專案的 config/guard.config.example.yaml
```

## 查看完整指令

```bash
./leakshield    # 顯示所有用法與選項
```

這是在終端機執行時的行為。在 pipe、CI 或腳本裡，stdin 不是終端機，它會改為讀取 stdin 直到 EOF；在這些環境請關閉或重導 stdin，以免一直等待。

## 自行建置

無法使用 Node.js 或 npm？用 [Bun](https://bun.sh) 建置成單一執行檔，目標機器不需任何 runtime。

執行檔就是把 CLI（`src/cli.ts`）編成單一檔案，不是另一種模式：

| 功能 | 執行檔 |
|------|--------|
| CLI 掃描與脫敏、Web UI | 支援 |
| `--claude-code-proxy`、`--doctor` | 有包含，但未在 Bun 編譯的執行檔中驗證；要保護宿主請用 npm 套件 |
| OpenCode plugin、pi extension | 無法使用：宿主載入的是 npm 套件，不是執行檔 |

```bash
# 一鍵建置當前平台
npm run binary

# 跨平台編譯
npm run binary:win     # Windows x64  → leakshield.exe
npm run binary:linux   # Linux x64    → leakshield-linux
npm run binary:all     # 全平台
```

或直接用 Bun：

```bash
bun build --compile --target=bun-windows-x64 ./src/cli.ts --outfile=leakshield.exe
```

產出單一執行檔，直接交給任何人，無任何相依套件。
