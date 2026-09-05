#!/usr/bin/env bash
# package-for-sharing.sh — build Mosh.app (Release) and produce a shareable zip so a
# friend on another Apple Silicon Mac can join a cloud multiplayer session.
#
# Multiplayer needs ONLY the app + the baked-in cloud relay default (see
# src/multiplayer/MultiplayerClient.cpp). No Python service, models, or plugins are
# bundled — the bare ~20 MB app is enough to create/join a room and sync stems.
#
# Output:  dist/Mosh-mp.zip   (+ dist/READ-ME-FIRST.txt)
# Usage:   scripts/package-for-sharing.sh        # run from the repo root checkout
#
# The app is ad-hoc signed (not notarized), so the friend clears quarantine once with
# the command in READ-ME-FIRST.txt. Requirements for them: Apple Silicon, macOS 11+.
#
# MOSH_CMAKE_EXTRA — extra args appended to the configure step (e.g. a worktree passing
#   -DCPM_SOURCE_CACHE=... -DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=...). Empty in the
#   normal repo-root checkout.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
RELAY_URL="https://tpvkqaqydafpgockzchm.supabase.co/functions/v1/relay"

echo "==> building Mosh (macos-arm64-release)…"
# shellcheck disable=SC2086
cmake --preset macos-arm64-release ${MOSH_CMAKE_EXTRA:-}
cmake --build --preset macos-arm64-release-app

# Resolve the freshly built Mosh.app (newest by mtime under the release build dir).
APP=""
best=0
while IFS= read -r p; do
  t="$(stat -f '%m' "$p" 2>/dev/null || echo 0)"
  if [ "$t" -ge "$best" ]; then best="$t"; APP="$p"; fi
done < <(find "$ROOT/build-macos-arm64-release" -maxdepth 3 -name 'Mosh.app' -type d 2>/dev/null)
if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  echo "ERROR: built Mosh.app not found under build-macos-arm64-release/" >&2
  exit 1
fi
echo "==> built app: $APP"

# Stage a clean copy (the freshly built app carries the UI + drumkits but NOT the
# Python service — exactly what we want for an MP-only share).
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/Mosh.app"

echo "==> verifying Info.plist usage keys…"
"$ROOT/scripts/release/check-plist-keys.sh" "$STAGE/Mosh.app" pre-zip

mkdir -p "$DIST"
rm -f "$DIST/Mosh-mp.zip"

# ditto (NOT zip): preserves the bundle's symlinks/xattrs/ad-hoc signature, and is how
# Archive Utility unzips on the friend's side — so the round-trip is faithful.
echo "==> zipping with ditto…"
( cd "$STAGE" && ditto -c -k --keepParent "Mosh.app" "$DIST/Mosh-mp.zip" )

cat > "$DIST/READ-ME-FIRST.txt" <<EOF
Mosh — multiplayer test build
=============================

REQUIREMENTS
  • An Apple Silicon Mac (M1/M2/M3/M4).  (This build will NOT run on Intel.)
  • macOS 11 (Big Sur) or newer.
  To check: Apple menu  >  About This Mac  (look for "Chip: Apple M…").

INSTALL
  1. Unzip Mosh-mp.zip (double-click it).
  2. Drag Mosh.app into your /Applications folder.

FIRST LAUNCH (one-time Gatekeeper bypass — the app isn't notarized)
  Open Terminal (Applications > Utilities > Terminal) and run this one line:

      xattr -dr com.apple.quarantine /Applications/Mosh.app

  Then double-click Mosh.app to launch it.

  Prefer not to use Terminal? Double-click Mosh.app, click "Done" on the warning,
  then go to  System Settings > Privacy & Security , scroll down, and click
  "Open Anyway" next to the Mosh message. Confirm with "Open".

JOIN THE SESSION
  • Open the "Multiplayer" panel in the top bar.
  • Paste the room code your host shares with you, then click "Join".
  (To host your own: type a name/colour and click "Create session", then share the
   room code it shows.)

That's it — multiplayer connects to the cloud automatically. You do NOT need to
install Python, any AI models, or any audio plugins to collaborate.
EOF

echo
echo "==> done."
echo "    artifact : $DIST/Mosh-mp.zip   ($(du -h "$DIST/Mosh-mp.zip" | cut -f1))"
echo "    readme   : $DIST/READ-ME-FIRST.txt"
echo "    relay    : $RELAY_URL (baked default; override with MOSH_RELAY_URL)"
echo
echo "Send BOTH files to your friend, create a session in your own Mosh, and share the room code."
