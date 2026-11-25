# 需要標籤的 PII：樣式與誤報量測

日期：2026-11-25
背景：README 的偵測表把姓名、地址、生日、護照、SSN、病歷號、MAC、組織名都列為未涵蓋。這份紀錄量的是「其中哪些用 regex 就能安全地補」，以及候選樣式在普通程式碼與文字上會打到什麼。結論寫進 `config/guard.config.example.yaml`（註解掉的範例）與 `docs/configuration.md` 的「Label-gated PII」。

## 方法

- 候選樣式以 `custom_rules` 載入，用 `tsx src/cli.ts --file … --redact`（看實際遮罩範圍）與 `--dir … --format json`（看計數）各跑一次。
- 語料一：repo 自己的 `src/`、`docs/`、`tests/`、`config/` 與 `README.md`，共 248 個 `.ts`／`.md`／`.yaml`／`.json` 檔。只統計候選規則的 description，內建規則（email、API key、NDA 關鍵字）的命中是既有行為，不列入。
- 語料二：普通程式碼與設定（`name:` 鍵、CI 工作名稱、TypeScript 型別、`address = …` 賦值、`passport` 套件版本）與一般文字（欄位標籤、地址、日期、SSN、MAC、護照號碼）。
- 正控：15 行典型表單寫法（含 JSON 形狀的鍵），每個項目都要命中。
- 測試樣本不進 repo：內容是看起來像真資料的形狀，留在暫存目錄。

## 結果

| 候選規則 | 正控 | 普通程式碼／文字誤報 | repo 248 檔 |
|---|---|---|---|
| 病歷號（標籤） | 3/3 | 1（`mrn:` 這種程式欄位） | 0 |
| 生日（標籤） | 4/4 | 0 | 0 |
| 姓名（標籤，區分大小寫） | 3/3 | 0 | 0 |
| 姓名（標籤，預設不分大小寫） | 3/3 | 4 | 0 |
| 台灣地址（城市清單） | 2/2 | 0 | 0 |
| 地址（標籤，加閘門後） | 3/3 | 0 | 0 |
| 地址（標籤，初版） | 3/3 | 5（`address = …` 賦值） | 0 |
| 美國 SSN | 1/1 | 0 | 0 |
| MAC 位址 | 1/1 | 0 | 0 |
| 護照號碼（標籤） | 2/2 | 0 | 0 |

repo 的 0 是「形狀不存在」，不是「樣式安全」：248 個檔案裡沒有任何台灣地址、SSN 或 MAC 字面值，所以這份語料對這幾條規則幾乎沒有判別力。真正的 FP 證據來自語料二，而語料二只有幾十行，不足以決定預設值。

## 量測時抓到的六個問題（都已修在範例樣式裡）

1. **`flags` 預設是 `i`，`Name` 標籤會命中 `name:`。** 程式碼、CI、JSON 到處都是 `name:`，加上「Name this route」這類句子，18 行裡就有 4 筆。姓名規則因此固定 `flags: ""`；`姓名` 是 CJK，不受影響。
2. **日期尾端沒有邊界會截斷命中範圍。** 一個「月/日/年」順序的日期在尾端 `\d{1,2}` 的版本只遮到年份前兩碼，剩下兩碼留在明文——在 transparent 模式就是部分外洩。改成 `\d{1,4}(?![0-9])`。
3. **`護照號碼` 這種寫法漏接。** 原本只認 `護照`，標籤後面接「號碼」時 lookbehind 不成立。改成 `護照(?:號碼|號)?`。
4. **可變長度的 lookbehind 分隔符會吃掉冒號。** 分隔符類別寫成 `{0,3}` 時，比對可以從冒號本身開始（lookbehind 由右往左比對），遮罩就少了冒號。自由文字的值改成「標籤＋分隔符＋值」整段比對。
5. **英文地址分支被程式碼賦值命中。** `address = server.address() as AddressInfo` 這類寫法在 repo 裡造成 5 筆誤報；改成要求冒號且值含數字，才保留「Address 冒號＋門牌」這種真表單。
6. **規則會命中自己的說明文字與範例值。** description 寫 `Passport number`、`Address after a label`，以及註解裡放一個像真的 JSON 鍵值，都會被相鄰的規則比對到。範例與說明改成不含可命中的形狀；這也是文件只描述形狀、不放完整樣本的原因。

另外：JSON 的鍵是帶引號的，分隔符類別要包含 `"`，否則工具參數與設定檔 dump 不會命中；單引號在 YAML 單引號字串裡要寫成 `''`，範例省略。

## 決策

- 這批樣式**只當範例出貨**，`custom_rules` 仍預設空。理由：唯一能預設開的規則是「形狀本身可驗證」的，而姓名／地址／日期沒有驗證碼可依賴；在 block 模式下誤報等於多一次拒送，在 transparent 模式下等於多一次過度遮罩。
- 下一步可以做成 builtin 並預設開的是需要檢查碼的三類：護照 MRZ（ICAO 9303）、台灣統一編號、美國 SSN（有效區段）。其中 MRZ 與統編的檢查碼無法用 regex 表達，只能靠 `Rule.validate`，所以一定要進 `src/rules/builtin.ts`。
- NER 仍未實作，也不是這批工作的前置條件；它補的是沒有標籤的自由散文，成本主要在把 `scanText()` 的同步介面改成 async（見 `docs/plans/2026-10-07-detection-hardening-plan.md` 的 NER 評估項）。

## 重現

```bash
# 把 config/guard.config.example.yaml 中註解掉的樣式取消註解，放進暫存目錄的
# config/guard.config.yaml，然後：
npx tsx src/cli.ts --file <樣本> --redact
npx tsx src/cli.ts --dir ./src --ext .ts --format json --min-severity low
```

repo 內的 `--dir` 結果，候選規則應為 0 筆；若出現命中，先確認是不是範例文件被掃到，而不是真的 PII。
