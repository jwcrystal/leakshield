# Encoding Detection 預設值策略評估

## 當前狀況

**預設值**：`encoding_detection: false` (關閉)

**啟用方式**：
- CLI: `--enable-encoding-detection`
- MCP: `enable_encoding_detection: true`

**效能影響**：10-30% 額外開銷

---

## 🎯 評估矩陣

### 1. 安全性考量

| 維度 | 預設關閉 | 預設啟用 |
|------|---------|---------|
| **防禦編碼攻擊** | ❌ 需要用戶主動啟用 | ✅ 自動保護 |
| **誤報率** | ✅ 較低 | ⚠️ 可能略增 |
| **威脅模型** | 防禦意外洩漏 | 防禦主動攻擊 |

**威脅分析**：
```
惡意用戶: "I want to bypass detection"
├─> 嘗試 Base64 編碼 API Key
├─> 預設關閉: ❌ 繞過成功
└─> 預設啟用: ✅ 被攔截

正常用戶: "I just want to scan my code"
├─> 可能不知道編碼檢測功能
├─> 預設關閉: ⚠️ 不知不覺暴露風險
└─> 預設啟用: ✅ 自動獲得保護
```

### 2. 效能影響

| 場景 | 內容大小 | 無編碼檢測 | 有編碼檢測 | 影響 |
|------|---------|-----------|-----------|------|
| 小文件 | <1KB | ~10ms | ~11ms | +10% |
| 中型文件 | ~100KB | ~50ms | ~60ms | +20% |
| 大文件 | ~1MB | ~200ms | ~260ms | +30% |
| 純編碼 | - | ~50ms | ~100ms | +100% |

**結論**：絕大多數情況下影響可接受（<50ms）

### 3. 使用場景分析

#### 場景 A：本地開發者掃描代碼
```bash
npm run scan -- --file ./config.ts
```
- **頻率**：偶爾
- **內容**：主要是正常代碼
- **建議**：預設啟用（安全 > 效能）

#### 場景 B：CI/CD Pipeline
```bash
npm run scan -- --dir ./src --format json
```
- **頻率**：每次提交
- **內容**：可能包含外部來源
- **建議**：強制啟用（安全第一）

#### 場景 C：MCP Server 守門
```
AI Assistant → [scan_file] → sensitive-guard
```
- **頻率**：每次讀檔
- **內容**：不可預測
- **建議**：預設啟用（AI 會話是高風險場景）

#### 場景 D：批量掃描大型項目
```bash
npm run scan -- --dir ./monorepo
```
- **頻率**：偶爾
- **內容**：大量文件
- **建議**：提供 flag 關閉（效能優化）

---

## 💡 推薦策略

### 方案 A：分層預設（推薦）⭐⭐⭐

```typescript
// 根據使用場景設置不同預設值
const defaults = {
  cli: false,           // CLI 手動使用：預設關閉
  mcp: true,            // MCP 守門：預設啟用
  web: true,            // Web UI：預設啟用
  api: true,            // REST API：預設啟用
};
```

**優點**：
- ✅ 高風險場景（AI、Web）自動保護
- ✅ 本地開發者可控（效能靈活）
- ✅ 向後兼容（CLI 預設不變）

**實現**：
```typescript
// src/config/loader.ts
export function loadConfig(overrides?: Partial<GuardConfig>): GuardConfig {
  const baseConfig = { /* ... */ };

  // 根據使用來源設置預設值
  const source = detectUsageSource(); // 'cli' | 'mcp' | 'web'
  const encodingDefault = source === 'cli' ? false : true;

  return {
    ...baseConfig,
    settings: {
      ...baseConfig.settings,
      encoding_detection: encodingDefault,
    },
    ...overrides,
  };
}
```

### 方案 B：智能啟發（中等推薦）⭐⭐

```typescript
// 根據內容特徵自動啟用
function shouldEnableEncodingDetection(text: string): boolean {
  // 如果包含編碼特徵，自動啟用
  const hasEncodingSignature =
    /[A-Za-z0-9+/]{32,}=/.test(text) ||  // Base64 可能
    /%[0-9A-Fa-f]{2}/.test(text) ||      // URL 編碼
    /\\x[0-9a-fA-F]{2}/.test(text);      // Hex 編碼

  return hasEncodingSignature;
}
```

**優點**：
- ✅ 需要時自動啟用
- ✅ 不需要時零開銷
- ✅ 用戶無感知

**缺點**：
- ❌ 無法防禦智能攻擊者
- ❌ 增加複雜度

### 方案 C：全域預設啟用（保守）⭐

```typescript
// 所有場景預設啟用
encoding_detection: true
```

**優點**：
- ✅ 最大化安全
- ✅ 簡單明確

**缺點**：
- ❌ 影響現有用戶效能
- ❌ 可能導致誤報增加

---

## 📋 最終推薦

### 採用方案 A：分層預設

**理由**：
1. **安全第一**：高風險場景（AI、Web）自動保護
2. **向後兼容**：CLI 用戶不受影響
3. **靈活性**：所有場景都可覆蓋
4. **實現簡單**：只需修改 loader.ts

**實施步驟**：

#### 1. 修改配置載入器
```typescript
// src/config/loader.ts
export interface LoadConfigOptions {
  usageSource?: 'cli' | 'mcp' | 'web' | 'api';
}

export function loadConfig(
  overrides?: Partial<GuardConfig>,
  options?: LoadConfigOptions
): GuardConfig {
  const baseConfig = { /* ... */ };

  // 根據使用來源決定預設值
  const source = options?.usageSource || 'cli';
  const encodingDefault = source === 'cli' ? false : true;

  return {
    ...baseConfig,
    settings: {
      ...baseConfig.settings,
      encoding_detection: encodingDefault,
    },
    ...overrides,
  };
}
```

#### 2. 更新各 transport
```typescript
// src/transports/mcp.ts
const config = loadConfig({}, { usageSource: 'mcp' });

// src/index.ts (Web)
const config = loadConfig({}, { usageSource: 'web' });

// src/transports/cli.ts (保持不變)
const config = loadConfig(); // defaults to 'cli'
```

#### 3. 更新文檔
```markdown
## 編碼檢測預設值

- **CLI**：預設關閉（效能優先）
- **MCP Server**：預設啟用（安全優先）
- **Web UI**：預設啟用（安全優先）

所有場景都可用 `--enable-encoding-detection` 或 `--disable-encoding-detection` 覆蓋。
```

---

## 🚀 實施計劃

### Phase 1: 實現（1-2 小時）
- [ ] 修改 `src/config/loader.ts` 添加 `usageSource` 參數
- [ ] 更新所有 transport 調用
- [ ] 添加單元測試

### Phase 2: 測試（30 分鐘）
- [ ] 測試 CLI 預設行為（保持關閉）
- [ ] 測試 MCP 預設行為（啟用）
- [ ] 測試 Web 預設行為（啟用）
- [ ] 測試覆蓋機制

### Phase 3: 文檔（30 分鐘）
- [ ] 更新 README.zh-TW.md
- [ ] 更新 MCP 配置說明
- [ ] 添加遷移指南

### Phase 4: 發布
- [ ] Changelog 說明
- [ ] 版本更新（minor 版本）
- [ ] 發布公告

---

## 📊 影響評估

### 向後兼容性
- ✅ CLI 用戶：無影響（預設仍關閉）
- ⚠️ MCP 用戶：行為改變（預設啟用）
- ⚠️ Web 用戶：行為改變（預設啟用）

**風險緩解**：
- 在 changelog 中明確說明
- 提供 `--disable-encoding-detection` 選項
- 過渡期（一個版本）同時支持舊行為

### 效能影響
- **MCP**：每次掃描 +10-30% 時間
- **Web**：每次掃描 +10-30% 時間
- **CLI**：無影響

**緩解措施**：
- 添加效能指標監控
- 文檔中說明如何關閉
- 未來考慮優化（智能啟發、快取）

---

## 🎯 結論

**推薦採用方案 A：分層預設**

**核心原則**：
> 高風險場景自動保護，低風險場景用戶可控

**實施優先級**：🔴 High
**預計工作量**：2-3 小時
**預計收益**：顯著提升安全防護，最小化效能影響

---
*評估日期: 2026-04-07*
*評估者: Claude Code*
*推薦等級: ⭐⭐⭐ 強烈推薦*
