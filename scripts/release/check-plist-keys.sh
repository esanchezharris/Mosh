#!/usr/bin/env bash
# scripts/release/check-plist-keys.sh — regression guard: prove a bundle (at ANY point
# in the release pipeline — pre-sign, post-sign, post-notarize, post-staple) still
# carries the Info.plist usage-description keys that cmake/InjectInfoPlistKeys.cmake
# injects at build time.
#
# Usage:
#   scripts/release/check-plist-keys.sh <bundle.app> [checkpoint-label]
#
# Exit 0 — every required key is present with a non-empty value.
# Exit 1 — the bundle is missing a required key, has an empty value for one, or has no
#          readable Info.plist at all. Always fail-closed: an error reading the plist
#          (corrupt, wrong format, missing file) is treated as a MISSING key, never
#          silently skipped.
#
# Called automatically by scripts/release/sign-and-notarize.sh at each checkpoint
# (pre-sign / post-sign / post-notarize+staple); also safe to run standalone against
# any already-built bundle, e.g.:
#   scripts/release/check-plist-keys.sh /Applications/Mosh.app
#   scripts/release/check-plist-keys.sh ~/Desktop/Mosh-share/Mosh.app post-release
set -euo pipefail

APP="${1:-}"
CHECKPOINT="${2:-check}"

if [ -z "$APP" ]; then
  echo "usage: $(basename "$0") <bundle.app> [checkpoint-label]" >&2
  exit 1
fi
if [ ! -d "$APP" ]; then
  echo "check-plist-keys ($CHECKPOINT): FAIL-CLOSED — not a directory: $APP" >&2
  exit 1
fi

PLIST="$APP/Contents/Info.plist"
if [ ! -f "$PLIST" ]; then
  echo "check-plist-keys ($CHECKPOINT): FAIL-CLOSED — no Info.plist at $PLIST" >&2
  exit 1
fi

#
# `plutil -extract <key> raw -o -` is used deliberately over `-extract <key> json`:
# json format REFUSES to print a bare top-level scalar ("Invalid object in plist for
# JSON format", exit 1) — it only works for extracting arrays/dicts. raw format
# handles both shapes uniformly: a string key prints the string; an array key
# (NSBonjourServices) prints its element COUNT, not its contents — which is exactly
# what we need here (a presence/non-emptiness check, not a content diff). Verified by
# hand against real XML and binary1 plists before relying on this in the pipeline —
# see the PR description for the probe transcript.
CHECKS="NSMicrophoneUsageDescription:audio recording
NSCameraUsageDescription:WebView multiplayer camera
NSBonjourServices:companion discovery (_moshcompanion._tcp)"

fail=0
while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  key="${entry%%:*}"
  label="${entry#*:}"
  val=""
  rc=0
  val="$(/usr/bin/plutil -extract "$key" raw -o - "$PLIST" 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$val" ] || [ "$val" = "0" ]; then
    echo "check-plist-keys ($CHECKPOINT): MISSING $key  — $label" >&2
    fail=1
  else
    echo "check-plist-keys ($CHECKPOINT): OK      $key"
  fi
done <<EOF
$CHECKS
EOF

if /usr/bin/plutil -extract NSSpeechRecognitionUsageDescription raw -o - "$PLIST" >/dev/null 2>&1; then
  echo "check-plist-keys ($CHECKPOINT): FORBIDDEN NSSpeechRecognitionUsageDescription" >&2
  fail=1
else
  echo "check-plist-keys ($CHECKPOINT): OK      NSSpeechRecognitionUsageDescription absent"
fi

BINARY="$APP/Contents/MacOS/Mosh"
if [ -f "$BINARY" ]; then
  if /usr/bin/nm -u "$BINARY" 2>/dev/null | /usr/bin/grep -q 'SFSpeechRecognizer' \
      || /usr/bin/strings -a "$BINARY" 2>/dev/null | /usr/bin/grep -q 'SFSpeechRecognizer'; then
    echo "check-plist-keys ($CHECKPOINT): FORBIDDEN retired Speech framework capability" >&2
    fail=1
  else
    echo "check-plist-keys ($CHECKPOINT): OK      retired Speech capability absent"
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "check-plist-keys ($CHECKPOINT): FAILED — $(basename "$APP") is missing a required" >&2
  echo "  or has a forbidden Info.plist privacy key. Refusing to treat it as" >&2
  echo "  shippable. Do not hand-patch the plist — rebuild via cmake, which runs" >&2
  echo "  cmake/InjectInfoPlistKeys.cmake on every build (both a relink POST_BUILD and" >&2
  echo "  an always-run ALL target, so a stale/partial build can't skip it either)." >&2
  exit 1
fi

echo "check-plist-keys ($CHECKPOINT): OK — privacy policy satisfied in $(basename "$APP")"
