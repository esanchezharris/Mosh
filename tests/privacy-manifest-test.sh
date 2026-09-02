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
"$ROOT/scripts/release/check-plist-keys.sh" "$APP" privacy-test
