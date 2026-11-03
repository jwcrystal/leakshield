# 映射持久化（選擇性開啟）

> 🌐 [English](./persistence.md) | 繁體中文

[← README](../../README.zh-TW.md#opencode-plugin建議使用)

> ⚠️ 開啟前請先讀[持久化風險須知](../../README.zh-TW.md#持久化風險須知開啟前必讀)。

## 啟用

transparent 模式設定 `"persistence": { "enabled": true }` 後，已保存映射以 per-entry AES-256-GCM（AAD 綁 session＋token）加密持久於 SQLite（預設 `~/.local/share/leakshield/SGP.db`），session 首次觸及時水合，供跨重啟還原。

需要 Node.js 22.13 以上（內建 `node:sqlite`）；較舊的 runtime 無法開啟 store，映射維持僅在記憶體並記錄 WARN。

選項：`ttlDays`（預設 7；0＝僅手動清除）、`path`（儲存位置）、`keyFile`/`keyfilePath`（無 OS keychain 環境的較弱降級）。

## 金鑰保管

金鑰走 OS keychain（macOS Keychain／Windows DPAPI／Linux libsecret）→ 明確啟用的 keyfile → 記憶體降級。

## `--doctor` 與 log 回報的內容

Runtime log 在成功開啟 store 時記錄 `persistence: active; key=os-keychain|keyfile`，後續降級另有 WARN；缺金鑰不直接拒絕對話，但未保存的舊 token 仍可能被工具防線拒絕。

`--doctor` 只查設定／DB 可讀性，標示 **尚未驗證 runtime 啟用與解密**，不碰真實 keychain。

## 保留與清除

TTL 在 writer 開啟 store 時清理，非定時刪除；保存變動映射會延長期限，單純讀取不延長，7 天不是嚴格刪除期限。

啟用不能找回先前已遺失的映射。

主動清除：`leakshield --forget --all`（或 `--session <id>`）刪除持久映射，輸出僅計數。

擦除為邏輯層＋檔內盡力（`secure_delete` 清零釋放頁、`forget --all` 另做 VACUUM 與 WAL 截斷）；實體媒體與備份殘留（SSD wear-leveling、快照、還原）不在保證範圍。

開啟後若切換金鑰來源（keychain↔keyfile），store 會拒開並降級 memory-only，直到 `forget --all` 重置——不靜默換 key。
