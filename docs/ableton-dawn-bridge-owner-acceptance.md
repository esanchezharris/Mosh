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

After `verify` succeeds, install that exact bundle in the owner's Applications
folder and launch it manually:

```sh
install_root="$HOME/Applications"
target_app="$install_root/MoshDawnBridge.app"
mkdir -p "$install_root"
staging_root="$(mktemp -d "$install_root/.MoshDawnBridge.install.XXXXXX")"
ditto \
  "$MOSH_DAWN_BUILD_DIR/src/dawn_bridge/MoshDawnBridge.app" \
  "$staging_root/MoshDawnBridge.app"
if [ -e "$target_app" ]; then
  mv "$target_app" "$staging_root/MoshDawnBridge.previous.app"
fi
if ! mv "$staging_root/MoshDawnBridge.app" "$target_app"; then
  if [ -e "$staging_root/MoshDawnBridge.previous.app" ]; then
    mv "$staging_root/MoshDawnBridge.previous.app" "$target_app"
  fi
  exit 1
fi
rm -rf "$staging_root/MoshDawnBridge.previous.app"
rmdir "$staging_root"
open "$target_app"
```

The new bundle is staged on the same volume, then renamed into place; it never
merges files into an older app bundle. If activation fails, the commands restore
the previous bundle before exiting.

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
