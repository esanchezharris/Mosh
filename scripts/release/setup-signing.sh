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
  cd "$REPO"
  # MOSH_BRAIN_ENV is set explicitly: a stale profile export pointing at a missing
  # file silently ships a brain-less bundle (known landmine).
  MOSH_BRAIN_ENV="${MOSH_BRAIN_ENV:-$REPO/ui/.env.local}" \
  MOSH_NOTARY_PROFILE="$PROFILE" \
    ./run-mosh.sh release
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
