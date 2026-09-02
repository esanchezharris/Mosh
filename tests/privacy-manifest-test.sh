#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

APP="$TMP/Mosh.app"
PLIST="$APP/Contents/Info.plist"
mkdir -p "$APP/Contents/Resources"
touch "$APP/Contents/Resources/MoshDoc.icns"

/usr/bin/plutil -create xml1 "$PLIST"
/usr/bin/plutil -insert NSMicrophoneUsageDescription -string "Audio recording" "$PLIST"
/usr/bin/plutil -insert NSSpeechRecognitionUsageDescription -string "stale voice feature" "$PLIST"

cmake \
  -DPLIST="$PLIST" \
  -DMOSH_SPARKLE_FEED_URL= \
  -DMOSH_SPARKLE_PUBLIC_KEY= \
  -P "$ROOT/cmake/InjectInfoPlistKeys.cmake"

if /usr/bin/plutil -extract NSSpeechRecognitionUsageDescription raw "$PLIST" >/dev/null 2>&1; then
  echo "NSSpeechRecognitionUsageDescription must be absent" >&2
  exit 1
fi

/usr/bin/plutil -extract NSMicrophoneUsageDescription raw "$PLIST" >/dev/null
grep -q 'type == WKMediaCaptureTypeCamera' "$ROOT/src/webview/WebViewCameraPermission.mm"
grep -q 'WKPermissionDecisionDeny' "$ROOT/src/webview/WebViewCameraPermission.mm"
mkdir -p "$APP/Contents/MacOS"
printf '%s\n' 'SFSpeechRecognizer' > "$APP/Contents/MacOS/Mosh"
if "$ROOT/scripts/release/check-plist-keys.sh" "$APP" stale-binary >/dev/null 2>&1; then
  echo "a stale Speech-capable binary must be rejected" >&2
  exit 1
fi
printf '%s\n' 'recording-only binary fixture' > "$APP/Contents/MacOS/Mosh"
"$ROOT/scripts/release/check-plist-keys.sh" "$APP" privacy-test
