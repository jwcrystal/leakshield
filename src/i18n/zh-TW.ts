export const zhTW = {
  // engine — scan
  "scan.safe_summary": "✅ 未偵測到敏感內容，可以安全傳送。",
  "scan.unsafe_summary":
    "🚨 發現 {count} 個潛在敏感項目（HIGH: {high}, MEDIUM: {med}, LOW: {low}）",
  "scan.safe_recommendation": "內容看起來安全，但仍請確認沒有業務邏輯上的機密資訊。",
  "scan.unsafe_recommendation":
    "⛔ 建議先處理上述敏感項目後再傳送給 AI 服務。請用假資料、佔位符或移除敏感欄位後再重試。",

  // engine — redact
  "redact.safe_summary": "✅ 未偵測到敏感內容，無需脫敏。",
  "redact.unsafe_summary": "🔒 已脫敏 {count} 個敏感項目。",

  // cli — print result
  "cli.scan_target": "📋 掃描目標：{label}",
  "cli.hits": "{count} 個命中",
  "cli.location": " (第 {line} 行, 欄 {col})",
  "cli.preview": "      預覽：{preview}",
  "cli.more_of_type": "    … 還有 {count} 個相同類型",

  // cli — errors
  "cli.error_file_not_found": "❌ 找不到檔案：{path}",
  "cli.error_dir_not_found": "❌ 找不到目錄：{path}",
  "cli.error_redact_no_input": "❌ --redact 需搭配 --text、--file 或 --stdin",
  "cli.error_path": "❌ {error}",

  // cli — redact / dry-run
  "cli.dryrun_header": "\n[DRY-RUN] 將脫敏 {count} 個敏感項目於 {label}：",
  "cli.dryrun_safe": "  ✅ 未偵測到敏感內容，無需脫敏。",
  "cli.dryrun_location": " 第 {line} 行, 欄 {col}",
  "cli.dryrun_preview": "    預覽：{preview} → [REDACTED_{type}]",
  "cli.redact_written": "✅ 已將脫敏內容寫入：{path}",
  "cli.redact_footer": "[sensitive-guard] {summary}",

  // cli — dir mode
  "cli.scan_dir": "\n🔍 掃描目錄：{path}",
  "cli.ext_filter": "   副檔名篩選：{exts}",
  "cli.found_files": "   找到 {count} 個檔案\n",
  "cli.skipped_files": "   跳過 {count} 個無法讀取的檔案\n",
  "cli.dir_complete": "✅ 掃描完成，{count} 個檔案均未發現敏感內容。\n",

  // cli — inline label
  "cli.inline_label": "(直接輸入文字)",

  // cli — decision-aware output
  "cli.decision_warn_header": "提醒 — {risk} 風險：偵測到 {count} 個敏感項目",
  "cli.decision_confirm_header": "警告 — {risk} 風險：偵測到 {count} 個敏感項目（建議操作：{action}）",
  "cli.confirm_next_step": "下一步：使用 --format json 取得 redactedContent，或用 --redact 輸出脫敏版本。Exit code 1 = 已攔截。",

  // cli — usage
  "cli.usage_title": "\n🛡️  sensitive-guard — 敏感內容守門員\n",
  "cli.usage_heading": "用法：",
  "cli.usage_text": "  npm run scan -- --text '你的內容'",
  "cli.usage_file": "  npm run scan -- --file ./path/to/file.ts",
  "cli.usage_dir": "  npm run scan -- --dir ./src",
  "cli.usage_dir_ext": "  npm run scan -- --dir ./src --ext .ts .env .json",
  "cli.usage_stdin": "  cat file.ts | npm run scan -- --stdin",
  "cli.usage_redact_heading": "\n脫敏模式：",
  "cli.usage_redact_text": "  npm run scan -- --redact --text '你的內容'",
  "cli.usage_redact_file": "  npm run scan -- --redact --file ./secret.env",
  "cli.usage_redact_out":
    "  npm run scan -- --redact --file ./secret.env --out ./redacted.env",
  "cli.usage_redact_stdin": "  cat file.ts | npm run scan -- --redact --stdin",
  "cli.usage_redact_dryrun":
    "  npm run scan -- --redact --dry-run --file ./secret.env   # 只預覽，不輸出",
  "cli.usage_options_heading": "\n選項：",
  "cli.usage_opt_format": "  --format json          輸出 JSON（適合 CI/CD）",
  "cli.usage_opt_severity": "  --min-severity high    只回報 HIGH（或 medium / low）",
  "cli.usage_opt_redact": "  --redact               脫敏模式（輸出替換後文字）",
  "cli.usage_opt_dryrun": "  --dry-run              搭配 --redact，只預覽不輸出",
  "cli.usage_opt_out": "  --out <path>           搭配 --redact --file，指定輸出路徑",
  "cli.usage_opt_outside": "  --allow-outside        允許掃描工作目錄以外的路徑（預設禁止）",
  "cli.usage_opt_encoding": "  --enable-encoding-detection  啟用 Base64/URL/Hex 解碼檢測（預設關閉）",
  "cli.usage_mcp_heading": "\nMCP Server 模式（由 OpenCode 自動啟動）：",
  "cli.usage_mcp": "  node dist/index.js",

  // web — server start
  "web.server_title": "🛡️  sensitive-guard web UI",
  "web.server_url": "   http://localhost:{port}",
  "web.server_stop": "   Ctrl+C 停止",
};
