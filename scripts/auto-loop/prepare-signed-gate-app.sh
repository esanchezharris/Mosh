#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'usage: %s <source-Mosh.app> [dest-Mosh.app]\n' "$0" >&2
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 64
fi

SRC="$1"
if [[ ! -d "$SRC" ]]; then
  printf 'prepare-signed-gate-app: source app not found: %s\n' "$SRC" >&2
  exit 66
fi

if [[ $# -eq 2 ]]; then
  DEST="$2"
else
  STAGE="$(mktemp -d "${TMPDIR:-/tmp}/mosh-signed-gate.XXXXXX")"
  DEST="$STAGE/Mosh.app"
fi

case "$DEST" in
  *.app) ;;
  *)
    printf 'prepare-signed-gate-app: destination must end in .app: %s\n' "$DEST" >&2
    exit 64
    ;;
esac

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"

# Worktrees under Documents/File Provider can carry resource forks and extended
# metadata that make strict bundle verification fail. Strip them before signing.
ditto --norsrc --noextattr "$SRC" "$DEST"
xattr -cr "$DEST" 2>/dev/null || true
codesign --force --deep --sign - "$DEST" >/dev/null
codesign --verify --deep --strict --verbose=2 "$DEST" >/dev/null

printf '%s\n' "$DEST"
