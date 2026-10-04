#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
app="$PWD/YuiVoiceChanger.app"
if [ ! -d "$app/Contents/MacOS" ]; then
  echo '同じフォルダにYuiVoiceChanger.appを置いてください。'; read -r; exit 1
fi
if [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" != 'com.suzunayui.yuivoicechanger' ]; then
  echo '対象のアプリが違います。'; exit 1
fi
if ! /usr/bin/osascript -e 'display dialog "この試用版はAppleの公証を受けていません。公式GitHub Releasesから取得したファイルであることを確認してください。YuiVoiceChanger.appの隔離属性を解除し、このMac内だけで有効な署名を付けて起動します。" buttons {"キャンセル", "起動準備をする"} default button "キャンセル" cancel button "キャンセル"'; then
  exit 0
fi
entitlements="$(/usr/bin/mktemp)"
trap 'rm -f "$entitlements"' EXIT
cat > "$entitlements" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
<key>com.apple.security.cs.disable-library-validation</key><true/>
<key>com.apple.security.device.audio-input</key><true/>
</dict></plist>
PLIST
attributes="$(/usr/bin/xattr -lr "$app")"
if [[ "$attributes" == *com.apple.quarantine* ]]; then
  /usr/bin/xattr -dr com.apple.quarantine "$app"
fi
/usr/bin/codesign --force --deep --sign - --entitlements "$entitlements" "$app"
/usr/bin/codesign --verify --deep "$app"
/usr/bin/open "$app"
echo '起動準備が完了しました。次回はYuiVoiceChanger.appから起動できます。'
