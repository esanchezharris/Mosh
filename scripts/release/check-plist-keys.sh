#!/usr/bin/env bash
# scripts/release/check-plist-keys.sh — regression guard: prove a bundle (at ANY point
# in the release pipeline — pre-sign, post-sign, post-notarize, post-staple) still
# carries the Info.plist usage-description keys that cmake/InjectInfoPlistKeys.cmake
# injects at build time.
#
# WHY THIS EXISTS: a missing NSSpeechRecognitionUsageDescription does not degrade —
# macOS TCC HARD-CRASHES (SIGABRT) the instant the always-on voice calls
# SFSpeechRecognizer (src/voice/NativeSpeech.mm). This exact class of bug shipped once
# already in a hand-copied /Applications/Mosh.app (see CLAUDE.md, "'Serum 1 load crash'
# was a TCC speech crash, not a plugin-host crash", 2026-06-27) — the crash was
# misdiagnosed as a plugin-host bug because whatever VST happened to be loading at the
# time showed up in the crash report. The fix at the time was build-side
# (cmake/InjectInfoPlistKeys.cmake, run from an always-run ALL target so no build
# configuration can skip it, plus a re-inject-and-verify in run-mosh.sh's install_app).
# This script is the SIGNING-side half of that guarantee: codesign/notarytool/stapler
# all touch the bundle after the build already got the keys right, and none of them are
# *supposed* to rewrite Info.plist — but "supposed to" is exactly the kind of assumption
# that shipped the original bug. Prove it, don't assume it.
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

# key ; human label. Mirrors the three UNCONDITIONAL keys in
# cmake/InjectInfoPlistKeys.cmake — keep this list in sync with that file if it ever
# grows another always-present key. (Its two Sparkle keys are conditional and are
# checked separately below, since a build with no updater legitimately has neither.)
#
# `plutil -extract <key> raw -o -` is used deliberately over `-extract <key> json`:
# json format REFUSES to print a bare top-level scalar ("Invalid object in plist for
# JSON format", exit 1) — it only works for extracting arrays/dicts. raw format
# handles both shapes uniformly: a string key prints the string; an array key
# (NSBonjourServices) prints its element COUNT, not its contents — which is exactly
# what we need here (a presence/non-emptiness check, not a content diff). Verified by
# hand against real XML and binary1 plists before relying on this in the pipeline —
# see the PR description for the probe transcript.
CHECKS="NSSpeechRecognitionUsageDescription:voice-to-Moshi (TCC hard-crash if absent)
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

# ── Sparkle (FS-K2) — CONDITIONAL, unlike the keys above ─────────────────────────
# Sparkle is optional: a build with no feed configured has neither key, which is a
# perfectly good state (the app simply has no updater). What is NOT a good state is a
# feed URL with no public key — Sparkle then fetches the appcast, downloads the update,
# and rejects it as unsigned. To a user that is indistinguishable from "no update
# available", so it can persist for the entire life of a release without anyone
# noticing. cmake/InjectInfoPlistKeys.cmake refuses to build that combination; this is
# the signing-side half of the same guarantee, for the same reason as everything above:
# nothing in the sign/notarize/staple chain is *supposed* to rewrite Info.plist.
feed=""
edkey=""
feed="$(/usr/bin/plutil -extract SUFeedURL raw -o - "$PLIST" 2>/dev/null)" || feed=""
edkey="$(/usr/bin/plutil -extract SUPublicEDKey raw -o - "$PLIST" 2>/dev/null)" || edkey=""
if [ -n "$feed" ]; then
  if [ -z "$edkey" ]; then
    echo "check-plist-keys ($CHECKPOINT): MISSING SUPublicEDKey — but SUFeedURL is set ($feed)." >&2
    echo "  This bundle would check for updates and then reject every one of them as" >&2
    echo "  unsigned, silently and forever. Refusing to treat it as shippable." >&2
    fail=1
  else
    echo "check-plist-keys ($CHECKPOINT): OK      SUFeedURL + SUPublicEDKey (Sparkle auto-update)"
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "check-plist-keys ($CHECKPOINT): FAILED — $(basename "$APP") is missing a required" >&2
  echo "  Info.plist usage-description key. Shipping this bundle risks a TCC hard-crash" >&2
  echo "  (SIGABRT) the moment the affected feature is used. Refusing to treat it as" >&2
  echo "  shippable. Do not hand-patch the plist — rebuild via cmake, which runs" >&2
  echo "  cmake/InjectInfoPlistKeys.cmake on every build (both a relink POST_BUILD and" >&2
  echo "  an always-run ALL target, so a stale/partial build can't skip it either)." >&2
  exit 1
fi

echo "check-plist-keys ($CHECKPOINT): OK — all required Info.plist usage keys present in $(basename "$APP")"
