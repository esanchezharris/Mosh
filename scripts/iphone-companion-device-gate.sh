#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVICE_ID="${MOSH_IOS_DEVICE_ID:-00008110-001E4D920181401E}"
TEAM_ID="${MOSH_IOS_TEAM_ID:-auto}"
DERIVED="$ROOT/build/ios-device"
PROJECT="$ROOT/ios/MoshCompanion/MoshCompanion.xcodeproj"
APP="$DERIVED/Build/Products/Debug-iphoneos/MoshCompanion.app"
BUNDLE_ID="studio.mosh.companion"

apple_development_identity_exists() {
  security find-identity -p codesigning -v | grep -q "Apple Development"
}

detect_team_id() {
  local from_identity from_cert
  from_identity="$(security find-identity -p codesigning -v 2>/dev/null \
    | sed -nE 's/.*Apple Development:.*\(([A-Z0-9]+)\).*/\1/p' \
    | head -n 1)"
  if [[ -n "$from_identity" ]]; then
    printf '%s\n' "$from_identity"
    return 0
  fi

  from_cert="$(security find-certificate -c "Apple Development" -p 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null \
    | sed -nE 's/.*OU ?= ?([A-Z0-9]+).*/\1/p' \
    | head -n 1)"
  if [[ -n "$from_cert" ]]; then
    printf '%s\n' "$from_cert"
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
xcrun devicectl device process launch --device "$DEVICE_ID" --terminate-existing "$BUNDLE_ID"

cat <<MSG
Mosh Companion installed and launched on $DEVICE_ID.
Next manual gate: scan the Mac QR, record two 5-second takes, verify JSONL/undo/save/reload.
MSG
