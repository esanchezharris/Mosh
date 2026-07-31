#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SOURCE="$ROOT/service/repair-helper/test/RepairHelperFixture.cpp"
HELPER_SOURCE="$ROOT/service/repair-helper/MoshRepairHelper.cpp"
IDENTITY="${MOSH_SIGN_IDENTITY:-}"

if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning |
    awk '/Developer ID Application/ { print $2; exit }')"
fi
[[ -n "$IDENTITY" ]] || {
  echo "No Developer ID Application identity is available." >&2
  exit 2
}

FIXTURE_RAW="$(mktemp -d "${TMPDIR:-/tmp}/mosh-repair-helper-live.XXXXXX")"
FIXTURE="$(cd "$FIXTURE_RAW" && pwd -P)"
cleanup() {
  if [[ "${MOSH_KEEP_REPAIR_HELPER_FIXTURE:-0}" == "1" ]]; then
    echo "fixture retained: $FIXTURE"
  else
    rm -rf "$FIXTURE"
  fi
}
trap cleanup EXIT
WORKTREE="$FIXTURE/worktree"
APP="$WORKTREE/build/Mosh.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
HELPER="$FIXTURE/MoshRepairHelper"
CALLER="$FIXTURE/MoshCaller"
MARKER="$FIXTURE/launched.txt"
STATUS="$FIXTURE/worker-status.txt"
CHECKPOINT="$(mktemp "$FIXTURE/checkpoint.XXXXXX.tracktionedit")"
SHA="0123456789abcdef0123456789abcdef01234567"

mkdir -p "$MACOS"
plutil -create xml1 "$CONTENTS/Info.plist"
plutil -insert CFBundleIdentifier -string studio.mosh.app "$CONTENTS/Info.plist"
plutil -insert CFBundleExecutable -string Mosh "$CONTENTS/Info.plist"
plutil -insert CFBundlePackageType -string APPL "$CONTENTS/Info.plist"

xcrun clang++ -std=c++20 -DMOSH_REPAIR_FIXTURE_CALLER "$SOURCE" -o "$CALLER"
xcrun clang++ -std=c++20 -DMOSH_REPAIR_FIXTURE_TARGET \
  "-DMOSH_REPAIR_FIXTURE_MARKER=\"$MARKER\"" \
  "-DMOSH_REPAIR_FIXTURE_SHA=\"$SHA\"" \
  "$SOURCE" -o "$MACOS/Mosh"
xcrun clang++ -std=c++20 "$HELPER_SOURCE" \
  -framework CoreFoundation -framework Security -o "$HELPER"

codesign --force --options runtime --timestamp \
  --identifier studio.mosh.app --sign "$IDENTITY" "$CALLER"
codesign --force --options runtime --timestamp \
  --identifier MoshRepairHelper --sign "$IDENTITY" "$HELPER"
codesign --force --options runtime --timestamp \
  --identifier studio.mosh.app --sign "$IDENTITY" "$MACOS/Mosh"
codesign --force --options runtime --timestamp \
  --identifier studio.mosh.app --sign "$IDENTITY" "$APP"

codesign --verify --strict --verbose=2 "$CALLER"
codesign --verify --strict --verbose=2 "$HELPER"
codesign --verify --deep --strict --verbose=2 "$APP"

if "$HELPER" probe "$$" >/dev/null 2>&1; then
  echo "Unsigned caller was accepted." >&2
  exit 5
fi
if "$HELPER" __worker-repair \
  "$APP" "$WORKTREE" "$SHA" "$CHECKPOINT" "$$" "$$" >/dev/null 2>&1; then
  echo "Unbound worker invocation was accepted." >&2
  exit 7
fi

codesign --remove-signature "$APP"
if "$CALLER" "$HELPER" handoff-repair \
  "$APP" "$WORKTREE" "$SHA" "$CHECKPOINT" __CALLER_PID__ >/dev/null 2>&1; then
  echo "Unsigned repair target was accepted." >&2
  exit 6
fi
codesign --force --options runtime --timestamp \
  --identifier studio.mosh.app --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

MOSH_REPAIR_HELPER_TEST_STATUS="$STATUS" \
  "$CALLER" "$HELPER" handoff-repair \
    "$APP" "$WORKTREE" "$SHA" "$CHECKPOINT" __CALLER_PID__ &
CALLER_PID=$!

for _ in {1..350}; do
  [[ -s "$MARKER" ]] && break
  sleep 0.1
done
[[ -s "$MARKER" ]] || {
  echo "Signed handoff did not launch the repair target." >&2
  [[ -s "$STATUS" ]] && sed 's/^/worker exit: /' "$STATUS" >&2
  exit 3
}
if kill -0 "$CALLER_PID" 2>/dev/null; then
  echo "Caller remained alive after handoff." >&2
  exit 4
fi
echo "signed repair handoff: PASS"
