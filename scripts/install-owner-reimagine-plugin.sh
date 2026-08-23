#!/usr/bin/env bash
# Explicit owner-only installer for Mosh Re-Imagine. This is never invoked by
# the normal CMake build and never writes /Library or /Applications.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${1:-$REPO_ROOT/build-macos-arm64}"
CONFIG="${2:-Debug}"
PLUGIN_SOURCE="$BUILD_DIR/src/reimagine/plugin/MoshReImaginePlugin_artefacts/$CONFIG/VST3/Mosh Re-Imagine.vst3"
PLUGIN_DEST="$HOME/Library/Audio/Plug-Ins/VST3/Mosh Re-Imagine.vst3"
HELPER_DEST="$HOME/Library/Application Support/Mosh/ReImagine/service"

if [[ ! -d "$PLUGIN_SOURCE" ]]; then
  printf 'Mosh Re-Imagine VST3 not found at: %s\n' "$PLUGIN_SOURCE" >&2
  printf 'Build it first: cmake --build %s --target MoshReImaginePlugin_VST3\n' "$BUILD_DIR" >&2
  exit 2
fi

mkdir -p "$(dirname "$PLUGIN_DEST")" "$HELPER_DEST"
ditto "$PLUGIN_SOURCE" "$PLUGIN_DEST"

# Stage executable source only. Feature venvs, local outputs, logs, caches, and
# secret-bearing dotenv files are not copied. .sa3.env is the one permitted,
# non-secret model pointer; owner-sa3.env remains outside the helper and is read
# directly by run.sh.
rsync -a --delete \
  --exclude '.git/' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude '.venv/' \
  --exclude 'output/' \
  --exclude 'training-output/' \
  --exclude '.*.env' \
  "$REPO_ROOT/service/" "$HELPER_DEST/"
if [[ -f "$REPO_ROOT/service/.sa3.env" ]]; then
  install -m 600 "$REPO_ROOT/service/.sa3.env" "$HELPER_DEST/.sa3.env"
fi
chmod 755 "$HELPER_DEST/run.sh" "$HELPER_DEST/run-reimagine.sh"

codesign --force --deep --sign - "$PLUGIN_DEST"
codesign --verify --deep --strict --verbose=2 "$PLUGIN_DEST"

printf 'Installed owner VST3: %s\n' "$PLUGIN_DEST"
printf 'Staged shared helper: %s\n' "$HELPER_DEST"
printf 'In Ableton Live 11: Preferences > Plug-Ins > Rescan, then load Mosh Re-Imagine.\n'
