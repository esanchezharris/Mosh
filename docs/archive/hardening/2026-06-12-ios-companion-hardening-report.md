# Mosh iOS Companion Hardening Report - 2026-06-12

## Repo Truth

- Seat: `/Users/emiliosanchez-harris/Documents/ClaudeMosh-ios`
- Branch: `codex/ios-companion-park`
- Base at start of work: `dfe1b58` (`origin/codex/ios-companion-park`)
- Project: `ios/MoshCompanion/MoshCompanion.xcodeproj`
- Scheme: `MoshCompanion`
- Simulator: iPhone 17, iOS 26.5, `8D426031-FE82-4E99-9041-CD8171258266`
- Off-limits worktrees were not touched:
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh`
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh-lab`
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/laughing-grothendieck-22549c`
- No merge to `main` was attempted.

## Scope

This pass moved the companion from a simple verified install/launch target
toward a usable phone app while preserving the Mac DAW mutation contract:
all DAW state changes still go through the Mac companion server command path
and MoshOps. The iOS app now treats pairing, connection state, offline safety,
receipts, and command availability as first-class session state instead of
allowing a stale phone to keep issuing commands blindly.

No Mac companion protocol changes were made in this pass.

Per the current local acceptance decision, the iPhone Simulator is the required
local gate for this branch. Physical install/launch has also passed over
CoreDevice local-network access after the phone was already paired with this
Mac. Camera QR pairing, real microphone capture, on-device Speech, and acoustic
monitoring remain manual hardware UX gates.

## Changes Made

- Added explicit companion connection state on iOS:
  `unpaired`, `connecting`, `online`, and `offline`.
- Kept the last successful snapshot visible after transient server failures,
  but marked the session offline and blocked command-sending controls.
- Added offline-safe command guards for transport, render decisions,
  monitoring diagnostics, phone take recording, and hold-to-talk speech
  commands. Offline commands are not queued or sent to the Mac.
- Added user-visible recovery controls:
  - Refresh from the receipts/status surface.
  - Forget Pairing, which clears Keychain pairing data and resets session
    state.
- Added receipts for offline command suppression so the user can tell why a
  phone command did not run.
- Added unit coverage for stale-snapshot offline behavior and Forget Pairing
  state reset.
- Hardened `scripts/iphone-companion-device-gate.sh`:
  - Device DerivedData defaults to a temp directory to avoid Finder/file
    provider metadata poisoning device codesign under `Documents`.
  - Locked-device launch failures are detected and reported with a concrete
    rerun instruction.
- Updated `docs/IPHONE_COMPANION.md` with the device DerivedData behavior and
  override knob.

## Verification

| Gate | Result | Notes |
| --- | --- | --- |
| XcodeBuildMCP session defaults | PASS | Defaults set for the companion Xcode project, scheme, Debug config, iPhone 17 simulator, and bundle id `studio.mosh.companion`. |
| XcodeBuildMCP `test_sim` | PASS | 7 tests passed, 0 failed. Result bundle: `/Users/emiliosanchez-harris/Library/Developer/XcodeBuildMCP/workspaces/ClaudeMosh-61190dceaa86/result-bundles/test_sim_2026-06-12T07-48-57-576Z_pid77130_310ae311.xcresult`. |
| Simulator build/install/launch | PASS | XcodeBuildMCP `build_run_sim` succeeded for `studio.mosh.companion`; runtime log: `/Users/emiliosanchez-harris/Library/Developer/XcodeBuildMCP/workspaces/ClaudeMosh-61190dceaa86/logs/studio.mosh.companion_2026-06-12T06-33-03-259Z_helperpid93452_ownerpid77130_34c3c6c5.log`. |
| Simulator offline workflow | PASS | A stale pairing deep link to `127.0.0.1:9` opened the session, retained the session surface, displayed Offline status, exposed Refresh and Forget Pairing, and suppressed command sending. Screenshot: `/var/folders/ls/q_ndrnbd5bbgg0b9wj_9fw6h0000gn/T/screenshot_optimized_aa95a89d-e854-4977-bed0-37c6dfd44a75.jpg`. |
| Physical iPhone build/install | PASS | `scripts/iphone-companion-device-gate.sh` built for `iphoneos`, signed, and installed `studio.mosh.companion` on the paired iPhone over CoreDevice local-network access. |
| Physical iPhone launch | PASS | `scripts/iphone-companion-device-gate.sh` launched `studio.mosh.companion` over CoreDevice local-network access. |
| iPhone Mirroring visibility | PASS | `/System/Applications/iPhone Mirroring.app` connected after the phone was locked and displayed the real Mosh Companion `MOSH Session` screen paired to the Mac server. |
| iPhone Mirroring tap automation | MANUAL | Computer Use, System Events, and Quartz coordinate taps could focus/click the iPhone Mirroring window but did not forward taps into the mirrored phone surface. Manual iPhone Mirroring control remains the proof path for phone mic UX. |
| Mac CMake configure/build | PASS | `cmake --preset macos-arm64-debug` and `cmake --build --preset macos-arm64-app` succeeded after completing the existing Tracktion/JUCE submodule checkout in this worktree. |
| Mac companion server smoke | PASS | `GET /health`, authenticated `POST /snapshot`, and authenticated nested-MoshOps `POST /command` with `set_transport stop` succeeded against this worktree's `Mosh.app`. |
| Mac CTest | PASS | `ctest --test-dir build-macos-arm64 --output-on-failure`: 1/1 tests passed. |
| Mac selftest | PASS | `MOSH_NO_AUDIO=1 "$APP" --selftest`: `650/650 checks passed, 0 failed`. |
| Mac focused undo selftest | PASS | `MOSH_NO_AUDIO=1 "$APP" --selftest-undo`: `18/18 focused undo checks passed, 0 failed`. |

Latest physical rerun:

- Time: 2026-06-12 00:49 PDT / 2026-06-12 07:49 UTC.
- Command: `scripts/iphone-companion-device-gate.sh`.
- Build: PASS.
- Install: PASS, `studio.mosh.companion` installed on
  `00008110-001E4D920181401E`.
- Launch: PASS.
- Transport: CoreDevice local-network tunnel; no USB device was present in
  `system_profiler SPUSBDataType` during the check.

Latest wireless pairing/mirroring probe:

- Started this worktree's `Mosh.app` with `MOSH_LAB_FEED=1` and a stable local
  token.
- Built a `mosh://pair?...` payload pointing at the Mac's local network address.
- Launched `studio.mosh.companion` on the physical iPhone with
  `xcrun devicectl device process launch --payload-url ...`.
- iPhone Mirroring displayed the real phone app on `MOSH Session` with
  `Forget Pairing`, transport controls, and Session/Talk/Takes/Diagnostics
  tabs visible.
- Automated coordinate clicks into iPhone Mirroring did not change Mac
  transport state, so real mic-take recording was not started. Starting the mic
  workflow remains a manual action because it records and uploads live room
  audio to the local Mac server.

## Phone Workflow Status

Proven on simulator:

- Deep-link pairing into the companion.
- Offline server detection after pairing.
- Stale snapshot retention.
- Refresh affordance.
- Forget Pairing affordance.
- Offline command suppression with receipt feedback.

Proven on physical iPhone:

- Device discovery.
- Development signing.
- Build.
- Install.
- Launch over CoreDevice local-network access.

Manual/hardware-gated, not required for local branch acceptance:

- Real QR pairing against the Mac app from the physical phone.
- Real microphone take recording from the phone.
- Hold-to-talk speech recognition on the physical phone.
- Manual tap-through of the iPhone Mirroring surface, because local automation
  can show the mirrored app but did not forward taps reliably.

## Contract Notes

- The iOS app does not mutate DAW state locally.
- Offline phone actions do not enqueue deferred DAW mutations.
- Transport, render decision, monitoring diagnostic, take recording, and
  speech command flows still call the Mac companion server and rely on the
  Mac MoshOps command envelope for actual DAW changes.
- Because no Mac protocol fields changed, no Mac protocol migration was
  required. The Mac regression battery was still run to prove the branch did
  not disturb MoshOps behavior.

## Required Local Closing Commands

Simulator:

```sh
xcodebuild test -project ios/MoshCompanion/MoshCompanion.xcodeproj \
  -scheme MoshCompanion -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  CODE_SIGNING_ALLOWED=NO
```

Mac companion server smoke:

```sh
MOSH_NO_AUDIO=1 MOSH_LAB_FEED=1 MOSH_LAB_TOKEN=<local-token> \
  build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh
```

Then smoke `/health`, authenticated `/snapshot`, and an authenticated
`/command` request using the nested MoshOps envelope:

```json
{"command":{"command":"set_transport","args":{"action":"stop"}}}
```

Command requests must continue to route through Mac MoshOps.

## Optional Hardware Commands

After unlocking the connected iPhone and leaving it awake:

```sh
cd /Users/emiliosanchez-harris/Documents/ClaudeMosh-ios
scripts/iphone-companion-device-gate.sh
```

Expected physical pass signal:

```text
Mosh Companion installed and launched on 00008110-001E4D920181401E.
```

Then do the real phone workflow pass:

1. Start the Mac app with the companion server enabled.
2. Start pairing in Mosh and scan/open the pairing URL on the iPhone.
3. Verify the phone reaches the online session screen.
4. Start and finish a short phone take.
5. Verify the Mac receipt/import result and undo posture from Mosh.

## Pause Alignment

This branch is ready to pause or merge after the local verification battery is
green. The intended merge unit is the whole companion hardening slice:

- iOS offline/session state hardening.
- Offline command suppression and receipt feedback.
- Forget Pairing recovery.
- Simulator tests for stale-pairing recovery and pairing reset.
- Physical-device gate hardening for temp DerivedData, wireless CoreDevice,
  trust, and lock-state failures.
- Documentation for simulator-first local acceptance and wireless-device
  troubleshooting.

Keep the following as explicit follow-up work rather than hidden merge
requirements:

- Manual microphone take UX through the physical phone.
- Manual hold-to-talk Speech UX on the physical phone.
- Manual acoustic monitoring spike from physical speaker/mic conditions.
- Optional iPhone Mirroring tap-through exploration; current automation can
  display the mirrored app but did not forward local clicks into the phone UI.

Do not merge any future companion protocol changes unless they retain the Mac
MoshOps mutation seam and add Mac regression coverage for changed endpoints.
