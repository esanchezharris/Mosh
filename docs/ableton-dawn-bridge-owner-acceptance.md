# Ableton DAWN Bridge: owner setup and acceptance

This runbook is for the owner Mac and Ableton Live 11. Use a disposable scratch
Set until every physical gate passes. The bridge is a controller only: Ableton
records from the Mac's selected microphone or audio interface. The iPhone never
captures, uploads, or streams audio.

## What repository automation proves

The repository gates prove strict phone JSON parsing, bearer authentication,
semantic action payloads, request revision/idempotency behavior, mode-specific
tiles, current-session navigator regions, recording-time seek blocking, and the
native loopback/LAN bridge boundaries. They do not prove real Live audio,
physical iPhone reachability, Live proxy behavior, routing preservation, audible
playback, or Live's Undo menu.

Run the automated slice before the physical session:

```sh
cd /path/to/Mosh
cd ui
npm ci
npm run typecheck
for run in 1 2 3; do npx vitest run src/companion; done
npm run build:companion
cd ..

export MOSH_DAWN_BUILD_DIR="$HOME/Library/Mosh/work/build-dawn-owner"
scripts/build-and-run-dawn-bridge.sh verify
```

`verify` builds the opt-in, audio-free menu-bar app, runs its focused native
tests, checks the staged companion/Remote Script resources, launches one isolated
instance, and stops only that instance. It does not launch Live or write the real
Ableton User Library.

## Build and install the owner app

After `verify` succeeds, run this Bash transaction. It addresses the bridge by
its exact bundle identifier, requests a normal app quit, refuses to replace a
bundle while that exact app is still running, stages on the target volume, and
keeps the prior bundle until the replacement passes its readiness check:

```bash
set -Eeuo pipefail

bundle_id="studio.mosh.dawn-bridge"
install_root="$HOME/Applications"
source_app="${MOSH_DAWN_BUILD_DIR:?set MOSH_DAWN_BUILD_DIR}/src/dawn_bridge/MoshDawnBridge.app"
target_app="$install_root/MoshDawnBridge.app"
descriptor="$HOME/Library/Application Support/Mosh/DAWN Bridge/remote-script.json"
staging_root=""
staged_app=""
previous_app=""
failed_app=""
previous_was_running=0
previous_moved=0
new_activated=0
install_complete=0
mutation_started=0

fail() {
  printf 'DAWN install failed: %s\n' "$1" >&2
  exit 1
}

running_bridge_pids() {
  /usr/bin/osascript <<'APPLESCRIPT'
tell application "System Events"
  set bridgePids to unix id of every application process whose bundle identifier is "studio.mosh.dawn-bridge"
end tell
set AppleScript's text item delimiters to linefeed
return bridgePids as text
APPLESCRIPT
}

quit_exact_bridge() {
  local pids count
  pids="$(running_bridge_pids)" || return 1
  count="$(printf '%s\n' "$pids" | /usr/bin/awk 'NF { count += 1 } END { print count + 0 }')" || return 1
  if (( count == 0 )); then
    return 0
  fi
  if (( count != 1 )); then
    printf 'refusing to quit %s exact-bundle processes\n' "$count" >&2
    return 1
  fi
  /usr/bin/osascript -e 'tell application id "studio.mosh.dawn-bridge" to quit' || return 1
  for _ in {1..50}; do
    pids="$(running_bridge_pids)" || return 1
    [[ -z "$pids" ]] && return 0
    /bin/sleep 0.1 || return 1
  done
  printf 'exact DAWN bridge did not quit; bundle was not replaced\n' >&2
  return 1
}

ready_bridge_pid() {
  local pids count pid port listeners listener_count
  pids="$(running_bridge_pids)" || return 1
  count="$(printf '%s\n' "$pids" | /usr/bin/awk 'NF { count += 1 } END { print count + 0 }')" || return 1
  (( count == 1 )) || return 1
  pid="$pids"
  [[ -f "$descriptor" && ! -L "$descriptor" ]] || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$descriptor")" == "600" ]] || return 1
  port="$(/usr/bin/python3 - "$descriptor" <<'PY'
import json
import re
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    value = json.load(handle)
valid = (
    set(value) == {"protocol", "host", "port", "secret"}
    and value["protocol"] == 1
    and value["host"] == "127.0.0.1"
    and isinstance(value["port"], int)
    and 0 < value["port"] < 65536
    and isinstance(value["secret"], str)
    and re.fullmatch(r"[0-9a-f]{64}", value["secret"])
)
if not valid:
    raise SystemExit(1)
print(value["port"])
PY
)" || return 1
  listeners="$(/usr/sbin/lsof -nP -a -p "$pid" -iTCP -sTCP:LISTEN -Fn 2>/dev/null \
    | /usr/bin/sed -n 's/^n//p')" || return 1
  printf '%s\n' "$listeners" | /usr/bin/grep -Eq ":${port}$" || return 1
  listener_count="$(printf '%s\n' "$listeners" | /usr/bin/awk 'NF { count += 1 } END { print count + 0 }')" || return 1
  (( listener_count >= 2 )) || return 1
  printf '%s\n' "$pid"
}

wait_until_ready() {
  local ready_pid
  for _ in {1..50}; do
    if ready_pid="$(ready_bridge_pid)"; then
      printf 'DAWN bridge ready (PID %s)\n' "$ready_pid"
      return 0
    fi
    /bin/sleep 0.1 || return 1
  done
  return 1
}

rollback_install() {
  local status=$?
  local rollback_failed=0
  local replacement_stopped=1
  local restored_pids=""
  trap - EXIT INT TERM
  if (( status == 0 || install_complete == 1 || mutation_started == 0 )); then
    exit "$status"
  fi
  set +e
  if (( new_activated == 1 )); then
    if ! quit_exact_bridge; then
      rollback_failed=1
      replacement_stopped=0
    fi
  fi
  if (( replacement_stopped == 1 && previous_moved == 1 )); then
    if [[ -e "$target_app" ]] && ! /bin/mv "$target_app" "$failed_app"; then
      rollback_failed=1
    fi
    if [[ ! -e "$target_app" ]] && ! /bin/mv "$previous_app" "$target_app"; then
      rollback_failed=1
    fi
  elif (( replacement_stopped == 1 && new_activated == 1 )) && [[ -e "$target_app" ]]; then
    /bin/mv "$target_app" "$failed_app" || rollback_failed=1
  fi
  if (( previous_was_running == 1 )); then
    restored_pids="$(running_bridge_pids)" || rollback_failed=1
    if [[ -z "$restored_pids" ]]; then
      /usr/bin/open -n "$target_app" || rollback_failed=1
      wait_until_ready >/dev/null || rollback_failed=1
    fi
  fi
  if (( rollback_failed == 0 )); then
    printf 'Previous DAWN bundle and running state restored or unchanged.\n' >&2
  else
    printf 'ROLLBACK INCOMPLETE; preserved artifacts are under %s\n' "$staging_root" >&2
  fi
  exit "$status"
}
trap rollback_install EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ -d "$source_app" && ! -L "$source_app" ]] || fail "source app is missing or linked"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$source_app/Contents/Info.plist")" == "$bundle_id" ]] \
  || fail "source bundle identifier mismatch"
[[ -x "$source_app/Contents/MacOS/MoshDawnBridge" ]] || fail "source executable is missing"
[[ ! -L "$target_app" ]] || fail "refusing linked target app"
[[ ! -e "$target_app" || -d "$target_app" ]] || fail "target exists but is not an app directory"
/bin/mkdir -p "$install_root" || fail "cannot create owner Applications directory"
staging_root="$(/usr/bin/mktemp -d "$install_root/.MoshDawnBridge.install.XXXXXX")" \
  || fail "cannot create same-volume staging directory"
/bin/chmod 700 "$staging_root" || fail "cannot protect staging directory"
staged_app="$staging_root/MoshDawnBridge.app"
previous_app="$staging_root/MoshDawnBridge.previous.app"
failed_app="$staging_root/MoshDawnBridge.failed.app"
/usr/bin/ditto "$source_app" "$staged_app" || fail "cannot copy source bundle into staging"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$staged_app/Contents/Info.plist")" == "$bundle_id" ]] \
  || fail "staged bundle identifier mismatch"
[[ -x "$staged_app/Contents/MacOS/MoshDawnBridge" ]] || fail "staged executable is missing"

existing_pids="$(running_bridge_pids)" || fail "cannot query exact running app identity"
if [[ -n "$existing_pids" ]]; then
  previous_was_running=1
  mutation_started=1
  quit_exact_bridge || fail "running exact DAWN bridge would not quit cleanly"
fi
[[ ! -e "$descriptor" && ! -L "$descriptor" ]] || fail "descriptor remains after exact app quit"
mutation_started=1
if [[ -e "$target_app" ]]; then
  /bin/mv "$target_app" "$previous_app" || fail "cannot retain prior bundle"
  previous_moved=1
fi
/bin/mv "$staged_app" "$target_app" || fail "cannot activate staged bundle"
new_activated=1
/usr/bin/open -n "$target_app" || fail "launch request failed"
wait_until_ready || fail "replacement did not reach dual-server readiness"

if (( previous_moved == 1 )); then
  printf 'Prior bundle retained at %s\n' "$previous_app"
else
  /bin/rmdir "$staging_root" || fail "cannot remove empty staging directory"
  staging_root=""
fi
install_complete=1
trap - EXIT INT TERM
```

The readiness check requires one process with bundle identifier
`studio.mosh.dawn-bridge`, a strict owner-only descriptor whose loopback port is
owned by that process, and a second listening socket for HTTP. Those are the two
server-start conditions that initially make the menu report `Bridge: Ready`; the
menu may then say `Bridge: Waiting for Live script` until Live connects. A prior
bundle is deliberately left at the printed staging path after success. Remove it
only after the physical scratch-Set gates pass. Ordinary failures restore both
the prior bundle and whether it was running. If macOS refuses the exact app's
normal quit or a filesystem operation fails during rollback, the script does not
use broad or forced process killing; it reports `ROLLBACK INCOMPLETE` and retains
the recovery artifacts at the printed staging path.

Do not enable launch-at-login. Only one bridge instance should run. A `DAWN`
item appears in the macOS menu bar and should say `Bridge: Ready`.

From the `DAWN` menu:

1. Choose **Install / Update MoshDawnController…**. This is the only step that
   writes the real User Library, at `Music/Ableton/User Library/Remote
   Scripts/MoshDawnController`.
2. Quit and reopen Live if it was open during installation.
3. In Live 11 **Preferences → Link/MIDI**, add/select:
   **Control Surface: MoshDawnController**, **Input: None**, **Output: None**.
4. Leave every existing AbletonOSC row and its Input/Output selections unchanged.
   The DAWN installer must not replace, update, or remove AbletonOSC.

## Prepare the scratch Set

1. Create a new scratch Live 11 Set; do not use `Tattoo` or another owner project.
2. Create at least three audio tracks. Put obvious test material on the second
   track over one intended take range so the overlap gate is unambiguous.
3. On the source track, choose the real Mac microphone/interface input and arm
   it. Confirm Live's input meter responds to that Mac input.
4. Record the initial values of Arrangement loop/range, punch in/out, count-in,
   metronome, monitoring, source routing, and edit marker. DAWN must leave them
   alone unless the action contract explicitly moves the edit marker.
5. If testing multiple armed tracks, arm two audio tracks and make the upper one
   visually unmistakable. The topmost armed audio track must win.
6. In the `DAWN` menu choose **Show Pairing QR…** and scan it in iPhone Safari.
   The URL is per-launch and has the form `/web#token=…`; the token must disappear
   from Safari's visible URL immediately.
7. Confirm Safari asks for no microphone permission and shows no microphone
   capture indicator. Audio must remain Mac-interface-only.

The Ableton pad must contain exactly **PUT ME IN, KEEP, AGAIN, HEAR IT, STOP**.
**MARKER must not exist**, including while rearranging tiles. Long-press a tile,
reorder it, finish editing, reload the QR in the same launch, and confirm the
five-tile order remains editable without MARKER reappearing.

## Physical scratch-Set gates

Record the Live Set state before and after every gate. Stop on any ambiguity;
never repeat a destructive tap hoping it will recover.

### Core recording loop

- **PUT ME IN:** starts recording on the topmost armed audio track at the edit
  marker. A second fast tap is suppressed while the first is busy.
- **Long KEEP (more than one bar):** archives the pending clip at its original
  timeline position exactly one track down, moves the edit marker to one bar
  before the saved stop, and immediately records the next pass. Verify the
  destination's audible content and exact start/end before accepting source
  cleanup.
- **Short KEEP (one bar or less):** archives and immediately records again, but
  leaves the edit marker at the pass start.
- **AGAIN:** stops, deletes only the current pending take, leaves the edit marker
  unchanged, and records again. Previously accepted archive clips remain intact.
- **HEAR IT:** ends an active pass without accepting or deleting it, then uses
  original Space-style playback continuously from the edit marker. It must not
  invent a take-end auto-stop or change Live's range.
- **STOP:** stops transport and leaves the pending take available. It does not
  keep, delete, seek, or restart recording.
- **Implicit KEEP:** with a pending take, tap PUT ME IN once. The prior take must
  complete the full KEEP transaction before the new pass begins; it is one phone
  action, not a client-side command sequence.

### Topology and safety

- **Overlap:** when the track directly below already has overlapping material,
  that material remains byte-for-byte/audibly unchanged. DAWN inserts a clean
  source-track duplicate directly below, preserves the source name, devices and
  routing, disarms the clone, removes all other copied Arrangement and Session
  clips, and places only the accepted clip at its original time.
- **Multiple armed tracks:** the topmost armed audio track is the source. Frozen,
  non-audio, unarmable, or lower armed tracks must not silently replace it.
- **Current-session navigator:** only the pending clip and archive clips created
  during this Live/Remote-Script session appear, in beats. Unrelated Arrangement
  and Session clips must never appear. Quit/reopen Live and confirm archive
  history starts fresh rather than being written into or beside the Set.
- **Seek:** drag the navigator while stopped/playing and confirm the request seeks
  to the displayed beat. While recording it is visibly disabled and Live does
  not move.
- **Manual invalidation:** rename/delete/move the pending clip or source track,
  or switch Sets, and confirm the pad shows BLOCKED rather than adopting a clip
  or retrying a destructive action.

### Disconnect and recovery

- Turn off iPhone Wi-Fi during recording. Live recording continues; the phone
  shows DISCONNECTED. Restoring Wi-Fi must not replay the last tap.
- Quit the DAWN Bridge during recording. Live recording continues. The phone
  shows DISCONNECTED and no cached action is applied after relaunch.
- Relaunch the bridge/Remote Script after ambiguous manual changes. It must fail
  closed instead of silently adopting a pending take.
- Exercise a stale-revision tap by changing Live between snapshot and action.
  The phone shows BLOCKED/stale state, refreshes, and never retries the action.

### Live preservation and undo

- Compare the recorded before/after values: Arrangement loop/range, punch in/out,
  count-in, metronome, and monitoring remain unchanged. HEAR IT retains original
  Space behavior.
- For one successful compound KEEP, choose Live **Edit → Undo** once. One Undo
  should reverse the owned archive/restart transaction when Live exposes the
  compound undo API; no partial duplicate or deleted source may remain.
- Confirm the AbletonOSC Preferences row, files, connection/status, and an
  owner-known AbletonOSC read still work exactly as before. DAWN is additive and
  must not touch that installation.

## Final ten-minute owner gate

Run one uninterrupted ten-minute vocal session controlled from the iPhone. Use
PUT ME IN, multiple long and short KEEPs, at least one AGAIN, HEAR IT, navigator
seek while not recording, and STOP. Do not use the Mac keyboard for the take loop
except an emergency stop. Listen through the normal Mac monitoring path and
confirm the archived takes, timing, lead-in behavior, source routing, and pending
take are musically and operationally correct.

This final gate is physical owner evidence. A green Vitest/native suite, browser
screenshot, QR image, menu status, mock server, or silent render does not replace
the real iPhone + Live 11 + Mac audio-interface run.
