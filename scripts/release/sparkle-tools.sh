#!/usr/bin/env bash
# sparkle-tools.sh — resolve the Sparkle command-line tools (generate_appcast,
# sign_update, generate_keys), downloading the PINNED release tarball on first use.
#
#   eval "$(scripts/release/sparkle-tools.sh)"     # exports MOSH_SPARKLE_BIN, _VERSION
#   scripts/release/sparkle-tools.sh --print-bin   # just the bin dir, for scripting
#
# The tools ship in the same tarball as the framework the app embeds, and the pin is
# shared with cmake/Sparkle.cmake via sparkle-pin.env — deliberately, so the signer and
# the verifier can never come from different Sparkle releases.
#
# The cache lives under ~/Library/Mosh/work (never ~/Documents, never the Desktop:
# iCloud evicts file CONTENT while leaving plausible stat sizes, and re-applies
# FinderInfo under codesign — both traps are in CLAUDE.md and both have cost real time).
#
# FAIL-CLOSED: the tarball's sha256 is verified before anything is extracted. A hash
# mismatch aborts; it is never "warn and continue". These tools sign updates that users'
# machines will trust and install — a compromised generate_appcast is game over.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/sparkle-pin.env"

if [ -z "${MOSH_SPARKLE_VERSION:-}" ] || [ -z "${MOSH_SPARKLE_SHA256:-}" ]; then
  echo "sparkle-tools: sparkle-pin.env did not define MOSH_SPARKLE_VERSION/SHA256" >&2
  exit 1
fi

WORK="${MOSH_WORK_DIR:-$HOME/Library/Mosh/work}"
ROOT="$WORK/sparkle/$MOSH_SPARKLE_VERSION"
BIN="$ROOT/bin"

if [ ! -x "$BIN/generate_appcast" ]; then
  TARBALL="$WORK/sparkle/Sparkle-$MOSH_SPARKLE_VERSION.tar.xz"
  URL="https://github.com/sparkle-project/Sparkle/releases/download/$MOSH_SPARKLE_VERSION/Sparkle-$MOSH_SPARKLE_VERSION.tar.xz"
  mkdir -p "$WORK/sparkle"
  if [ ! -f "$TARBALL" ]; then
    echo "sparkle-tools: downloading Sparkle $MOSH_SPARKLE_VERSION…" >&2
    curl -fsSL -o "$TARBALL.part" "$URL"
    mv "$TARBALL.part" "$TARBALL"
  fi
  GOT="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
  if [ "$GOT" != "$MOSH_SPARKLE_SHA256" ]; then
    echo "sparkle-tools: SHA256 MISMATCH for $TARBALL" >&2
    echo "  expected $MOSH_SPARKLE_SHA256" >&2
    echo "  got      $GOT" >&2
    echo "  Refusing to extract. Delete the file and retry; if it mismatches again," >&2
    echo "  do NOT bump the pin to match — verify the release upstream first." >&2
    rm -f "$TARBALL"
    exit 1
  fi
  rm -rf "$ROOT"
  mkdir -p "$ROOT"
  tar -xJf "$TARBALL" -C "$ROOT"
fi

if [ ! -x "$BIN/generate_appcast" ]; then
  echo "sparkle-tools: generate_appcast missing at $BIN after extract — layout changed?" >&2
  exit 1
fi

if [ "${1:-}" = "--print-bin" ]; then
  echo "$BIN"
else
  echo "export MOSH_SPARKLE_BIN=$(printf '%q' "$BIN")"
  echo "export MOSH_SPARKLE_VERSION=$(printf '%q' "$MOSH_SPARKLE_VERSION")"
fi
