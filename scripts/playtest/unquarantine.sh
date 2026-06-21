#!/usr/bin/env bash
# unquarantine.sh — clear macOS Gatekeeper quarantine on a freshly-received Mosh.app
# so an unsigned build opens without the "Apple could not verify" block. Run once per
# machine after copying the app over (AirDrop/Dropbox/zip). Safe + reversible.
#
# Usage:
#   ./unquarantine.sh                      # operates on /Applications/Mosh.app
#   ./unquarantine.sh /path/to/Mosh.app    # or a custom location
set -euo pipefail

APP="${1:-/Applications/Mosh.app}"

if [ ! -d "$APP" ]; then
  echo "✗ Not found: $APP" >&2
  echo "  Copy Mosh.app into /Applications first, or pass its path." >&2
  exit 1
fi

echo "Clearing quarantine on: $APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

# Report whether any quarantine attribute remains (informational).
if xattr -p com.apple.quarantine "$APP" >/dev/null 2>&1; then
  echo "⚠ A quarantine attribute is still present — try: right-click → Open, then Open Anyway."
else
  echo "✓ Quarantine cleared. Double-click Mosh.app to launch."
fi
