#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVICE_ID="${MOSH_IOS_DEVICE_ID:-00008110-001E4D920181401E}"
TEAM_ID="${MOSH_IOS_TEAM_ID:-auto}"
DERIVED="$ROOT/build/ios-device"
PROJECT="$ROOT/ios/MoshCompanion/MoshCompanion.xcodeproj"
APP="$DERIVED/Build/Products/Debug-iphoneos/MoshCompanion.app"
BUNDLE_ID="studio.mosh.companion"
LAUNCH_LOG="$DERIVED/launch.log"

apple_development_identity_exists() {
  security find-identity -p codesigning -v | grep -q "Apple Development"
}

detect_team_id() {
  local from_cert from_xcode

  from_cert="$(security find-certificate -c "Apple Development" -p 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null \
    | sed -nE 's/.*OU ?= ?([A-Z0-9]+).*/\1/p' \
    | head -n 1)"
  if [[ -n "$from_cert" ]]; then
    printf '%s\n' "$from_cert"
    return 0
  fi

  from_xcode="$(defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier 2>/dev/null \
    | sed -nE 's/^[[:space:]]*([A-Z0-9]{10}) = \\{.*/\1/p' \
    | head -n 1)"
  if [[ -n "$from_xcode" ]]; then
    printf '%s\n' "$from_xcode"
    return 0
  fi
}

if [[ "$TEAM_ID" == "auto" ]]; then
  TEAM_ID="$(detect_team_id || true)"
fi

if [[ -z "$TEAM_ID" ]]; then
  cat >&2 <<'MSG'
No Apple Development team ID was found.

Free Personal Team path:
  1. Open Xcode > Settings > Accounts.
  2. Add your normal Apple Account; paid Developer Program enrollment is not required.
  3. Select the Personal Team and create an Apple Development certificate if Xcode offers it.
  4. Re-run this script, or set the team ID only in your shell:

  export MOSH_IOS_TEAM_ID=ABCDE12345
MSG
  exit 2
fi

if ! apple_development_identity_exists; then
  cat >&2 <<'MSG'
No valid Apple Development signing identity was found in the login keychain.
Continuing anyway because Xcode automatic signing with -allowProvisioningUpdates
may create a Personal Team development certificate after your Apple Account is
added in Xcode. If the build fails, open Xcode > Settings > Accounts and use
Manage Certificates to create Apple Development.
MSG
fi

DEVICE_DETAILS="$(xcrun devicectl device info details --device "$DEVICE_ID" 2>&1 || true)"
if ! grep -q "developerModeStatus: enabled" <<<"$DEVICE_DETAILS"; then
  echo "$DEVICE_DETAILS" >&2
  echo "Developer Mode is not enabled or the iPhone is not reachable." >&2
  exit 4
fi

# File-provider/Finder metadata can be copied into local build products and make
# device codesign fail with "resource fork ... detritus not allowed".
xattr -cr "$PROJECT" "$ROOT/ios/MoshCompanion/MoshCompanion" "$DERIVED" 2>/dev/null || true

xcodebuild \
  -project "$PROJECT" \
  -scheme MoshCompanion \
  -configuration Debug \
  -destination "platform=iOS,id=$DEVICE_ID" \
  -derivedDataPath "$DERIVED" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  -allowProvisioningUpdates \
  build

test -d "$APP"
xcrun devicectl device install app --device "$DEVICE_ID" "$APP"
set +e
xcrun devicectl device process launch --device "$DEVICE_ID" --terminate-existing "$BUNDLE_ID" > "$LAUNCH_LOG" 2>&1
LAUNCH_STATUS=$?
set -e

if [[ "$LAUNCH_STATUS" -ne 0 ]]; then
  if grep -qi "not been explicitly trusted\\|profile has not been explicitly trusted" "$LAUNCH_LOG"; then
    cat "$LAUNCH_LOG" >&2
    cat >&2 <<'MSG'

Mosh Companion installed, but iOS refused to launch it because the Personal Team
developer profile has not been trusted on the phone yet.

On the iPhone:
  Settings > General > VPN & Device Management > Developer App
  Trust "Apple Development: emiliosanchezharris@gmail.com"

Then rerun:
  scripts/iphone-companion-device-gate.sh
MSG
    exit 5
  fi

  cat "$LAUNCH_LOG" >&2
  exit "$LAUNCH_STATUS"
fi

cat <<MSG
Mosh Companion installed and launched on $DEVICE_ID.
Next manual gate: scan the Mac QR, record two 5-second takes, verify JSONL/undo/save/reload.
MSG
