# Sensitive Guard

敏感內容掃描後的處置語言。以下用語描述設計概念；列入詞彙表不代表功能已實作。

## Language

**Redact（遮蔽）**:
以不可逆的同類占位符替換敏感片段；目前同類型不同值可能共用占位符。

**De-identify（穩定去識別化）**:
以不保留還原映射、同值穩定的占位符替換敏感片段，保留同一值的出現關係；不宣稱無法由外部資訊推回原值，也不宣稱達到法律上的匿名化。此處置尚未實作。
_Avoid_: Tokenize、匿名化

**Pseudonymize（假名化）**:
以可逆占位符替換敏感片段，並分開保管原值對應關係。transparent 模式即此處置（issue #22）：記憶體映射為預設；`persistence.enabled` 時映射加密持久化於 `SGP.db`（per-entry AES-256-GCM，金鑰走 keychain→keyfile→記憶體降級階梯），重啟後可水合還原。
_Avoid_: Tokenize
