#!/usr/bin/env bash
# scripts/release/upload-dsyms.sh — upload debug symbols (dSYMs) for a release build
# to Sentry, so a crash minidump from a stripped Release binary comes back
# SYMBOLICATED (real function names + line numbers) instead of as raw addresses.
#
# FS-K3, spec §5 K3: "dSYM upload in the release script". Called from
# `./run-mosh.sh release` after the app is built and signed.
#
# ── SKIP-BY-DEFAULT, NOT FAIL-BY-DEFAULT ─────────────────────────────────────────
# This is the deliberate opposite of scripts/release/sign-and-notarize.sh's
# fail-closed stance, and the reason is that the two failures are not comparable:
# an unsigned build is a BROKEN artifact that must never ship silently, whereas a
# build with no symbols uploaded is a perfectly good artifact that is merely harder
# to debug later. Sentry is also OPTIONAL and currently BLOCKED-ON-OWNER (no project
# exists yet — see docs/first-stranger-program/lanes/fs-k3.md), so making `release`
# hard-depend on Sentry credentials would break the release path for the exact
# situation the repo is in today. Absent credentials => print why, exit 0.
#
# Once credentials ARE present, failures are real and DO propagate (set -e), because
# at that point "I asked for an upload and it silently didn't happen" is the bad
# outcome.
#
# ── Credentials (environment only — never argv, never a file in the repo) ────────
#   SENTRY_AUTH_TOKEN   SECRET. An auth token with project:releases scope.
#   SENTRY_ORG          Sentry organisation slug.
#   SENTRY_PROJECT      Sentry project slug.
#   SENTRY_URL          Optional; for self-hosted Sentry.
#
# Passed via the environment specifically so the token never appears in argv, which
# is world-readable through `ps` on a shared machine. It is also why this script
# takes the app bundle as its ONLY argument. The token must never be committed and
# must never enter the app bundle: a Sentry DSN is a public client ingest key and MAY
# ship, an auth token is a write credential and MUST NOT. That asymmetry is checked
# by FS-K3 gate G4 (`strings` over the built app).
#
# ── Usage ────────────────────────────────────────────────────────────────────────
#   scripts/release/upload-dsyms.sh <path/to/Mosh.app> [--dry-run]
#
#   --dry-run   Resolve everything and print the exact sentry-cli command that would
#               run, without running it and without needing a live token.

set -euo pipefail

APP="${1:-}"
DRY_RUN=0
[ "${2:-}" = "--dry-run" ] && DRY_RUN=1

if [ -z "$APP" ]; then
  echo "usage: $0 <path/to/Mosh.app> [--dry-run]" >&2
  exit 2
fi

if [ ! -d "$APP" ]; then
  echo "upload-dsyms: not a bundle: $APP" >&2
  exit 2
fi

# ── Skip cleanly when Sentry isn't configured ────────────────────────────────────
missing=""
[ -z "${SENTRY_AUTH_TOKEN:-}" ] && missing="$missing SENTRY_AUTH_TOKEN"
[ -z "${SENTRY_ORG:-}" ]        && missing="$missing SENTRY_ORG"
[ -z "${SENTRY_PROJECT:-}" ]    && missing="$missing SENTRY_PROJECT"

if [ -n "$missing" ] && [ "$DRY_RUN" -eq 0 ]; then
  echo "upload-dsyms: SKIPPED — not configured (missing:$missing)."
  echo "              This is expected: FS-K3's Sentry project is BLOCKED-ON-OWNER."
  echo "              The release artifact is complete and correct without it; only"
  echo "              server-side symbolication of future crashes is unavailable."
  exit 0
fi

if ! command -v sentry-cli >/dev/null 2>&1; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "upload-dsyms: (dry-run) sentry-cli not installed — showing intent only."
  else
    echo "upload-dsyms: SKIPPED — sentry-cli not installed, but Sentry credentials ARE set." >&2
    echo "              Install it (brew install getsentry/tools/sentry-cli) or unset the" >&2
    echo "              credentials to silence this. Not failing the release." >&2
    exit 0
  fi
fi

# ── Locate the dSYM bundles ──────────────────────────────────────────────────────
# CMake writes Mosh.app.dSYM alongside the bundle for Release builds with debug info.
# Search the app's parent dir and the build tree root above it; upload whatever exists.
APP_DIR="$(cd "$(dirname "$APP")" && pwd)"
APP_NAME="$(basename "$APP")"

DSYM_PATHS=()
while IFS= read -r d; do
  [ -n "$d" ] && DSYM_PATHS+=("$d")
done < <(find "$APP_DIR" -maxdepth 2 -name '*.dSYM' -type d 2>/dev/null | sort)

if [ "${#DSYM_PATHS[@]}" -eq 0 ]; then
  echo "upload-dsyms: no .dSYM found next to $APP_NAME."
  echo "              A Release build must be configured with debug info for"
  echo "              symbolication to be possible (CMAKE_BUILD_TYPE=RelWithDebInfo,"
  echo "              or Release with -g). Uploading the stripped binary alone would"
  echo "              produce address-only stack traces, so nothing is uploaded."
  # Not an error: see the skip-by-default rationale in the header.
  exit 0
fi

# The release identifier MUST match what SentryReporter.cpp passes to
# sentry_options_set_release() ("mosh@<MOSH_VERSION_STRING>"), or Sentry will not
# associate the uploaded symbols with the incoming events.
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
             "$APP/Contents/Info.plist" 2>/dev/null || echo "dev")"
RELEASE="mosh@$VERSION"

echo "upload-dsyms: release=$RELEASE  org=${SENTRY_ORG:-<unset>}  project=${SENTRY_PROJECT:-<unset>}"
for d in "${DSYM_PATHS[@]}"; do
  echo "              dSYM: $d"
done

if [ "$DRY_RUN" -eq 1 ]; then
  echo "upload-dsyms: (dry-run) would run:"
  echo "              sentry-cli debug-files upload --include-sources ${DSYM_PATHS[*]}"
  echo "              sentry-cli releases new $RELEASE"
  exit 0
fi

# --include-sources embeds source context in the symbol upload so a Sentry stack
# frame shows the actual line, not just a file:line reference the server can't read.
sentry-cli debug-files upload --include-sources "${DSYM_PATHS[@]}"
sentry-cli releases new "$RELEASE" || true
sentry-cli releases finalize "$RELEASE" || true

echo "upload-dsyms: ✅ uploaded debug symbols for $RELEASE"
