#!/usr/bin/env bash
# setup-signing.sh — one-command Developer ID signing + notarization setup.
#
# Idempotent preflight + runner. Run it as many times as you like:
#   • Missing pieces  → tells you EXACTLY the (few) steps only you can do, then exits 1.
#   • Everything present → runs the real build → sign → notarize → staple → verify.
#
# Two steps can never be automated here, by design: creating the Developer ID
# certificate (needs your Apple ID session) and storing the notarization
# credential (needs your app-specific password). Everything else is automatic.
set -euo pipefail

REPO="${MOSH_REPO:-$HOME/Mosh}"
TEAM_ID="${MOSH_TEAM_ID:-ZYT77F9B27}"          # paid Developer Program team (NOT the personal 56SL5G7L8X)
PROFILE="${MOSH_NOTARY_PROFILE:-mosh-notary}"
APPLE_ID="${MOSH_APPLE_ID:-emiliosanchezharris@gmail.com}"

ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
no() { printf '  \033[31m✗\033[0m %s\n' "$1"; }

echo
echo "Mosh — Developer ID signing preflight"
echo "  repo=$REPO  team=$TEAM_ID  profile=$PROFILE"
echo

# ── 1. Developer ID Application identity (cert + private key, in the keychain) ──
CERT_LINE=$(security find-identity -v -p codesigning 2>/dev/null | grep 'Developer ID Application' | head -1 || true)
if [ -n "$CERT_LINE" ]; then
  ok "Developer ID Application cert: $(echo "$CERT_LINE" | sed 's/^ *[0-9]*) //')"
  HAVE_CERT=1
else
  no "No 'Developer ID Application' certificate in your keychain."
  HAVE_CERT=0
fi

# ── 2. notarytool credential profile (stored in your keychain, never in this repo) ──
if xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  ok "notarytool profile '$PROFILE' authenticates"
  HAVE_PROFILE=1
else
  no "notarytool profile '$PROFILE' is missing or invalid."
  HAVE_PROFILE=0
fi

echo
if [ "$HAVE_CERT" = 1 ] && [ "$HAVE_PROFILE" = 1 ]; then
  echo "Both present → running the real release now."
  echo "  (build Release → Hardened-Runtime sign → notarytool submit --wait → staple → verify)"
  echo
  [ -x "$REPO/run-mosh.sh" ] || { echo "✗ $REPO/run-mosh.sh not found/executable" >&2; exit 2; }

  # ── brain proxy ────────────────────────────────────────────────────────────
  has_proxy() {
    [ -f "$1" ] \
      && grep -qE '^MOSH_BRAIN_PROXY_URL=.+' "$1" 2>/dev/null \
      && grep -qE '^MOSH_BRAIN_PROXY_APIKEY=.+' "$1" 2>/dev/null
  }
  has_provider_key() {
    [ -f "$1" ] && grep -qE '^[[:space:]]*[A-Z0-9_]+_API_KEY[[:space:]]*=[[:space:]]*.+' "$1" 2>/dev/null
  }
  if [ -n "${MOSH_BRAIN_ENV:-}" ] && [ -f "${MOSH_BRAIN_ENV}" ]; then
    BRAIN_ENV="$MOSH_BRAIN_ENV"
  else
    [ -n "${MOSH_BRAIN_ENV:-}" ] && no "ignoring stale MOSH_BRAIN_ENV='$MOSH_BRAIN_ENV' (missing)"
    BRAIN_ENV="$REPO/ui/.env.local"
  fi
  if has_provider_key "$BRAIN_ENV"; then
    no "Provider API key found in $BRAIN_ENV — refusing to create a distributable artifact."
    echo "    Configure MOSH_BRAIN_PROXY_URL and MOSH_BRAIN_PROXY_APIKEY instead."
    exit 3
  elif has_proxy "$BRAIN_ENV"; then
    ok "brain proxy source: $BRAIN_ENV"
  elif [ "${MOSH_ALLOW_NO_BRAIN:-0}" = "1" ]; then
    no "no complete brain proxy found — continuing anyway (MOSH_ALLOW_NO_BRAIN=1)"
  else
    no "No complete brain proxy in $BRAIN_ENV — the notarized bundle would ship brain-less."
    echo "    Configure the proxy, or re-run with MOSH_ALLOW_NO_BRAIN=1 to accept it."
    exit 3
  fi

  # ── staging dir must NOT be inside iCloud ──────────────────────────────────
  # run-mosh.sh stages a COPY of the app and then signs it. If that staging dir
  # lives in an iCloud file provider (Desktop & Documents syncing), iCloud
  # re-applies com.apple.FinderInfo to the bundle in the window between the
  # script's own `xattr -cr` and codesign, and signing dies with:
  #   "resource fork, Finder information, or similar detritus not allowed"
  # This is unwinnable by stripping harder (observed live on ~/Desktop/Mosh-share),
  # so default the output OUTSIDE iCloud and refuse an iCloud-backed override.
  RELEASE_DIR="${MOSH_RELEASE_DIR:-$HOME/Library/Mosh/release}"
  for probe in "$RELEASE_DIR" "$(dirname "$RELEASE_DIR")"; do
    [ -e "$probe" ] || continue
    if xattr "$probe" 2>/dev/null | grep -qi 'fileprovider\|file-provider'; then
      no "release dir '$RELEASE_DIR' is inside an iCloud-synced folder ($probe)."
      echo "    codesign WILL fail there. Set MOSH_RELEASE_DIR to a non-iCloud path,"
      echo "    e.g. MOSH_RELEASE_DIR=\$HOME/Library/Mosh/release"
      exit 4
    fi
  done
  mkdir -p "$RELEASE_DIR"
  ok "release output: $RELEASE_DIR (outside iCloud)"

  cd "$REPO"
  MOSH_BRAIN_ENV="$BRAIN_ENV" MOSH_NOTARY_PROFILE="$PROFILE" \
  MOSH_RELEASE_DIR="$RELEASE_DIR" ./run-mosh.sh release
  echo
  echo "Done. Verify Gatekeeper will accept it on a guest's Mac:"
  echo "  spctl -a -vvv -t install <the .app or .dmg>   # expect: accepted, source=Notarized Developer ID"
  exit 0
fi

echo "───────────────────────────────────────────────────────────────────"
echo "Only these steps need you (they involve your Apple credentials):"
echo

if [ "$HAVE_CERT" = 0 ]; then
  cat <<EOF
1) Create the Developer ID Application certificate — Xcode does it in ONE click
   (it generates the CSR, creates it on your account, and installs it into your
   keychain; no openssl, no manual upload):

     Xcode → Settings (⌘,) → Accounts → select your Apple ID
       → confirm the team is  $TEAM_ID  (NOT a personal team)
       → Manage Certificates… → "+" → Developer ID Application

   Verified today: your account currently has ONLY two "Development" certs and
   NO Developer ID Application cert — so this creates a fresh one, no duplicate.

EOF
fi

if [ "$HAVE_PROFILE" = 0 ]; then
  cat <<EOF
2) Store the notarization credential once. First make an app-specific password:
   appleid.apple.com → Sign-In & Security → App-Specific Passwords → generate.
   Then run (paste YOUR password — it goes straight into your keychain):

     xcrun notarytool store-credentials "$PROFILE" \\
       --apple-id "$APPLE_ID" \\
       --team-id "$TEAM_ID" \\
       --password "YOUR-APP-SPECIFIC-PASSWORD"

EOF
fi

cat <<EOF
───────────────────────────────────────────────────────────────────
Then re-run this exact script and it does everything else automatically:

  bash $(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/setup-signing.sh

If the team ID above is wrong, override it:  MOSH_TEAM_ID=XXXXXXXXXX bash …/setup-signing.sh
(Check developer.apple.com → View Membership for the authoritative Team ID.)
EOF
exit 1
