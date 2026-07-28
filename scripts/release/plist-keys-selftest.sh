#!/usr/bin/env bash
# plist-keys-selftest.sh — unit test for the Info.plist key contract shared by
# cmake/InjectInfoPlistKeys.cmake and scripts/release/check-plist-keys.sh.
# Same shape as scripts/auto-loop/deps-freshness-selftest.sh: builds throwaway fixtures
# in a temp dir, asserts, prints PASS/FAIL. No network, no build, ~1s.
#
#   bash scripts/release/plist-keys-selftest.sh
#
# WHY IT EXISTS: the Sparkle keys are written by the BUILD and then a COPY step re-runs
# the same injector on the staged bundle as a TCC safety net. For one release, "the
# caller said nothing about Sparkle" and "the caller said Sparkle is off" were the same
# code path, so that copy step silently deleted SUFeedURL and SUPublicEDKey from every
# staged app. Nothing errored. The build log was clean. The shipped app simply could
# never find an update, and would have stayed that way indefinitely.
#
# Case 1 below is that exact bug. Break the `if (NOT DEFINED …) return()` guard in
# InjectInfoPlistKeys.cmake and case 1 fails — verified, not assumed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
INJECT="$REPO/cmake/InjectInfoPlistKeys.cmake"
CHECK="$HERE/check-plist-keys.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAILED=0
ok()   { printf '  ok    %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; FAILED=1; }

# A minimal bundle carrying the three unconditional usage keys, so the unrelated half
# of check-plist-keys.sh passes and only the Sparkle behaviour is under test.
make_bundle() {                       # $1 = dest .app
  local app="$1"
  rm -rf "$app"; mkdir -p "$app/Contents"
  /usr/bin/plutil -create xml1 "$app/Contents/Info.plist"
  /usr/bin/plutil -replace NSSpeechRecognitionUsageDescription -string "x" "$app/Contents/Info.plist"
  /usr/bin/plutil -replace NSCameraUsageDescription            -string "x" "$app/Contents/Info.plist"
  /usr/bin/plutil -replace NSBonjourServices -json '["_moshcompanion._tcp"]' "$app/Contents/Info.plist"
}
key() {                               # $1 = plist, $2 = key → value or empty
  /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null || true
}

FEED="https://example.invalid/appcast.xml"
EDKEY="TESTKEYTESTKEYTESTKEYTESTKEYTESTKEYTESTKEY="

# ── 1. repair mode (no -D) must LEAVE the Sparkle keys ALONE ──────────────────────
APP="$TMP/repair.app"; make_bundle "$APP"; P="$APP/Contents/Info.plist"
/usr/bin/plutil -replace SUFeedURL     -string "$FEED"  "$P"
/usr/bin/plutil -replace SUPublicEDKey -string "$EDKEY" "$P"
cmake -DPLIST="$P" -P "$INJECT" >/dev/null 2>&1
if [ "$(key "$P" SUFeedURL)" = "$FEED" ] && [ "$(key "$P" SUPublicEDKey)" = "$EDKEY" ]; then
  ok "repair mode (no -D) preserves SUFeedURL + SUPublicEDKey"
else
  bad "repair mode STRIPPED the Sparkle keys — the staged-release bug is back"
fi

# ── 2. authoritative set ──────────────────────────────────────────────────────────
APP="$TMP/set.app"; make_bundle "$APP"; P="$APP/Contents/Info.plist"
cmake -DPLIST="$P" -DMOSH_SPARKLE_FEED_URL="$FEED" -DMOSH_SPARKLE_PUBLIC_KEY="$EDKEY" \
      -P "$INJECT" >/dev/null 2>&1
if [ "$(key "$P" SUFeedURL)" = "$FEED" ] && [ "$(key "$P" SUPublicEDKey)" = "$EDKEY" ] \
   && [ "$(key "$P" SUScheduledCheckInterval)" = "86400" ]; then
  ok "authoritative set writes feed + key + check interval"
else
  bad "authoritative set did not write all three keys"
fi

# ── 3. authoritative empty removes all three (flipping Sparkle OFF) ───────────────
cmake -DPLIST="$P" -DMOSH_SPARKLE_FEED_URL= -DMOSH_SPARKLE_PUBLIC_KEY= -P "$INJECT" >/dev/null 2>&1
if [ -z "$(key "$P" SUFeedURL)" ] && [ -z "$(key "$P" SUPublicEDKey)" ] \
   && [ -z "$(key "$P" SUScheduledCheckInterval)" ]; then
  ok "authoritative empty removes feed + key + interval (no stale URL left behind)"
else
  bad "authoritative empty left a Sparkle key behind"
fi

# ── 4. a feed with no key must FAIL check-plist-keys ──────────────────────────────
APP="$TMP/halfconf.app"; make_bundle "$APP"; P="$APP/Contents/Info.plist"
/usr/bin/plutil -replace SUFeedURL -string "$FEED" "$P"
if "$CHECK" "$APP" selftest >/dev/null 2>&1; then
  bad "check-plist-keys ACCEPTED a bundle with SUFeedURL and no SUPublicEDKey"
else
  ok "check-plist-keys rejects SUFeedURL with no SUPublicEDKey"
fi

# ── 5. no Sparkle at all is a legitimate bundle ───────────────────────────────────
APP="$TMP/nosparkle.app"; make_bundle "$APP"
if "$CHECK" "$APP" selftest >/dev/null 2>&1; then
  ok "check-plist-keys accepts a bundle with no Sparkle keys at all"
else
  bad "check-plist-keys rejected a perfectly valid no-updater bundle"
fi

if [ "$FAILED" = 0 ]; then printf 'plist-keys-selftest: PASS\n'; else printf 'plist-keys-selftest: FAIL\n'; exit 1; fi
