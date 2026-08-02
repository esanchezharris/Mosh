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
PRIOR_APP="$FIXTURE/PriorMosh.app"
PRIOR_CONTENTS="$PRIOR_APP/Contents"
PRIOR_MACOS="$PRIOR_CONTENTS/MacOS"
HELPER="$FIXTURE/MoshRepairHelper"
SUBSTITUTED_HELPER="$FIXTURE/SubstitutedRepairHelper"
CALLER="$FIXTURE/MoshCaller"
MARKER="$FIXTURE/launched.txt"
RACE_MARKER="$FIXTURE/race-launched.txt"
PRIOR_MARKER="$FIXTURE/prior-launched.txt"
STATUS="$FIXTURE/worker-status.txt"
CHECKPOINT="$(mktemp "$FIXTURE/checkpoint.XXXXXX.tracktionedit")"
SHA="0123456789abcdef0123456789abcdef01234567"
REPAIR_ID="11111111-1111-4111-8111-111111111111"
PLAYTEST_ID="22222222-2222-4222-8222-222222222222"

mkdir -p "$MACOS"
mkdir -p "$PRIOR_MACOS"
plutil -create xml1 "$CONTENTS/Info.plist"
plutil -insert CFBundleIdentifier -string studio.mosh.app "$CONTENTS/Info.plist"
plutil -insert CFBundleExecutable -string Mosh "$CONTENTS/Info.plist"
plutil -insert CFBundlePackageType -string APPL "$CONTENTS/Info.plist"
plutil -create xml1 "$PRIOR_CONTENTS/Info.plist"
plutil -insert CFBundleIdentifier -string studio.mosh.app "$PRIOR_CONTENTS/Info.plist"
plutil -insert CFBundleExecutable -string Mosh "$PRIOR_CONTENTS/Info.plist"
plutil -insert CFBundlePackageType -string APPL "$PRIOR_CONTENTS/Info.plist"

xcrun clang++ -std=c++20 -DMOSH_REPAIR_FIXTURE_CALLER "$SOURCE" -o "$CALLER"
xcrun clang++ -std=c++20 -DMOSH_REPAIR_FIXTURE_TARGET \
  "-DMOSH_REPAIR_FIXTURE_MARKER=\"$MARKER\"" \
  "-DMOSH_REPAIR_FIXTURE_SHA=\"$SHA\"" \
  "-DMOSH_REPAIR_FIXTURE_ID=\"$REPAIR_ID\"" \
  "$SOURCE" -o "$MACOS/Mosh"
xcrun clang++ -std=c++20 -DMOSH_REPAIR_FIXTURE_TARGET \
  -DMOSH_REPAIR_FIXTURE_PRIOR_TARGET \
  "-DMOSH_REPAIR_FIXTURE_MARKER=\"$PRIOR_MARKER\"" \
  "-DMOSH_REPAIR_FIXTURE_SHA=\"$SHA\"" \
  "-DMOSH_REPAIR_FIXTURE_ID=\"$REPAIR_ID\"" \
  "$SOURCE" -o "$PRIOR_MACOS/Mosh"
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
codesign --force --options runtime --timestamp \
  --identifier studio.mosh.app --sign "$IDENTITY" "$PRIOR_MACOS/Mosh"
codesign --force --options runtime --timestamp \
  --identifier studio.mosh.app --sign "$IDENTITY" "$PRIOR_APP"

codesign --verify --strict --verbose=2 "$CALLER"
codesign --verify --strict --verbose=2 "$HELPER"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign --verify --deep --strict --verbose=2 "$PRIOR_APP"

TEAM_ID="$(codesign -dv --verbose=4 "$HELPER" 2>&1 | awk -F= '/^TeamIdentifier=/{print $2; exit}')"
[[ "$TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || {
  echo "Signed helper has no valid TeamIdentifier." >&2
  exit 13
}
HELPER_REQUIREMENT="identifier \"MoshRepairHelper\" and certificate leaf[subject.OU] = \"$TEAM_ID\""
codesign --verify --strict --verbose=2 "-R=$HELPER_REQUIREMENT" "$HELPER"
cp "$HELPER" "$SUBSTITUTED_HELPER"
codesign --force --sign - "$SUBSTITUTED_HELPER"
codesign --verify --strict "$SUBSTITUTED_HELPER"
if codesign --verify --strict "-R=$HELPER_REQUIREMENT" "$SUBSTITUTED_HELPER" >/dev/null 2>&1; then
  echo "Ad-hoc helper substitution satisfied the pinned helper requirement." >&2
  exit 14
fi

if "$HELPER" probe "$$" >/dev/null 2>&1; then
  echo "Unsigned caller was accepted." >&2
  exit 5
fi
if "$HELPER" __worker-repair \
  "$APP" "$WORKTREE" "$SHA" "$CHECKPOINT" "$REPAIR_ID" "$PLAYTEST_ID" \
  "$$" "$$" "$$" "$$" >/dev/null 2>&1; then
  echo "Unbound worker invocation was accepted." >&2
  exit 7
fi
if "$CALLER" "$HELPER" handoff-repair \
  "$APP" "$WORKTREE" "$SHA" "$CHECKPOINT" "$REPAIR_ID" __CALLER_PID__ \
  >/dev/null 2>&1; then
  echo "Repair handoff without a playtest ID was accepted." >&2
  exit 15
fi
if "$CALLER" "$HELPER" handoff-repair \
  "$APP" "$WORKTREE" "$SHA" "$CHECKPOINT" "$REPAIR_ID" not-a-playtest __CALLER_PID__ \
  >/dev/null 2>&1; then
  echo "Repair handoff with a malformed playtest ID was accepted." >&2
  exit 16
fi

codesign --remove-signature "$APP"
if "$CALLER" "$HELPER" handoff-repair \
  "$APP" "$WORKTREE" "$SHA" "$CHECKPOINT" "$REPAIR_ID" "$PLAYTEST_ID" __CALLER_PID__ >/dev/null 2>&1; then
  echo "Unsigned repair target was accepted." >&2
  exit 6
fi
codesign --force --options runtime --timestamp \
  --identifier studio.mosh.app --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

MOSH_REPAIR_HELPER_TEST_STATUS="$STATUS" \
  "$CALLER" "$HELPER" handoff-repair \
    "$APP" "$WORKTREE" "$SHA" "$CHECKPOINT" "$REPAIR_ID" "$PLAYTEST_ID" __CALLER_PID__ &
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

MOSH_ACTIVE_REPAIR_SOURCE_SHA="$SHA" \
MOSH_ACTIVE_REPAIR_ID="$REPAIR_ID" \
MOSH_REPAIR_HELPER_TEST_STATUS="$STATUS" \
  "$CALLER" "$HELPER" handoff-prior \
    "$CHECKPOINT" "$PRIOR_APP" "$REPAIR_ID" "$APP" "$PLAYTEST_ID" __CALLER_PID__ &
ROLLBACK_CALLER_PID=$!

for _ in {1..350}; do
  [[ -s "$PRIOR_MARKER" ]] && break
  sleep 0.1
done
[[ -s "$PRIOR_MARKER" ]] || {
  echo "Signed rollback did not launch the prior target." >&2
  [[ -s "$STATUS" ]] && sed 's/^/worker exit: /' "$STATUS" >&2
  exit 11
}
if kill -0 "$ROLLBACK_CALLER_PID" 2>/dev/null; then
  echo "Rollback caller remained alive after handoff." >&2
  exit 12
fi
: > "$PRIOR_MARKER"

xcrun clang++ -std=c++20 -DMOSH_REPAIR_FIXTURE_TARGET \
  "-DMOSH_REPAIR_FIXTURE_MARKER=\"$RACE_MARKER\"" \
  "-DMOSH_REPAIR_FIXTURE_SHA=\"$SHA\"" \
  "-DMOSH_REPAIR_FIXTURE_ID=\"$REPAIR_ID\"" \
  "$SOURCE" -o "$MACOS/Mosh"
codesign --force --options runtime --timestamp \
  --identifier studio.mosh.app --sign "$IDENTITY" "$MACOS/Mosh"
codesign --force --options runtime --timestamp \
  --identifier studio.mosh.app --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

MOSH_REPAIR_HELPER_TEST_STATUS="$STATUS" \
  "$CALLER" __RACE_HANDOFFS__ \
    "$HELPER" handoff-repair \
      "$APP" "$WORKTREE" "$SHA" "$CHECKPOINT" "$REPAIR_ID" "$PLAYTEST_ID" __CALLER_PID__ \
    __SECOND_HANDOFF__ \
    "$HELPER" handoff-prior \
      "$CHECKPOINT" "$PRIOR_APP" "$REPAIR_ID" "$APP" "$PLAYTEST_ID" __CALLER_PID__ &
RACE_CALLER_PID=$!

for _ in {1..350}; do
  [[ -s "$RACE_MARKER" || -s "$PRIOR_MARKER" ]] && break
  sleep 0.1
done
[[ -s "$RACE_MARKER" || -s "$PRIOR_MARKER" ]] || {
  echo "Concurrent signed handoff did not launch a target." >&2
  [[ -s "$STATUS" ]] && sed 's/^/worker exit: /' "$STATUS" >&2
  exit 8
}
if kill -0 "$RACE_CALLER_PID" 2>/dev/null; then
  echo "Concurrent handoff caller remained alive." >&2
  exit 9
fi
HANDOFF_SETTLE_TICKS=20
for ((tick = 0; tick < HANDOFF_SETTLE_TICKS; ++tick)); do sleep 0.1; done
REPAIR_LAUNCHES=0
PRIOR_LAUNCHES=0
[[ ! -f "$RACE_MARKER" ]] || REPAIR_LAUNCHES="$(wc -l < "$RACE_MARKER" | tr -d ' ')"
[[ ! -f "$PRIOR_MARKER" ]] || PRIOR_LAUNCHES="$(wc -l < "$PRIOR_MARKER" | tr -d ' ')"
[[ "$((REPAIR_LAUNCHES + PRIOR_LAUNCHES))" == "1" ]] || {
  echo "Concurrent handoff launched more than one target." >&2
  exit 10
}
echo "signed repair handoff and rollback: PASS"
