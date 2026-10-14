# 🚀 編碼檢測優化建議

## 當前實現狀態

### ✅ 已完成功能
- Base64 解碼檢測
- URL 解碼檢測
- Hex 解碼檢測
- 集成到主掃描流程
- CLI 和 MCP 工具支援
- 配置選項控制

### 📊 基礎效能表現
根據基準測試（`tests/benchmark/encoding-detection.test.ts`）：
- **平均額外開銷**: 約 10-30%
- **小內容**: 影響較小（~10ms）
- **大內容**: 影響較明顯（~50-100ms）
- **純編碼內容**: 開銷最高（需要解碼 + 掃描）

---

## 🔧 進一步優化方向

### 1. **效能優化** (推薦優先級: 中)

#### 1.1 快取機制 (Caching)
```typescript
// 對已知的編碼字串進行快取
const decodeCache = new Map<string, DecodingResult>();

function tryDecodeBase64(encoded: string): DecodingResult | null {
  if (decodeCache.has(encoded)) {
    return decodeCache.get(encoded)!;
  }
  
  const result = decodeBase64(encoded);
  if (result) {
    decodeCache.set(encoded, result);
  }
  return result;
}
```

**優點**:
- 重複內容不重複解碼
- 減少 CPU 使用
- 適合批次掃描相同內容

**實現成本**: 低
**預期改善**: 20-40% （重複內容場景）

#### 1.2 並行處理 (Parallel Processing)
```typescript
async function scanTextWithDecoding(text: string, config: GuardConfig) {
  const results = await Promise.all([
    scanTextInternal(text, config),
    tryDecodeAllEncodings(text, config),
  ]);
  
  return mergeResults(results);
}
```

**優點**:
- 減少總掃描時間
- 適合大內容

**實現成本**: 中
**預期改善**: 30-50% （大內容場景）

#### 1.3 深度限制 (Depth Limit)
```typescript
const MAX_DECODE_DEPTH = 2; // 防止嵌套編碼 DoS

function tryDecodeBase64(encoded: string, depth: number = 0): DecodingResult | null {
  if (depth > MAX_DECODE_DEPTH) return null;
  
  const decoded = decodeBase64(encoded);
  if (decoded && looksLikeEncoded(decoded.decoded)) {
    return tryDecodeBase64(decoded.decoded, depth + 1);
  }
  return decoded;
}
```

**優點**:
- 防止嵌套編碼攻擊
- 保護系統穩定性

**實現成本**: 低
**重要性**: 高（安全性）

---

### 2. **檢測準確度提升** (推薦優先級: 高)

#### 2.1 智能啟發檢測
```typescript
// 只在可能包含編碼時啟用解碼
function shouldEnableEncodingDetection(text: string): boolean {
  // 快速檢查：是否包含編碼特徵
  const hasEncodingSignature = 
    /[A-Za-z0-9+/]{32,}=/.test(text) ||  // Base64 可能
    /%[0-9A-Fa-f]{2}/.test(text) ||      // URL 編碼
    /\\x[0-9a-fA-F]{2}/.test(text);       // Hex 編碼
  
  return hasEncodingSignature;
}
```

**優點**:
- 減少不必要的解碼開銷
- 保留安全性

**實現成本**: 低
**預期改善**: 50-70% （正常內容場景）

#### 2.2 上下文感知解碼
```typescript
// 根據關鍵字上下文決定解碼優先級
const HIGH_VALUE_KEYWORDS = [
  'api', 'key', 'secret', 'token', 'password',
  'sk-', 'ghp_', 'gho_', 'aws_',
];

function getDecodeConfidence(decoded: string): number {
  const hasKeyword = HIGH_VALUE_KEYWORDS.some(kw 
    => decoded.toLowerCase().includes(kw)
  );
  
  return hasKeyword ? 0.9 : 0.5;
}
```

**優點**:
- 減少誤報
- 提高檢測準確度

**實現成本**: 中
**重要性**: 高（用戶體驗）

#### 2.3 編碼類型識別
```typescript
// 識別不同編碼格式並選擇最佳策略
interface EncodingSignature {
  type: 'base64' | 'url' | 'hex' | 'mixed';
  confidence: number;
  priority: number;
}

function detectEncodingType(text: string): EncodingSignature {
  // 分析特徵並返回編碼類型和可信度
  // ...
}
```

**優點**:
- 更精準的檢測
- 減少無用的解碼嘗試

**實現成本**: 中
**預期改善**: 20-30% （效能）

---

### 3. **擴展編碼支援** (推薦優先級: 低)

#### 3.1 更多編碼格式
- **JSON 編碼**: 檢測 JSON 中的嵌套敏感資料
- **XML 編碼**: 解析 XML 結構
- **YAML 編碼**: 解析 YAML 配置

**實現複雜度**: 高
**投資回報**: 中（特定場景）

#### 3.2 自動偵測編碼語言
```typescript
// 使用統計方法自動識別編碼
function detectEncodingLanguage(encoded: string): string {
  // Base64, Base32, Base58, Ascii85, ...
}
```

**實現複雜度**: 高
**投資回報**: 低（邊緣案例）

---

### 4. **可觀測性改進** (推薦優先級: 中)

#### 4.1 詳細的日誌記錄
```typescript
interface DecodingMetrics {
  encodingType: string;
  decodeTime: number;
  scanTime: number;
  foundSensitiveData: boolean;
  confidence: number;
}

function logDecodingMetrics(metrics: DecodingMetrics) {
  console.debug(`[Encoding Detection] ${metrics.encodingType}:`, {
    time: `${metrics.decodeTime.toFixed(2)}ms`,
    confidence: metrics.confidence,
    found: metrics.foundSensitiveData,
  });
}
```

#### 4.2 Prometheus 指標
```typescript
// 暴露指標給監控系統
const encodingDetectionCounter = new Counter({
  name: 'encoding_detection_attempts_total',
  help: 'Total encoding detection attempts',
  labelNames: ['encoding_type', 'result'],
});

const decodingDuration = new Histogram({
  name: 'encoding_detection_duration_seconds',
  help: 'Time spent decoding',
  labelNames: ['encoding_type'],
});
```

---

## 🎯 推薦實施路徑

### 階段 1: 快速優化 (1-2 週)
1. **實現深度限制** (防止 DoS) ⭐⭐⭐
2. **添加智能啟發** (減少開銷) ⭐⭐⭐
3. **實現快取機制** (提升效能) ⭐⭐

### 階段 2: 準確度提升 (2-3 週)
1. **上下文感知解碼** (降低誤報) ⭐⭐⭐
2. **詳細日誌記錄** (可觀測性) ⭐⭐
3. **編碼類型識別** (精準檢測) ⭐⭐

### 階段 3: 進階功能 (按需實施)
1. **並行處理** (大內容優化)
2. **Prometheus 指標** (生產監控)
3. **擴展編碼支援** (特殊場景)

---

## 📋 實施檢查清單

### 優化前
- [ ] 建立效能基線
- [ ] 設定改進目標
- [ ] 準備回滾計劃

### 實施中
- [ ] 分階段實施
- [ ] 每階段測試驗證
- [ ] 監控效能指標

### 實施後
- [ ] 對照基線測試
- [ ] 更新文檔說明
- [ ] 收集用戶反饋

---

## 🔬 測試策略

### 效能測試
```bash
# 執行基準測試
npm test -- tests/benchmark/encoding-detection.test.ts

# 比較不同配置的效能
npm test -- tests/benchmark/*.test.ts
```

### 回歸測試
- 確保所有現有測試通過
- 驗證向後兼容性
- 檢查沒有引入新問題

### 壓力測試
```bash
# 測試極端情況
echo "A".repeat(1000000) | npm run scan -- --enable-encoding-detection --stdin

# 測試嵌套編碼
nested=$(echo "test" | base64 | base64 | base64)
echo $nested | npm run scan -- --enable-encoding-detection --stdin
```

---

## 💡 設計原則

1. **安全第一**: 優化不能犧牲安全性
2. **向後兼容**: 新功能不能破壞現有用法
3. **按需啟用**: 預設關閉，用戶選擇啟用
4. **可觀測**: 提供足夠的調試資訊
5. **效能平衡**: 在安全和效能之間找到平衡點

---

## 📞 反饋與改進

如果您有特定的優化需求或發現效能問題，請：

1. 開 issue 描述問題
2. 提供重現步驟
3. 附上效能基準數據
4. 提議期望的改進目標

---

*文檔版本: 1.0.0*  
*最後更新: 2026-04-07*
