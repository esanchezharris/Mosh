#!/usr/bin/env bash
# scripts/release/make-dmg.sh — build a drag-to-Applications DMG from a signed app
# bundle. Extracted out of run-mosh.sh's `release` verb so the exact same DMG-building
# code runs locally (./run-mosh.sh release) and in CI (.github/workflows/release.yml) —
# one implementation, not two copies that can drift.
#
# This is packaging, not signing: it does NOT sign or notarize the .dmg it produces —
# call scripts/release/sign-and-notarize.sh on the output afterwards (it auto-detects
# non-.app targets and applies plain codesign + notarize + staple, no entitlements,
# matching Apple's guidance that entitlements only apply to executable Mach-O bundles).
#
# Usage: scripts/release/make-dmg.sh <source.app> <output.dmg> [volname]
set -euo pipefail

APP="${1:?usage: make-dmg.sh <source.app> <output.dmg> [volname]}"
DMG="${2:?usage: make-dmg.sh <source.app> <output.dmg> [volname]}"
VOLNAME="${3:-Mosh}"

if [ ! -d "$APP" ]; then
  echo "make-dmg: source app not found: $APP" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"   # the classic drag target
rm -f "$DMG"
mkdir -p "$(dirname "$DMG")"

# The staged copy carries everything the .app carries (including brain.env if the
# caller bundled one before staging) — trap-cleanup above removes it whether hdiutil
# succeeds or fails.
hdiutil create -volname "$VOLNAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null

echo "make-dmg: built $DMG"
