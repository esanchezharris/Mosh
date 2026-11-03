#!/usr/bin/env bash
# fetch-uv.sh — stage the pinned uv binary into resources/uv/ for the app bundle.
#
# The optional AI tools install (docs/AI-TOOLS-OPTIONAL-BRIEF-2026-11-02.md §5.3) uses
# uv to download its own Python, so a friend's Mac never needs the developer tools.
# CMake copies resources/uv/ into Mosh.app/Contents/Helpers/uv when it is present; a
# build without it still works, and "Add AI tools" then says this build can't add them.
#
# The binary (~28MB) is deliberately NOT committed, same as resources/trainer/.
# The version and sha256 are pinned here; a mismatch refuses to stage.
#
# Usage:
#   scripts/fetch-uv.sh            # download + verify + stage (no-op when already staged)
#   scripts/fetch-uv.sh --check    # report only
set -euo pipefail

UV_VERSION="0.13.1"
# From the release's own uv-<arch>-apple-darwin.tar.gz.sha256 assets, read 2026-11-03.
SHA_aarch64="cfe454573412ff7380d15fc7dae5997ab53ffce72fce0a78e91ddbc84001acd2"
SHA_x86_64="bb7b805bdcf3d0bc8c74ceb94569e6b3e8aa35bd492acdbb9d46bf46d9d4ff6b"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$REPO_ROOT/resources/uv"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || { say "skip: the AI tools install is macOS-only"; exit 0; }
case "$(uname -m)" in
  arm64)  ARCH=aarch64; SHA="$SHA_aarch64" ;;
  x86_64) ARCH=x86_64;  SHA="$SHA_x86_64" ;;
  *) fail "unsupported arch $(uname -m)" ;;
esac

if [[ -x "$DEST/uv" ]] && [[ "$(cat "$DEST/VERSION" 2>/dev/null)" == "$UV_VERSION-$ARCH" ]]; then
  say "OK   uv $UV_VERSION staged at $DEST"
  exit 0
fi
if [[ "${1:-}" == "--check" ]]; then
  say "MISS uv $UV_VERSION not staged at $DEST (run scripts/fetch-uv.sh)"
  exit 1
fi

ASSET="uv-$ARCH-apple-darwin.tar.gz"
URL="https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$ASSET"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "downloading $URL"
curl -fsSL --retry 3 -o "$TMP/$ASSET" "$URL" || fail "download failed: $URL"
GOT="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
[[ "$GOT" == "$SHA" ]] || fail "sha256 mismatch for $ASSET: got $GOT, pinned $SHA"

tar -xzf "$TMP/$ASSET" -C "$TMP"
[[ -x "$TMP/uv-$ARCH-apple-darwin/uv" ]] || fail "the archive has no uv binary"

rm -rf "$DEST"
mkdir -p "$DEST"
cp "$TMP/uv-$ARCH-apple-darwin/uv" "$DEST/uv"
printf '%s\n' "$UV_VERSION-$ARCH" > "$DEST/VERSION"
say "staged uv $UV_VERSION ($ARCH) at $DEST"
