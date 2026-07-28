#!/usr/bin/env bash
# assert-universal.sh — fail-closed check that a built Mosh.app is actually shippable
# to BOTH Apple Silicon and Intel Macs.
#
# Why this exists (both failure modes below have really happened in this repo):
#
#   1. SILENT SINGLE-ARCH. Every packaging path builds via a named preset. A preset
#      typo, a stale build dir, or a `find` that picks up an older single-arch
#      Mosh.app all produce an arm64-only bundle that signs, notarizes, zips and
#      installs perfectly — and simply will not launch on an Intel Mac. Nothing else
#      in the pipeline reads the Mach-O header, so the failure is invisible until a
#      user reports it.
#
#   2. SILENT MIN-OS DRIFT. CMakeLists.txt's CMAKE_OSX_DEPLOYMENT_TARGET must be set
#      ABOVE project() or it is a no-op (project() pre-creates an empty cache entry,
#      and CACHE-without-FORCE never overwrites one). That exact bug shipped a build
#      stamped `minos 26.0` — an app that refuses to launch on anything older than
#      macOS 26 — while the docs promised macOS 11+. If someone moves that block back
#      below project(), the build still succeeds and every test still passes; only
#      this check notices.
#
# Usage:  assert-universal.sh <Mosh.app | path/to/binary> [expected_min_macos]
# Env:    MOSH_EXPECT_ARCHS  (default "arm64 x86_64")
#         MOSH_EXPECT_MIN_OS (default "11.0"; overridden by $2)
#
# Exits 0 only when every expected slice is present AND every slice's LC_BUILD_VERSION
# minos matches. Any other outcome — missing tool, unreadable binary, wrong arch,
# wrong min-OS — is a non-zero exit. There is deliberately no "warn and continue".
set -euo pipefail

TARGET="${1:-}"
EXPECT_MIN="${2:-${MOSH_EXPECT_MIN_OS:-11.0}}"
EXPECT_ARCHS="${MOSH_EXPECT_ARCHS:-arm64 x86_64}"

die() { printf '\n✗ assert-universal: %s\n' "$*" >&2; exit 1; }

[ -n "$TARGET" ] || die "usage: assert-universal.sh <Mosh.app|binary> [expected_min_macos]"
command -v lipo  >/dev/null 2>&1 || die "lipo not found (Xcode command line tools required)"
command -v otool >/dev/null 2>&1 || die "otool not found (Xcode command line tools required)"

# Accept either the .app bundle or the executable itself.
BIN="$TARGET"
if [ -d "$TARGET" ]; then
  BIN="$TARGET/Contents/MacOS/Mosh"
  [ -f "$BIN" ] || die "no executable at $BIN (is '$TARGET' really a built Mosh.app?)"
fi
[ -f "$BIN" ] || die "not a file: $BIN"

# ── 1. architectures ─────────────────────────────────────────────────────────
ACTUAL_ARCHS="$(lipo -archs "$BIN" 2>/dev/null)" || die "lipo could not read $BIN"
[ -n "$ACTUAL_ARCHS" ] || die "lipo reported no architectures for $BIN"

missing=""
for want in $EXPECT_ARCHS; do
  case " $ACTUAL_ARCHS " in
    *" $want "*) ;;
    *) missing="$missing $want" ;;
  esac
done
if [ -n "$missing" ]; then
  die "$BIN is missing arch(s):$missing
     expected: $EXPECT_ARCHS
     actual:   $ACTUAL_ARCHS
     This bundle will NOT launch on a Mac of the missing architecture.
     Build with the universal preset:
       cmake --preset macos-universal-release && cmake --build --preset macos-universal-release-app"
fi

# ── 2. minimum macOS, per slice ──────────────────────────────────────────────
# A fat binary carries one LC_BUILD_VERSION per slice; every one must match, or some
# users get an app that silently refuses to launch.
MINOS_LIST="$(otool -l "$BIN" | awk '/LC_BUILD_VERSION/{f=1} f&&/^ *minos/{print $2; f=0}')"
[ -n "$MINOS_LIST" ] || die "no LC_BUILD_VERSION/minos found in $BIN — cannot verify minimum macOS"

slice_count="$(printf '%s\n' "$ACTUAL_ARCHS" | wc -w | tr -d ' ')"
minos_count="$(printf '%s\n' "$MINOS_LIST" | grep -c . || true)"
[ "$minos_count" = "$slice_count" ] \
  || die "found $minos_count minos entries for $slice_count slices in $BIN — cannot verify every slice"

while read -r got; do
  [ -n "$got" ] || continue
  [ "$got" = "$EXPECT_MIN" ] || die "minimum macOS is $got, expected $EXPECT_MIN (slices: $ACTUAL_ARCHS)
     A too-high minos means the app refuses to launch on older macOS — this is how a
     build stamped 'minos 26.0' once shipped against a documented 'macOS 11+' promise.
     Check that CMakeLists.txt still sets CMAKE_OSX_DEPLOYMENT_TARGET *above* project()."
done <<< "$MINOS_LIST"

printf '✓ assert-universal: %s — archs [%s], min macOS %s\n' \
  "$(basename "$TARGET")" "$ACTUAL_ARCHS" "$EXPECT_MIN"
