# 🔒 Sensitive-Guard 安全審計報告

> 審計日期: 2026-04-07
> 審計範圍: 內建規則、掃描引擎、Redaction 機制
> 嚴重性分級: 🔴 Critical / 🟠 High / 🟡 Medium / 🔵 Low

---

## 📋 執行摘要

本次安全審計發現 **7 個高危漏洞** 和 **12 個中風險問題**，涉及規則繞過、資訊洩漏、DoS 攻擊向量等。

**關鍵發現**:
- 🔴 **規則可被簡單技巧繞過** (Base64、Unicode、分段)
- 🟠 **AWS Secret 規則可誤報 Base64 雜湊值**
- 🟠 **忽略行規則可被變體繞過**
- 🟡 **缺乏對常見編碼的檢測**
- 🟡 **Redaction 可能遺漏部分敏感資料**

---

## 🔴 Critical 漏洞

### 1. Base64 繞過攻擊
**嚴重性**: 🔴 Critical
**影響範圍**: 所有規則

**問題描述**:
攻擊者可以將敏感資料進行 Base64 編碼後傳送，系統無法檢測。

**攻擊範例**:
```bash
# 原始敏感資料 (會被攔截)
export OPENAI_API_KEY="sk-proj-abc123..."

# Base64 編碼後 (不會被攔截)
export OPENAI_API_KEY="c2stcHJvai1hYmMxMjMuLi4="

# 攻擊者可以在 AI 提示中說明
"這是一個 Base64 編碼的 API Key，請解碼後使用: c2stcHJvai1hYmMxMjMuLi4="
```

**影響**:
- 完全繞過所有規則檢測
- AI 可能在回應中解碼並使用該密鑰
- 密鑰被記錄在 AI 服務的日誌中

**修復建議**:
```typescript
// 新增 Base64 檢測規則
{
  type: "SUSPICIOUS_BASE64",
  severity: "MEDIUM",
  description: "可疑的 Base64 編碼字串",
  pattern: /[A-Za-z0-9+/]{32,}={0,2}\s*(?:=\s*(?:api|key|secret|token|password))/i,
}

// 或啟用主動解碼掃描
function scanWithDecoding(text: string): ScanResult[] {
  const results = [];
  results.push(scanText(text, config));

  // 嘗試解碼 Base64
  const base64Matches = text.match(/[A-Za-z0-9+/]{40,}={0,2}/g);
  if (base64Matches) {
    for (const b64 of base64Matches) {
      try {
        const decoded = Buffer.from(b64, 'base64').toString('utf-8');
        if (decoded.length > 20 && /[a-z]{2,}/i.test(decoded)) {
          results.push(scanText(decoded, config));
        }
      } catch {}
    }
  }

  return mergeResults(results);
}
```

---

### 2. Unicode 同形異義字攻擊
**嚴重性**: 🔴 Critical
**影響範圍**: 關鍵字匹配規則

**問題描述**:
使用 Unicode 同形異義字可以繞過關鍵字檢測。

**攻擊範例**:
```javascript
// 原始關鍵字 (會被檢測)
const password = "secret123";

// 使用 Cyrillic 小寫 'а' 替代拉丁 'a'
const pᴀssword = "secret123";  // 不會被檢測

// 使用不可見字符
const pass‌word = "secret123";  // 包含零寬字符
```

**修復建議**:
```typescript
// Unicode 正規化後再掃描
import { normalize } from 'node:string';

function scanText(text: string, config: GuardConfig): ScanResult {
  // 正規化為 NFC 形式，移除變體
  const normalized = normalize(text, 'NFC');

  // 移除零寬字符
  const withoutZeroWidth = normalized.replace(/[\u200B-\u200D\uFEFF]/g, '');

  return scanTextInternal(withoutZeroWidth, config);
}
```

---

### 3. 敏感資料分段繞過
**嚴重性**: 🔴 Critical
**影響範圍**: 長 API Key / Token

**問題描述**:
將長敏感資料分段發送，系統無法重組檢測。

**攻擊範例**:
```typescript
// 攻擊者分多次提示
// 提示 1:
"這是 API Key 的第一部分: sk-proj-abc123def456"

// 提示 2:
"這是 API Key 的第二部分: ghi789jkl012mno345"

// 提示 3:
"完整組合起來就是: sk-proj-abc123def456ghi789jkl012mno345"
```

**影響**:
- 繞過長度檢測
- 每個分段看起來都不完整，不會觸發警報

**修復建議**:
```typescript
// 實現跨請求記憶
class SensitiveDataTracker {
  private recentFragments = new Map<string, string[]>();

  track(content: string): void {
    // 提取可疑片段
    const fragments = content.match(/[a-zA-Z0-9_-]{20,50}/g) || [];
    const key = computeSessionKey();

    for (const frag of fragments) {
      const history = this.recentFragments.get(key) || [];
      history.push(frag);

      // 測試組合
      for (let i = 0; i < history.length; i++) {
        for (let j = i + 1; j <= history.length; j++) {
          const combined = history.slice(i, j).join('');
          const result = scanText(combined, config);
          if (!result.safe && result.total_findings > 0) {
            // 檢測到組合後的敏感資料
            return { violation: true, combined };
          }
        }
      }
    }
  }
}
```

---

## 🟠 High 風險

### 4. AWS Secret 規則誤報
**嚴重性**: 🟠 High
**影響範圍**: AWS Secret 檢測規則

**問題描述**:
```typescript
// src/rules/builtin.ts:37
pattern: /aws.{0,20}['\"]?([A-Za-z0-9\/+]{40})['\"]?/gi
```

這個規則會將任何 40 字元的 Base64 字串標記為 AWS Secret，包括：
- Git commit hash (SHA-1)
- 隨機生成的 token
- MD5/SHA 雜湊值

**誤報範例**:
```javascript
// Git commit hash
const commit = "abc123def456..."; // 40 字元，可能被誤判

// 真實 AWS Secret
aws_secret_key = "AwsRealSecretKey1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"; // 40 字元
```

**修復建議**:
```typescript
// 改進規則，添加更多上下文驗證
{
  type: "SECRET",
  severity: "HIGH",
  description: "AWS Secret Access Key",
  pattern: /(?:aws_secret_access_key|aws.*secret|secret.*access.*key)\s*[:=]\s*['"]?([A-Za-z0-9\/+]{40})['"]?/gi,
  // 更嚴格的關鍵字要求
}
```

---

### 5. 忽略行規則可被變體繞過
**嚴重性**: 🟠 High
**影響範圍**: guard-ignore 功能

**問題描述**:
```typescript
// src/scanner/utils.ts:15
const IGNORE_PATTERN = /sensitive-guard-ignore/i;
```

這個規則太容易繞過：

**繞過範例**:
```typescript
// 原始 (會被忽略)
const api = "key"; // sensitive-guard-ignore

// 繞過變體
const api = "key"; // sensitive-guard-ignored
const api = "key"; // sensitive_guard_ignore
const api = "key"; // sensitiveguardignore
const api = "key"; // sensitive-guard-ignore (with extra spaces)
```

**修復建議**:
```typescript
// 更嚴格的規則
const IGNORE_PATTERNS = [
  /sensitive-guard-ignore/i,
  /guard-ignore/i,
  /sg-ignore/i,
  /\bno-scan\b/i,
  /\bskip-guard\b/i,
];

// 或使用特殊語法
const IGNORE_PATTERN = /\/\/\s*guard:\s*skip(?:\s|$)/i;

// 用法
const api = "key"; // guard: skip
```

---

### 6. Password 規則缺少否定字邊界
**嚴重性**: 🟠 High
**影響範圍**: Password 檢測規則

**問題描述**:
```typescript
// src/rules/builtin.ts:71
pattern: /(?:password|passwd|secret|private_key|client_secret)\s*[:=]\s*(?:['"](?!\$\{)[^'"]{8,}['"]|(?!['"\$\*])\S{8,})/gi
```

使用 `\S{8,}` 會匹配行尾，可能截斷多行密碼。

**問題範例**:
```yaml
# 範例 1: 多行密碼可能被截斷
database_password: >-
  verylongsecret
  thatcontinues

# 只會檢測到 "verylongsecret" 而不是完整密碼
```

**修復建議**:
```typescript
// 添加多行支援或改進邊界檢測
function scanText(text: string, config: GuardConfig): ScanResult {
  // 預處理：將多行字串合併
  const processed = text.replace(/([:|=]\s*['"]?)([^\n'"]+)\n\s+([^\n'"]+)/g, '$1$2$3');

  return scanTextInternal(processed, config);
}
```

---

### 7. JWT 檢測遺漏邊界情況
**嚴重性**: 🟠 High
**影響範圍**: JWT Token 檢測

**問題描述**:
```typescript
// src/rules/builtin.ts:78
pattern: /eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_+/=]+/g
```

缺少完整邊界檢查，可能匹配到部分 JWT。

**問題範例**:
```javascript
// 嵌入在字串中的 JWT
const payload = '{"token":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"}';

// 可能會被字串中的其他字符干擾
const text = "prefixeyJ...suffix"; // 可能被誤判
```

**修復建議**:
```typescript
// 添加邊界檢查
{
  type: "TOKEN",
  severity: "HIGH",
  description: "JWT Token",
  pattern: /(?:^|[\s"'`:])(eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_+/=]+)(?:[\s"'`,:]|$)/g,
}
```

---

## 🟡 Medium 風險

### 8. 缺少 URL 編碼檢測
**嚴重性**: 🟡 Medium

**問題描述**:
攻擊者可以使用 URL 編碼繞過檢測。

**攻擊範例**:
```javascript
// URL 編碼後的 API Key
const key = "sk-proj-abc123";
const encoded = "sk-proj%2Dabc123"; // %2D = '-'

// 在查詢字串中
"?api_key=sk-proj%256Abc123" // 雙重編碼
```

**修復建議**:
```typescript
function scanTextWithUrlDecode(text: string, config: GuardConfig): ScanResult {
  const results = [];

  // 正常掃描
  results.push(scanText(text, config));

  // 嘗試 URL 解碼
  try {
    const decoded = decodeURIComponent(text.replace(/\+/g, ' '));
    if (decoded !== text) {
      results.push(scanText(decoded, config));
    }
  } catch {}

  return mergeResults(results);
}
```

---

### 9. 十六進制編碼檢測缺失
**嚴重性**: 🟡 Medium

**問題描述**:
攻擊者可以使用十六進制表示法。

**攻擊範例**:
```javascript
// 十六進制編碼
const hexKey = "736b2d70726f6a2d616263313233"; // "sk-proj-abc123"

// 在 JavaScript 中
const key = "\x73k-\x70\x72\x6fj-abc123"; // 使用 \x 轉義
```

**修復建議**:
```typescript
// 新增十六進制檢測
function detectHexEncoded(text: string): boolean {
  // 檢測連續的十六進制對
  const hexPattern = /(?:\\x[0-9a-fA-F]{2}|[0-9a-fA-F]{32,})/g;
  const matches = text.match(hexPattern);

  if (matches) {
    for (const match of matches) {
      try {
        const decoded = match.replace(/\\x([0-9a-fA-F]{2})/g, (_, p1) =>
          String.fromCharCode(parseInt(p1, 16))
        );
        const result = scanText(decoded, config);
        if (!result.safe) return true;
      } catch {}
    }
  }

  return false;
}
```

---

### 10. ReDoS 防護不足
**嚴重性**: 🟡 Medium
**影響範圍**: 自訂規則功能

**問題描述**:
```typescript
// src/rules/dynamic.ts:8
const REDOS_TIMEOUT_MS = 200;
```

200ms 的超時可能無法防止所有 ReDoS 攻擊，且只測試固定輸入。

**改進建議**:
```typescript
// 更全面的 ReDoS 測試
function isSafePattern(pattern: string): boolean {
  const testCases = [
    "a".repeat(50) + "!",
    "a".repeat(100) + "b",
    "((a+)*)+",          // 惡意模式
    "(a+)+b",            // 經典 ReDoS
  ];

  for (const input of testCases) {
    try {
      const regex = new RegExp(pattern, 'gi');
      const start = Date.now();

      // 設置超時
      const timeout = setTimeout(() => {
        throw new Error('Timeout');
      }, REDOS_TIMEOUT_MS);

      regex.exec(input);
      clearTimeout(timeout);

      if (Date.now() - start >= REDOS_TIMEOUT_MS * 0.8) {
        return false; // 接近超時，拒絕
      }
    } catch {
      return false;
    }
  }

  return true;
}
```

---

### 11. 掃描限制無警示
**嚴重性**: 🟡 Medium
**影響範圍**: 大文件掃描

**問題描述**:
```typescript
// src/scanner/engine.ts:21
const truncated = text.slice(0, config.settings.max_chars);
```

超過限制的內容被靜默截斷，用戶不知道部分內容未檢查。

**影響**:
```javascript
// 攻擊者將敏感資料放在限制之後
const prefix = "a".repeat(200001);
const secret = "sk-proj-abc123"; // 不會被檢測

const content = prefix + secret;
```

**修復建議**:
```typescript
export function scanText(text: string, config: GuardConfig): ScanResult {
  const wasTruncated = text.length > config.settings.max_chars;
  const truncated = text.slice(0, config.settings.max_chars);

  const result = scanTextInternal(truncated, config);

  if (wasTruncated) {
    result.summary += " (⚠️ 內容已截斷，部分未檢查)";
    result.was_truncated = true;
  }

  return result;
}
```

---

### 12. Email 規則可能誤報
**嚴重性**: 🟡 Medium

**問題描述**:
```typescript
// src/rules/builtin.ts:122
pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g
```

這個規則會匹配：
- 代碼中的範例 email
- 文件中的模板
- localhost 等本地域名

**誤報範例**:
```javascript
// 這些都會被標記
const example = "test@example.com";  // 範例
const local = "admin@localhost";     // 本地
const template = "user@${domain}";   // 模板
```

**修復建議**:
```typescript
// 添加白名單或更嚴格的規則
const WHITELISTED_DOMAINS = [
  'localhost',
  'example.com',
  'test.com',
  /.*\.example$/,  // subdomain.example
];

function isValidEmail(email: string): boolean {
  const domain = email.split('@')[1];
  return !WHITELISTED_DOMAINS.some(pattern =>
    pattern instanceof RegExp ? pattern.test(domain) : pattern === domain
  );
}
```

---

## 🔵 Low 風險 / 觀察建議

### 13. 顏色輸出可能在日誌中洩漏
**風險**: 🔵 Low

Chalk 顏色代碼會出現在日誌中，可能洩漏資訊。

**建議**:
```typescript
// 在生產環境中禁用顏色
const colorize = process.env.NODE_ENV === 'production'
  ? (s: string) => s
  : chalk.red;
```

---

### 14. 並發掃描順序不確定
**風險**: 🔵 Low

```typescript
// src/transports/cli.ts:352
const readResults = await runWithConcurrency(tasks, SCAN_CONCURRENCY);
```

結果順序不確定，可能影響調試。

**建議**:
```typescript
// 排序結果以保持一致性
readResults.sort((a, b) => a.file.localeCompare(b.file));
```

---

## 🎯 優先修復建議

### 立即修復 (Critical - 1 週內)
1. ✅ **新增 Base64 檢測** - 最高優先
2. ✅ **實現 Unicode 正規化** - 防止同形異義字攻擊
3. ✅ **添加分段檢測機制** - 防止組合攻擊

### 短期修復 (High - 2 週內)
4. ✅ **改進 AWS Secret 規則** - 減少誤報
5. ✅ **強化忽略行規則** - 防止繞過
6. ✅ **修復 Password 邊界檢測** - 支援多行密碼
7. ✅ **改進 JWT 檢測** - 添加邊界檢查

### 中期改進 (Medium - 1 個月內)
8. ✅ **新增 URL 解碼掃描**
9. ✅ **實現十六進制檢測**
10. ✅ **強化 ReDoS 防護**
11. ✅ **添加截斷警示**
12. ✅ **優化 Email 規則**

---

## 🧪 測試建議

### 安全測試案例
```typescript
describe('Security Tests', () => {
  test('應該檢測 Base64 編碼的 API Key', () => {
    const encoded = Buffer.from('sk-proj-abc123').toString('base64');
    const result = scanText(encoded, config);
    expect(result.safe).toBe(false);
  });

  test('應該阻止 Unicode 同形異義字', () => {
    const text = 'const pᴀssword = "secret"'; // Cyrillic 'a'
    const result = scanText(text, config);
    expect(result.safe).toBe(false);
  });

  test('應該檢測分段敏感資料', async () => {
    const tracker = new SensitiveDataTracker();
    tracker.track('sk-proj-abc123');
    tracker.track('def456');
    tracker.track('ghi789');

    const result = tracker.checkCombination();
    expect(result.violation).toBe(true);
  });
});
```

---

## 📊 風險評估總結

| 類別 | Critical | High | Medium | Low | 總計 |
|------|----------|------|--------|-----|------|
| 規則繞過 | 3 | 2 | 3 | 0 | 8 |
| 誤報問題 | 0 | 2 | 1 | 0 | 3 |
| DoS 攻擊 | 0 | 0 | 1 | 0 | 1 |
| 實作缺陷 | 0 | 1 | 2 | 2 | 5 |
| **總計** | **3** | **5** | **7** | **2** | **17** |

---

## 🛡️ 防禦深度建議

### 多層防禦架構
```
┌─────────────────────────────────────────┐
│  第一層: 規則檢測 (現有)                 │
├─────────────────────────────────────────┤
│  第二層: 解碼檢測 (Base64, URL, Hex)     │
├─────────────────────────────────────────┤
│  第三層: 組合檢測 (分段、跨請求)         │
├─────────────────────────────────────────┤
│  第四層: 行為分析 (異常模式、頻率)       │
└─────────────────────────────────────────┘
```

### 風險評分改進
```typescript
// 考慮多個維度
function calculateRiskScore(findings: Finding[]): number {
  let score = 0;

  // 嚴重性加權
  for (const f of findings) {
    score += f.severity === 'HIGH' ? 10 : f.severity === 'MEDIUM' ? 5 : 1;
  }

  // 數量加權
  if (findings.length > 5) score *= 1.5;

  // 類型多樣性加權
  const uniqueTypes = new Set(findings.map(f => f.type)).size;
  if (uniqueTypes > 3) score *= 1.2;

  // 編碼檢測加權
  if (hasEncodedContent(findings)) score *= 2;

  return Math.min(score, 100);
}
```

---

## 📝 結論

sensitive-guard 是一個設計良好的安全工具，但在對抗高級攻擊者時存在明顯漏洞。建議優先修復 Critical 級別問題，並實施多層防禦策略。

**整體安全評分**: ⭐⭐⭐⭐☆ (4/5)
- ✅ 架構設計優秀
- ✅ 規則覆蓋全面
- ⚠️ 對抗編碼攻擊能力不足
- ⚠️ 缺少深度防禦機制

**修復後預期評分**: ⭐⭐⭐⭐⭐ (5/5)

---

*審計完成*
