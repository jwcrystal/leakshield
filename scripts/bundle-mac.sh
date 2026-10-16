#!/bin/bash
set -euo pipefail

BINARY="${1:-leakshield}"
VERSION="${2:-1.0.0}"
APP_DIR="${BINARY}.app"
CONTENTS="${APP_DIR}/Contents"
MACOS="${CONTENTS}/MacOS"
RESOURCES="${CONTENTS}/Resources"

mkdir -p "${MACOS}" "${RESOURCES}"

cp "${BINARY}" "${MACOS}/leakshield"
chmod +x "${MACOS}/leakshield"

cp icon.icns "${RESOURCES}/icon.icns"

cat > "${CONTENTS}/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>leakshield</string>
  <key>CFBundleIdentifier</key>
  <string>com.leakshield.app</string>
  <key>CFBundleName</key>
  <string>LeakShield</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleIconFile</key>
  <string>icon</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
EOF

echo "✅ ${APP_DIR} created"
