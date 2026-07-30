#!/bin/bash
set -euo pipefail

BINARY="${1:-sensitive-guard}"
VERSION="${2:-1.0.0}"
APP_DIR="${BINARY}.app"
CONTENTS="${APP_DIR}/Contents"
MACOS="${CONTENTS}/MacOS"
RESOURCES="${CONTENTS}/Resources"

mkdir -p "${MACOS}" "${RESOURCES}"

cp "${BINARY}" "${MACOS}/sensitive-guard"
chmod +x "${MACOS}/sensitive-guard"

cp icon.icns "${RESOURCES}/icon.icns"

cat > "${CONTENTS}/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>sensitive-guard</string>
  <key>CFBundleIdentifier</key>
  <string>com.sensitive-guard.app</string>
  <key>CFBundleName</key>
  <string>Sensitive Guard</string>
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
