# sensitive-guard — Binary 快速入門

你手上是一個 `sensitive-guard`（或 `sensitive-guard.exe`）單一執行檔。不用 Node.js、不用 npm，直接跑。

## 執行

```bash
# 掃描文字
./sensitive-guard --text 'OPENAI_KEY=sk-xxxx secret="supersecret"'

# 掃描檔案
./sensitive-guard --file ./config.ts

# 掃描目錄
./sensitive-guard --dir ./src

# 從 stdin 讀取
cat .env | ./sensitive-guard --stdin

# 啟動 Web UI（預設 port 3000）
./sensitive-guard --web
```

## 脫敏（分享前遮蔽敏感值）

```bash
# 從 stdin 脫敏
cat .env | ./sensitive-guard --redact --stdin

# 檔案脫敏後輸出到新檔
./sensitive-guard --redact --file .env --out .env.redacted

# 只預覽會命中哪些，不輸出內容
./sensitive-guard --redact --dry-run --file .env
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
| `~/.sensitive-guard/guard.config.yaml` | 所有目錄（家目錄） |

```bash
# 把設定放到家目錄（全域生效）
mkdir -p ~/.sensitive-guard
# 複製範例或自行建立
# 完整選項請參考專案的 config/guard.config.example.yaml
```

## 查看完整指令

```bash
./sensitive-guard    # 顯示所有用法與選項
```
