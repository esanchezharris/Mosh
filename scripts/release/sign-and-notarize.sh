#!/usr/bin/env bash
# scripts/release/sign-and-notarize.sh — Developer-ID sign (Hardened Runtime +
# entitlements, deep re-sign inside-out) → notarize (xcrun notarytool submit --wait) →
# staple (xcrun stapler staple) → verify (codesign --verify --deep --strict, spctl -a),
# for a Mosh.app bundle or a .dmg/.zip/.pkg built from one.
#
# This is the SINGLE implementation both `./run-mosh.sh release` (local, owner's Mac)
# and .github/workflows/release.yml (CI, on a tag push) call — one source of truth for
# the signing/notarization mechanics, so the two paths can't drift apart.
#
# FAIL-CLOSED BY DESIGN: every credential this script needs is read from the
# environment (never hardcoded, never prompted for interactively, never silently
# defaulted to "skip signing"). If a required credential is absent or invalid, this
# script refuses to proceed and explains exactly what to set — it NEVER produces an
# unsigned or ad-hoc-signed bundle silently in place of a real one. Ad-hoc signing is
# `./run-mosh.sh deploy`'s job, a completely separate code path; this script only ever
# does real Developer-ID signing or nothing at all.
#
# ── Usage ─────────────────────────────────────────────────────────────────────────
#   scripts/release/sign-and-notarize.sh <bundle.app|.dmg|.zip|.pkg> [flags]
#   scripts/release/sign-and-notarize.sh --preflight-only [flags]
#
# Flags:
#   --preflight-only   Validate credentials (and, unless --dry-run, live-check them
#                       against the keychain / Apple's notary service) and exit — no
#                       target required, nothing is touched. Used to fail fast BEFORE
#                       spending 10+ minutes on a Release build for nothing.
#   --sign-only        Sign + verify only; skip notarize/staple. Useful for local
#                       iteration on entitlements without burning notary quota/time.
#   --dry-run           Skip LIVE credential verification (no keychain/network calls
#                       for identity or notary creds) and ECHO every codesign /
#                       notarytool / stapler command instead of running it. Lets you
#                       inspect exactly what would run with zero credentials configured
#                       and zero side effects — see "Dry-run" below.
#   --entitlements PATH Override the entitlements file (default: entitlements.plist
#                       next to this script).
#   -h, --help          Print this usage and exit 0.
#
# ── Credentials (env only) ───────────────────────────────────────────────────────
#   MOSH_SIGN_IDENTITY        Exact codesign identity (SHA-1 hash, or the full
#                              "Developer ID Application: NAME (TEAMID)" string).
#                              Optional — if unset, the first "Developer ID
#                              Application" identity in `security find-identity` is
#                              used. If SET, it must actually resolve in the keychain
#                              (checked) — a typo fails closed, it does not silently
#                              fall back to auto-discovery.
#
#   Notarization — EITHER of two mechanisms (checked in this order):
#     1. Explicit triple (best for CI — no persistent keychain needed):
#          MOSH_NOTARY_APPLE_ID    Apple ID email
#          MOSH_NOTARY_TEAM_ID     Developer Team ID (e.g. ZYT77F9B27)
#          MOSH_NOTARY_PASSWORD    an APP-SPECIFIC password (appleid.apple.com →
#                                   Sign-In and Security → App-Specific Passwords).
#                                   NEVER the actual Apple ID password.
#        All three must be set together, or none — a partial set fails closed with a
#        specific "you set N of 3" message rather than silently trying profile mode.
#     2. Keychain profile (best for local/owner use — one-time setup):
#          MOSH_NOTARY_PROFILE     notarytool keychain-profile name
#                                   (default: "mosh-notary")
#          Set up once with:
#            xcrun notarytool store-credentials "mosh-notary" \
#              --apple-id <you@example.com> --team-id <TEAMID> \
#              --password <app-specific-password>
#
# No secret VALUE is ever printed by this script (in --dry-run, MOSH_NOTARY_PASSWORD
# is redacted to ***REDACTED*** wherever it would appear in an echoed command).
#
# ── Dry-run: proving the plumbing without real credentials ─────────────────────────
# `--dry-run` (or MOSH_SIGN_DRY_RUN=1) is for exactly the situation this script ships
# into: a machine with NO Developer ID Application certificate and NO notary profile
# yet (the owner's cert is a "later" step, not a "now" step). It lets you verify the
# script's control flow, argument construction, and command shape end-to-end —
# including which of the two notary-credential modes gets selected — without owning
# real Apple credentials. It is not a stub or a separate code path: every branch,
# every argv array, every checkpoint runs for real; only the actually-mutating /
# networked leaf calls (codesign, ditto zip, notarytool submit, stapler staple/
# validate) are replaced with an echo of the exact command.
#
# ── What this script does NOT do ────────────────────────────────────────────────
#   - Build the app (the caller builds first; see ./run-mosh.sh release or
#     .github/workflows/release.yml for the cmake invocation).
#   - Bundle the service/brain-key/etc. (also the caller's job, before staging).
#   - Build a .dmg (see scripts/release/make-dmg.sh — packaging, not signing; run it
#     BEFORE calling this script on the resulting .dmg).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── flags + target ──────────────────────────────────────────────────────────────
TARGET=""
PREFLIGHT_ONLY=0
SIGN_ONLY=0
DRY_RUN="${MOSH_SIGN_DRY_RUN:-0}"
ENTITLEMENTS="${MOSH_ENTITLEMENTS:-$SCRIPT_DIR/entitlements.plist}"

# Prints the whole header comment block (lines 2..just-before `set -euo pipefail`),
# dynamically — not a hardcoded line range — so it can't silently go stale/truncated
# as the header grows.
usage() { awk '/^set -euo pipefail/{exit} NR>1{sub(/^# ?/,""); print}' "${BASH_SOURCE[0]}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --preflight-only) PREFLIGHT_ONLY=1; shift ;;
    --sign-only)      SIGN_ONLY=1; shift ;;
    --dry-run)        DRY_RUN=1; shift ;;
    --entitlements)   ENTITLEMENTS="${2:?--entitlements needs a path}"; shift 2 ;;
    -h|--help)        usage; exit 0 ;;
    --*)              echo "unknown flag: $1" >&2; exit 2 ;;
    *)
      if [ -n "$TARGET" ]; then echo "unexpected extra argument: $1" >&2; exit 2; fi
      TARGET="$1"; shift ;;
  esac
done

if [ "$PREFLIGHT_ONLY" -eq 0 ] && [ -z "$TARGET" ]; then
  echo "usage: $(basename "$0") <bundle.app|.dmg|.zip|.pkg> [flags]   (or --preflight-only)" >&2
  exit 2
fi

log()  { printf '%s\n' "$*"; }
err()  { printf '%s\n' "$*" >&2; }
fail() { err "✗ $*"; exit 1; }

# ── dry-run command wrapper + secret redaction ──────────────────────────────────
# Only MOSH_NOTARY_PASSWORD is a raw secret this script's own argv ever carries
# (the P12/keychain password for the *signing* cert, if any, is a CI/keychain-setup
# concern handled BEFORE this script runs — see docs/release/SIGNING_RUNBOOK.md — and
# never appears in this script's argv). Redact it defensively wherever it would
# appear in a dry-run echo, by VALUE (not by flag-position), so it's caught no matter
# which command line it ends up in.
SENSITIVE_VALUES=()
[ -n "${MOSH_NOTARY_PASSWORD:-}" ] && SENSITIVE_VALUES+=("$MOSH_NOTARY_PASSWORD")

redact_one() {
  local a="$1" s
  for s in "${SENSITIVE_VALUES[@]:-}"; do
    if [ -n "$s" ] && [ "$a" = "$s" ]; then printf '***REDACTED***'; return; fi
  done
  printf '%s' "$a"
}

# run CMD ARGS...  — executes for real, UNLESS --dry-run, in which case it prints the
# fully shell-quoted command (secrets redacted) and returns 0 without touching
# anything. Used for every mutating/networked leaf call (codesign, ditto, notarytool,
# stapler). Read-only local inspection (security find-identity, plutil, file tests)
# runs for real in both modes — that's what makes dry-run a genuine plumbing proof
# rather than a canned demo.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] would run:'
    local a shown
    for a in "$@"; do
      shown="$(redact_one "$a")"
      printf ' %q' "$shown"
    done
    printf '\n'
    return 0
  fi
  "$@"
}

# ── plist regression guard (delegates to the standalone checker) ───────────────
check_plist() {                                   # $1 = app path, $2 = checkpoint label
  "$SCRIPT_DIR/check-plist-keys.sh" "$1" "$2"
}

# ── identity resolution (fail-closed) ───────────────────────────────────────────
# Sets SIGN_ID. In --dry-run with nothing configured, uses a clearly-fake placeholder
# so the command-shape demo works on a machine with zero codesigning certs; in real
# mode, absence or a non-matching identity is a hard failure.
SIGN_ID=""
resolve_identity() {
  local found="" match_line=""
  if [ -n "${MOSH_SIGN_IDENTITY:-}" ]; then
    # Two checks, not one: the identity string must (a) appear in the keychain at
    # all, AND (b) appear on a line codesign/security tags "Developer ID
    # Application" — an "Apple Development" or "Apple Distribution" cert can be
    # PRESENT and would happily pass a bare presence check (codesign can even sign
    # with one), but Apple's notary service rejects it, and that failure would only
    # surface after a full sign, wasting the time this preflight exists to save.
    # Match line-by-line (not just substring-in-the-whole-output) so a
    # coincidental hash/name collision across two DIFFERENT identity lines can't
    # smuggle a wrong-type cert through.
    match_line="$(security find-identity -v -p codesigning 2>/dev/null | grep -F -- "$MOSH_SIGN_IDENTITY" || true)"
    if [ -n "$match_line" ] && printf '%s\n' "$match_line" | grep -q "Developer ID Application"; then
      SIGN_ID="$MOSH_SIGN_IDENTITY"
      log "  identity: $SIGN_ID (from MOSH_SIGN_IDENTITY, verified present + Developer ID Application type)"
      return 0
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
      SIGN_ID="$MOSH_SIGN_IDENTITY"
      log "  identity: $SIGN_ID (from MOSH_SIGN_IDENTITY — NOT verified: --dry-run skips the live keychain check)"
      return 0
    fi
    if [ -n "$match_line" ]; then
      err "✗ MOSH_SIGN_IDENTITY matches a keychain identity, but it is NOT a 'Developer ID"
      err "  Application' certificate (notarization requires that exact type):"
      err "    $match_line"
    else
      err "✗ MOSH_SIGN_IDENTITY is set but does not match any codesigning identity in the keychain."
      err "  Looked for: $MOSH_SIGN_IDENTITY"
    fi
    err "  Identities actually present:"
    security find-identity -v -p codesigning 2>/dev/null | sed 's/^/    /' >&2 || true
    err "  Fix MOSH_SIGN_IDENTITY, or unset it to auto-discover the first 'Developer ID"
    err "  Application' identity instead."
    return 1
  fi

  # `|| true` INSIDE the substitution (not after the assignment): a standalone
  # `var=$(pipeline)` aborts the whole script under `set -e`/`pipefail` if any stage
  # of the pipeline exits non-zero (e.g. `security` erroring on a keychain that isn't
  # unlocked yet, a real possibility on a fresh CI runner) — that would skip straight
  # past the fail-closed message below and abort with a raw, unhelpful bash error
  # instead. Forcing the pipeline itself to always report success makes "found
  # nothing" and "the lookup errored" collapse into the same, deliberately-handled
  # empty-string case.
  found="$(security find-identity -v -p codesigning 2>/dev/null | awk '/Developer ID Application/ { print $2; exit }' || true)"
  if [ -n "$found" ]; then
    SIGN_ID="$found"
    log "  identity: $SIGN_ID (auto-discovered: $(security find-identity -v -p codesigning 2>/dev/null | awk -v id="$found" '$0 ~ id {sub(/^[ ]*[0-9]+\) [0-9A-F]+ /,""); print; exit}'))"
    return 0
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    SIGN_ID="DRY-RUN-PLACEHOLDER-IDENTITY"
    log "  identity: $SIGN_ID (--dry-run placeholder — no 'Developer ID Application' cert in this keychain)"
    return 0
  fi

  err "✗ No 'Developer ID Application' certificate in this keychain, and MOSH_SIGN_IDENTITY is unset."
  err "  Create it once: Xcode ▸ Settings ▸ Accounts ▸ <Apple ID> ▸ Manage Certificates…"
  err "                  ▸ + ▸ 'Developer ID Application'."
  err "  (An 'Apple Development' or 'Apple Distribution' cert can NOT notarize for"
  err "   direct distribution — it must be a Developer ID Application cert.)"
  err "  In CI, import the cert into the runner's keychain first — see"
  err "  docs/release/SIGNING_RUNBOOK.md 'Running via CI'."
  return 1
}

# ── notary credential resolution (fail-closed) ──────────────────────────────────
# Sets NOTARY_ARGS (array) + NOTARY_DESC (human label for logging).
NOTARY_ARGS=()
NOTARY_DESC=""
resolve_notary_creds() {
  local n_id="${MOSH_NOTARY_APPLE_ID:-}" n_team="${MOSH_NOTARY_TEAM_ID:-}" n_pw="${MOSH_NOTARY_PASSWORD:-}"
  local set_count=0
  [ -n "$n_id" ]   && set_count=$((set_count + 1))
  [ -n "$n_team" ] && set_count=$((set_count + 1))
  [ -n "$n_pw" ]   && set_count=$((set_count + 1))

  if [ "$set_count" -eq 3 ]; then
    NOTARY_ARGS=(--apple-id "$n_id" --team-id "$n_team" --password "$n_pw")
    NOTARY_DESC="explicit Apple-ID/team/app-specific-password (MOSH_NOTARY_APPLE_ID=$n_id, MOSH_NOTARY_TEAM_ID=$n_team)"
  elif [ "$set_count" -gt 0 ]; then
    err "✗ Only $set_count of 3 explicit notary vars are set (need all of"
    err "  MOSH_NOTARY_APPLE_ID, MOSH_NOTARY_TEAM_ID, MOSH_NOTARY_PASSWORD, or none of"
    err "  them to fall back to a keychain profile instead)."
    return 1
  else
    local profile="${MOSH_NOTARY_PROFILE:-mosh-notary}"
    NOTARY_ARGS=(--keychain-profile "$profile")
    NOTARY_DESC="keychain profile '$profile'"
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    log "  notary creds: $NOTARY_DESC (--dry-run skips the live notarytool check)"
    return 0
  fi

  if ! xcrun notarytool history "${NOTARY_ARGS[@]}" >/dev/null 2>&1; then
    err "✗ Notary credentials invalid or unreachable: $NOTARY_DESC"
    if [ "$set_count" -eq 3 ]; then
      err "  Double-check MOSH_NOTARY_APPLE_ID / MOSH_NOTARY_TEAM_ID / MOSH_NOTARY_PASSWORD"
      err "  (the password must be an APP-SPECIFIC password from appleid.apple.com, not"
      err "  the Apple ID account password)."
    else
      err "  Set it up once (make an app-specific password at appleid.apple.com first):"
      err "    xcrun notarytool store-credentials \"${NOTARY_ARGS[1]}\" \\"
      err "      --apple-id <you@example.com> --team-id <TEAMID> --password <app-specific-pw>"
      err "  Or set MOSH_NOTARY_APPLE_ID/MOSH_NOTARY_TEAM_ID/MOSH_NOTARY_PASSWORD instead"
      err "  (no keychain profile needed — the mode CI uses)."
    fi
    return 1
  fi
  log "  notary creds: $NOTARY_DESC (live-verified via notarytool history)"
  return 0
}

preflight() {
  log "preflight:"
  resolve_identity || fail "identity preflight failed (see above)"
  resolve_notary_creds || fail "notary credential preflight failed (see above)"
  log "preflight: OK"
}

# ── signing ──────────────────────────────────────────────────────────────────────
# Deep, INSIDE-OUT signing: nested Mach-O (dylibs/frameworks/helper executables)
# first, each WITHOUT entitlements (Apple: entitlements only apply to the main
# executable), then the outer bundle last, WITH entitlements. Apple discourages
# `codesign --deep` for distribution signing (it can silently skip or mis-sign nested
# code); explicit inside-out beats it. In Mosh's default build there is no nested
# Mach-O (JUCE links statically) — this loop is what covers the anira build's bundled
# LibTorch/libanira dylibs if that variant is ever routed through this script.
sign_app_bundle() {                                # $1 = app path
  local DEST="$1" f
  run xattr -cr "$DEST" || true

  while IFS= read -r f; do
    run codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$f"
  done < <(find "$DEST/Contents" -type f \( -name '*.dylib' -o -name '*.so' \) 2>/dev/null)

  while IFS= read -r f; do
    run codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$f"
  done < <(find "$DEST/Contents" -type d -name '*.framework' 2>/dev/null)

  # Nested Mach-O executables (helper tools), if any ever appear. The main app
  # executable is sealed by the whole-bundle sign below, not here.
  while IFS= read -r f; do
    [ "$f" = "$DEST/Contents/MacOS/Mosh" ] && continue
    if file "$f" 2>/dev/null | grep -q 'Mach-O'; then
      run codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$f"
    fi
  done < <(find "$DEST/Contents/MacOS" "$DEST/Contents/Helpers" -type f 2>/dev/null)

  run codesign --force --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" --sign "$SIGN_ID" "$DEST"

  if [ "$DRY_RUN" -eq 0 ]; then
    sleep 1
    xattr -cr "$DEST" 2>/dev/null || true
    codesign --verify --deep --strict "$DEST"
    log "  signature: valid (Developer ID, Hardened Runtime + entitlements)"
    log "  embedded entitlements:"
    codesign -dv --entitlements :- "$DEST" 2>&1 | sed 's/^/    /' || true
  else
    log "[dry-run] would then: sleep 1; xattr -cr; codesign --verify --deep --strict; codesign -dv --entitlements :-"
  fi
}

# A .dmg/.zip/.pkg gets a plain signature — no entitlements, no Hardened Runtime
# (those only mean something for an executable Mach-O bundle).
sign_flat_file() {                                 # $1 = file path
  run codesign --force --timestamp --sign "$SIGN_ID" "$1"
  if [ "$DRY_RUN" -eq 0 ]; then
    codesign --verify "$1"
    log "  signature: valid ($1)"
  fi
}

# ── notarization ─────────────────────────────────────────────────────────────────
notarize_target() {                                # $1 = app or flat-file path
  local TGT="$1" TMP="" SUBMIT="$1" rc=0 sub_out="" sub_id=""
  if [[ "$TGT" == *.app ]]; then
    TMP="$(mktemp -d)"
    SUBMIT="$TMP/$(basename "$TGT" .app).zip"
    run ditto -c -k --keepParent "$TGT" "$SUBMIT"
  fi

  log "  submitting to Apple notary ($NOTARY_DESC) — 1–5 min…"
  if [ "$DRY_RUN" -eq 1 ]; then
    run xcrun notarytool submit "$SUBMIT" "${NOTARY_ARGS[@]}" --wait
    [ -n "$TMP" ] && rm -rf "$TMP"
    return 0
  fi

  set +e
  sub_out="$(xcrun notarytool submit "$SUBMIT" "${NOTARY_ARGS[@]}" --wait 2>&1)"
  rc=$?
  set -e
  printf '%s\n' "$sub_out" | sed 's/^/    /'
  [ -n "$TMP" ] && rm -rf "$TMP"

  if [ "$rc" -ne 0 ]; then
    sub_id="$(printf '%s\n' "$sub_out" | awk '/^[[:space:]]*id:/ {print $2; exit}' || true)"
    if [ -n "$sub_id" ]; then
      err "  notarization failed — fetching the log for submission $sub_id…"
      xcrun notarytool log "$sub_id" "${NOTARY_ARGS[@]}" 2>&1 | sed 's/^/    /' >&2 || true
    fi
    return "$rc"
  fi
  log "  notarization: accepted"
}

staple_target() {                                  # $1 = app or flat-file path
  run xcrun stapler staple "$1"
  run xcrun stapler validate "$1"
}

final_verify() {                                   # $1 = app or flat-file path
  local TGT="$1"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] would then: codesign --verify --deep --strict; spctl -a -vvv"
    return 0
  fi
  codesign --verify --deep --strict "$TGT"
  log "  final codesign --verify --deep --strict: OK"
  if [[ "$TGT" == *.app ]]; then
    spctl -a -t exec -vvv "$TGT" 2>&1 | sed 's/^/  gatekeeper: /'
  else
    spctl -a -t open -vvv "$TGT" 2>&1 | sed 's/^/  gatekeeper: /'
  fi
}

# ── main ─────────────────────────────────────────────────────────────────────────
log "scripts/release/sign-and-notarize.sh $([ "$DRY_RUN" -eq 1 ] && printf '[DRY-RUN] ')$([ "$PREFLIGHT_ONLY" -eq 1 ] && printf '[preflight-only] ')${TARGET:-}"

preflight

if [ "$PREFLIGHT_ONLY" -eq 1 ]; then
  log "preflight-only: no target given, nothing signed. Exiting 0."
  exit 0
fi

[ -e "$TARGET" ] || fail "target not found: $TARGET"

IS_APP=0
case "$TARGET" in
  *.app) IS_APP=1 ;;
esac

if [ "$IS_APP" -eq 1 ]; then
  [ -f "$TARGET/Contents/Info.plist" ] || fail "not a valid app bundle (no Contents/Info.plist): $TARGET"
  [ -f "$ENTITLEMENTS" ] || fail "entitlements file not found: $ENTITLEMENTS"
  xmllint --noout "$ENTITLEMENTS" ||
    fail "entitlements file is not valid XML (codesign would reject it): $ENTITLEMENTS"
  log "plist check (pre-sign):"
  check_plist "$TARGET" "pre-sign" || fail "refusing to sign a bundle that's already missing required Info.plist keys — fix the build, not this script"
fi

log "signing…"
if [ "$IS_APP" -eq 1 ]; then
  sign_app_bundle "$TARGET"
  log "plist check (post-sign):"
  check_plist "$TARGET" "post-sign" || fail "signing altered/stripped a required Info.plist key — this is the exact regression class this guard exists to catch"
else
  sign_flat_file "$TARGET"
fi

if [ "$SIGN_ONLY" -eq 1 ]; then
  log "--sign-only: skipping notarize/staple."
  exit 0
fi

log "notarizing…"
notarize_target "$TARGET"

log "stapling…"
staple_target "$TARGET"

log "final verification…"
final_verify "$TARGET"

if [ "$IS_APP" -eq 1 ]; then
  log "plist check (post-staple):"
  check_plist "$TARGET" "post-staple" || fail "notarization/stapling altered/stripped a required Info.plist key — this is the exact regression class this guard exists to catch"
fi

log "✓ $(basename "$TARGET"): signed, notarized, stapled, verified."
