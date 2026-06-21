#!/usr/bin/env bash
#
# Hardware-free simulator gate for the iOS Companion.
#
# Builds and unit-tests the MoshCompanion app against an iOS Simulator with code
# signing disabled, so it needs no Apple Account, provisioning profile, or
# physical iPhone. This is the cheap CI-ready counterpart to the physical
# `iphone-companion-device-gate.sh`: it catches the real compile/typecheck and
# CompanionClientTests regressions that `swiftc -parse` alone cannot (parse only
# checks syntax, not cross-file symbol resolution or Swift 6 concurrency).
#
# Usage:
#   scripts/iphone-companion-sim-gate.sh                 # build + test (default)
#   MOSH_IOS_SIM_GATE_MODE=build scripts/...             # build-only smoke
#   MOSH_IOS_SIM_NAME='iPhone 16' scripts/...            # pin the simulator model
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT/ios/MoshCompanion/MoshCompanion.xcodeproj"
DERIVED="${MOSH_IOS_SIM_DERIVED_DATA:-${TMPDIR:-/tmp}/mosh-ios-sim}"
MODE="${MOSH_IOS_SIM_GATE_MODE:-test}"   # "test" (build+test) or "build" (build-only)
TIMEOUT_SECONDS="${MOSH_IOS_SIM_GATE_TIMEOUT_SECONDS:-${MOSH_IOS_SIM_GATE_TIMEOUT:-300}}"

if ! xcrun -f xcodebuild >/dev/null 2>&1; then
  echo "xcodebuild (full Xcode) is required; Command Line Tools alone cannot build the app." >&2
  exit 2
fi

if ! python3 - "$TIMEOUT_SECONDS" <<'PY'
import sys

try:
    timeout = float(sys.argv[1])
except ValueError:
    raise SystemExit(1)
if timeout <= 0:
    raise SystemExit(1)
PY
then
  echo "MOSH_IOS_SIM_GATE_TIMEOUT_SECONDS must be a positive number of seconds." >&2
  exit 2
fi

# Pick an available iPhone simulator. CI runners and laptops carry different
# device sets, so resolve a concrete model instead of hardcoding one. Override
# with MOSH_IOS_SIM_NAME when a specific model is desired.
SIM_UDID="${MOSH_IOS_SIM_UDID:-}"
SIM_NAME="${MOSH_IOS_SIM_NAME:-}"
if [[ -z "$SIM_UDID" && -z "$SIM_NAME" ]]; then
  SIM_NAME="$(xcrun simctl list devices available \
    | sed -nE 's/^[[:space:]]*(iPhone[^(]*) \([0-9A-F-]{36}\).*/\1/p' \
    | sed -E 's/[[:space:]]+$//' \
    | head -n 1)"
fi

if [[ -z "$SIM_UDID" && -z "$SIM_NAME" ]]; then
  echo "No available iPhone simulator found. Install one via Xcode > Settings > Components." >&2
  exit 3
fi

if [[ -n "$SIM_UDID" ]]; then
  DESTINATION="platform=iOS Simulator,id=$SIM_UDID"
  DESTINATION_LABEL="$SIM_UDID"
else
  DESTINATION="platform=iOS Simulator,name=$SIM_NAME"
  DESTINATION_LABEL="$SIM_NAME"
fi
echo "iOS companion simulator gate: mode=$MODE destination='$DESTINATION'"

python3 - "$TIMEOUT_SECONDS" \
  xcodebuild "$MODE" \
    -project "$PROJECT" \
    -scheme MoshCompanion \
    -configuration Debug \
    -destination "$DESTINATION" \
    -derivedDataPath "$DERIVED" \
    CODE_SIGNING_ALLOWED=NO <<'PY'
import subprocess
import sys

timeout = float(sys.argv[1])
command = sys.argv[2:]
process = subprocess.Popen(command)
try:
    raise SystemExit(process.wait(timeout=timeout))
except subprocess.TimeoutExpired:
    sys.stderr.write(
        f"iOS companion simulator gate timed out after {timeout:g}s; terminating xcodebuild.\n"
    )
    subprocess.run(["pkill", "-TERM", "-P", str(process.pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        subprocess.run(["pkill", "-KILL", "-P", str(process.pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        process.kill()
        process.wait()
    raise SystemExit(124)
PY

echo "iOS companion simulator gate PASSED ($MODE on '$DESTINATION_LABEL')."
