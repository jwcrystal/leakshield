---
status: accepted
date: 2026-11-06
---

# Code Mode 不還原原始碼，改在內層工具呼叫還原；可預見的「無聲錯誤」改為明確拒絕

OpenCode v2.2.5 的 `execute`（Code Mode，輸入 `{code}`）中，JavaScript 原始碼裡的 placeholder **維持原樣**；程式碼呼叫工具時，再依該工具的欄位規則（ADR-0001）還原（#78）。在 v2.2.5 上，自訂工具只能從 Code Mode 呼叫，所以舊做法是用 ADR-0002 的啟發式規則判斷整段 JavaScript。真實模型經常撞上這條規則：12 次帶 placeholder 的呼叫中有 8 次被拒、只有 1 次恢復；被拒後模型會放棄，或自行改寫 placeholder，結果有 4 次工具執行成功，但內容是錯的。宿主本來就會對程式碼呼叫的每個工具再觸發一次 hook，而且帶的是已求值的參數，所以把還原移到這一層，就不必猜原始碼的語法。

這樣做的副作用是會產生**無聲錯誤**：工具照常執行並回報成功，但實際拿到的是錯的值，模型和使用者都不會收到任何錯誤。以下兩種可預見的情況改成明確拒絕：

- **`execute` 原始碼同時含已映射的 placeholder 與 `fetch`**：內層的 fetch 送出的是 placeholder，遠端會回錯誤，模型就可能告訴使用者「金鑰無效」。這只是文字比對，用來避免誤導性的結果，**不是網路管控**；其他寫法不會被攔下，送出去的也只是 placeholder。
- **near-miss**：值明顯是由本 session 的 placeholder 衍生，但格式被改過（去掉方括號、改了分隔符或大小寫）。這項檢查適用所有工具，但只認 SGP2 格式。實測中，模型曾經去掉方括號後送進 `openchamber_render`，工具照常顯示了一段無效文字。

## Consequences

- 只遮蔽一部分、或被模型完全改寫的值偵測不到，會原樣交給工具。
- 宿主會把 Code Mode 內層呼叫的參數**以明文**存進 `execute` 的 metadata（見 `docs/evidence/2026-11-06-opencode-2.2.5-tool-restoration.md`）。這是宿主的行為，外掛無法改變。
