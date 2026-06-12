# Mosh DAW Hardening Report - 2026-06-11

## Repo Truth

- Seat: `/Users/emiliosanchez-harris/Documents/ClaudeMosh`
- Branch: `main`
- Starting HEAD: `781adb068f361c8924b1407a41a4648f513cff96`
- Host: macOS Apple Silicon arm64
- Off-limits worktrees were not touched:
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh-lab`
  - `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/laughing-grothendieck-22549c`
- Hosted GitHub Actions were not changed or re-enabled.

## Baseline And Final Battery

The first baseline exposed a real harness/runtime problem: `--selftest` reused a persistent `session-selftest` directory with a 113 MB `mosh-log.jsonl`, and `get_command_log` loaded and parsed the full file. The run was still inside `cmdGetCommandLog` when it was terminated after 332.871s. Because `--selftest-undo` reused the same session directory, it also erased the default selftest log before the command-log validator ran in the requested command order.

| Step | Baseline result | Final result | Artifact |
| --- | --- | --- | --- |
| `cmake --build build` | PASS, 0.258s | PASS, 0.298s | `_preserved_artifacts/2026-06-12-hardening/hardening-final-battery-20260611-175020` |
| `MOSH_NO_AUDIO=1 "$APP" --selftest` | terminated at 332.871s | PASS, 28.049s, `650/650` | `_preserved_artifacts/2026-06-12-hardening/hardening-final-battery-20260611-175020/selftest.log` |
| `MOSH_NO_AUDIO=1 "$APP" --selftest-undo` | PASS, 0.601s | PASS, 0.576s, `18/18` | `_preserved_artifacts/2026-06-12-hardening/hardening-final-battery-20260611-175020/selftest-undo.log` |
| `ctest --test-dir build --output-on-failure` | PASS, 0.700s | PASS, 0.133s | `_preserved_artifacts/2026-06-12-hardening/hardening-final-battery-20260611-175020/ctest.log` |
| `scripts/validate-command-log-contract.sh` | FAIL after stale/malformed log state | PASS, 0.078s | `_preserved_artifacts/2026-06-12-hardening/hardening-final-battery-20260611-175020/command-log.log` |

Selftest profiling is now emitted in the ordinary selftest log. The slowest final sections were:

| Section | Time | Checks |
| --- | ---: | ---: |
| `Wave: command-log inspector (AGT-001)` | 7.633s | 16 |
| `Wave A: project format (PRJ-008) / device prefs (PRE-001) / record latency (ARE-003)` | 4.541s | 33 |
| `Export format / depth options (IOX-002, IOX-007)` | 4.080s | 10 |
| `Serum render compatibility (optional local plugin gate)` | 3.014s | 9 |
| `Stage 6: full producer loop + export` | 2.607s | 8 |
| `Stage 5: generative layer (FakeAdapter, full loop)` | 1.136s | 12 |

## Gate Audit

| Gate | What it proves | Duplicates / misses | Speed tier | Command | Pass signal | Artifact |
| --- | --- | --- | --- | --- | --- | --- |
| Selftest | MoshOps command semantics, snapshots, events, undoable command posture, save/reload, plugin command surface, MIDI, tempo, warp, export, routing | Duplicates portions of strict-local-v0 and plugin-host; misses rendered native gestures and hardware loopback | Fast local merge gate, about 28s final | `MOSH_NO_AUDIO=1 "$APP" --selftest` | `650/650 checks passed, 0 failed` | `_preserved_artifacts/2026-06-12-hardening/hardening-final-battery-20260611-175020/selftest.log` |
| Focused undo | Tracktion undo grouping and redo contracts for focused edits | Duplicates selftest undo checks at a smaller risk layer; misses native UI gestures | Fast, under 1s | `MOSH_NO_AUDIO=1 "$APP" --selftest-undo` | `18/18 focused undo checks passed, 0 failed` | `_preserved_artifacts/2026-06-12-hardening/hardening-final-battery-20260611-175020/selftest-undo.log` |
| CTest | Native unit/integration target still builds and passes under CMake | Duplicates build health; misses packaged app workflows | Fast, under 1s | `ctest --test-dir build --output-on-failure` | exit 0 | `_preserved_artifacts/2026-06-12-hardening/hardening-final-battery-20260611-175020/ctest.log` |
| Command-log contract | JSONL records remain parseable and expose required command envelope fields | Duplicates the selftest AGT surface; misses complete history if called with a small window | Fast, under 1s | `scripts/validate-command-log-contract.sh` | checked recent command-shaped records with no schema errors | `_preserved_artifacts/2026-06-12-hardening/hardening-final-battery-20260611-175020/command-log.log` |
| Strict local v0 | UI build, Mosh/MoshTests build, CTest, default/undo/SA3 selftests, plugin-host strict assertions, command-log, preservation manifest, SA3 colors | Duplicates core merge battery; misses BlackHole loopback and rendered macOS UI gestures | Full local strict gate, about 86s in this run | `MOSH_EVID=... scripts/strict-local-v0-gate.sh` | `Result: PASS` | `_preserved_artifacts/2026-06-12-hardening/gate-evidence-20260611-173659/strict-local-v0/REPORT.md` |
| Plugin-host evidence | Full selftest under plugin-host evidence capture; external plugin surface is represented when local plugins exist | Duplicates selftest; misses rendered plugin editor windows unless paired with UI automation | Medium, about 23s | `scripts/plugin-host-evidence-gate.sh` | `PASS command-surface selftest reported 650/650, failed=0` | `_preserved_artifacts/2026-06-08-consolidation/claudemosh/plugin-host-evidence-20260611-175107/REPORT.md` |
| macOS local preflight | Machine prerequisites: arm64 host, Python UI deps, Accessibility, screen capture, BlackHole visibility, ffmpeg, service health, plugin directory, preservation state | Duplicates environment portions of UI/BlackHole gates; misses actual rendered behavior | Fast environment gate | `scripts/macos-local-preflight.sh` | `Result: PASS` | `_preserved_artifacts/2026-06-12-hardening/gate-evidence-20260611-173659/macos-local-preflight-pythonfix/REPORT.md` |
| macOS UI automation | Real `Mosh.app` rendered workflow: transport play/stop, theme toggle, zoom, Split/Move modes, arrangement clip drag, render Accept/Reject through JSONL, Serum 2 native editor and tab visual diff | Does not yet cover piano-roll lasso/draw/velocity lane or device settings dialogs | Medium, 47.95s | `scripts/macos-ui-automation-gate.py` | `Result: PASS` with screenshots and JSON result | `_preserved_artifacts/2026-06-12-hardening/gate-evidence-20260611-173659/macos-ui-automation-v3/REPORT.md` |
| BlackHole live audio | CoreAudio HAL loopback path contains non-silent captured audio, not just app-side output callbacks | Duplicates preflight BlackHole visibility; still misses real studio routing until capture is non-silent | Hardware-gated, about 3 capture attempts | `scripts/blackhole-live-audio-gate.sh` | FAIL: app callbacks ran, BlackHole input capture stayed silent-ish | `_preserved_artifacts/2026-06-12-hardening/gate-evidence-20260611-173659/blackhole-live-audio/REPORT.md` |
| iOS companion simulator | Companion client parsing, snapshot decoding, accept/reject command routing, voice guardrails, monitoring metrics on iOS Simulator | Duplicates shell `xcodebuild` and XcodeBuildMCP `test_sim`; misses physical device pairing/audio | Medium, about 38-50s | `xcodebuild test ...` and XcodeBuildMCP `test_sim` | 5 tests, 0 failures | shell: `_preserved_artifacts/2026-06-12-hardening/gate-evidence-20260611-173659/ios-companion-simulator-test/xcodebuild-test.log`; MCP: `/Users/emiliosanchez-harris/Library/Developer/XcodeBuildMCP/workspaces/ClaudeMosh-61190dceaa86/logs/test_sim_2026-06-12T00-47-14-291Z_pid6191_1a100b38.log` |

## Changes Made

- `MoshEngine` now deletes isolated headless session directories before a fresh harness run, making selftests cold and idempotent instead of dependent on stale app-support logs.
- Headless app modes now use distinct session directories: `session-selftest`, `session-selftest-undo`, and `session-live-audio-smoke`, so one gate does not erase another gate's evidence.
- `get_command_log` now streams `mosh-log.jsonl`, counts command-shaped records, keeps only the requested tail window, and reports additive `limit` and `logBytes` metadata.
- The command-log validator now checks a 500-record window by default and reports non-object JSON values cleanly.
- The selftest harness now emits per-section timings and prefixes failures with the active section name, while preserving the existing summary format.
- The plugin-host evidence gate now accepts the current selftest count dynamically (`>=650`) instead of hard-coded stale counts.
- The macOS preflight and UI automation scripts now choose a Python that can import PIL/Quartz, instead of depending on the caller's PATH.
- The macOS UI automation gate now uses current AX selectors and proves rendered arrangement/plugin workflows with screenshots plus JSONL command evidence.

## Highest-Risk Surface Coverage

- Piano roll: engine-level MIDI note editing remains covered in selftest; rendered lasso/draw/velocity-lane gestures are still a UI automation gap.
- Arrangement: engine move/trim/split and undo coverage remains in selftest; rendered Split/Move mode, zoom, and clip drag are now proved against real `Mosh.app`.
- Engine/session: save/reload, project lifecycle, render job draining, export options, stems, tempo ramps, and warp clips are covered in selftest and strict-local-v0.
- Plugin hosting: command-surface plugin evidence and strict assertion scan pass; Serum 2 native editor open and OSC/MATRIX tab visual diff pass in real UI automation.
- Hardware-gated: BlackHole is installed and visible, but the loopback capture gate is still red because captured input remains below non-silent thresholds.

## Remaining Risks And Closing Commands

1. BlackHole loopback routing is the only red audited gate. Close it with:
   `MOSH_EVID=/Users/emiliosanchez-harris/Documents/ClaudeMosh/_preserved_artifacts/2026-06-12-hardening/gate-evidence-$(date +%Y%m%d-%H%M%S)/blackhole-live-audio scripts/blackhole-live-audio-gate.sh`

2. Physical iPhone install/launch is now green. Remaining phone-side manual QA
   is the real mic workflow: start Mac pairing, scan the QR/deep link, record
   two 5-second takes, and verify JSONL/undo/save/reload.

3. Piano-roll native gestures still need a rendered gate for lasso vs draw, note-edge resize, velocity lane, quantize/humanize/swing, fold/scale, and undo grouping. The right next artifact is a new UI automation slice that saves screenshots and command-log markers under `_preserved_artifacts/2026-06-12-hardening/`.

4. Device settings dialogs and CoreAudio device switching should stay hardware/manual until automation can assert the exact selected device and non-silent capture. Re-run preflight first:
   `MOSH_EVID=/Users/emiliosanchez-harris/Documents/ClaudeMosh/_preserved_artifacts/2026-06-12-hardening/gate-evidence-$(date +%Y%m%d-%H%M%S)/macos-local-preflight scripts/macos-local-preflight.sh`

## Human QA Script For The Current UI Slice

Automation already proved the rendered arrangement/plugin workflow, so human QA is only useful for qualitative feel and hardware routing:

1. Open `build/Mosh_artefacts/Debug/Mosh.app`.
2. In a demo arrangement, switch between Move and Split, drag a visible clip, zoom in/out, then undo/redo quickly.
3. Render a selected track, click Accept, then Reject; verify the visible state matches the command intent.
4. Open Serum 2 from the plugin surface and switch OSC to MATRIX; confirm the native editor remains responsive.
5. If BlackHole is routed as system output/input, run the BlackHole gate above and keep the `REPORT.md`, `analysis.json`, and capture WAV if it still fails.

## Independent Verification Addendum (Claude, 2026-06-11)

Every claim above was re-verified independently on commit `1ebe1f4`:

- Battery re-run from scratch: build PASS · selftest **650/650 in 26s, 0 JUCE
  assertions** · undo 18/18 · CTest PASS · command-log contract PASS.
- Code review of the diff: the session-dir isolation, streaming
  `get_command_log` (bounded tail window, additive `limit`/`logBytes`
  metadata), per-section selftest timings, and gate-script changes are all
  sound; no contract regressions found.
- Evidence spot-checks: strict-local-v0 REPORT (PASS, 10 checks), UI
  automation REPORT (PASS with AX assertions + image diffs; Serum native
  editor screenshots verified by eye), iOS simulator log ("All tests"
  passed), XcodeBuildMCP log present.

### BlackHole red gate — ROOT-CAUSED: environment, not Mosh

An independent control experiment (AVAudioEngine writer pinned to the
BlackHole device id, 440 Hz at 0.5 amplitude — no Mosh involvement) also
captured silence from BlackHole's input, and an acoustic-bleed test proved
the AVFoundation capture index really is BlackHole. Conclusion: **the
BlackHole driver's loopback is inoperative system-wide** (macOS 26.4.1,
BlackHole 0.6.1) — no application can pass this gate until the environment
is repaired (`sudo killall coreaudiod`, then `brew reinstall blackhole-2ch`
if still silent).

The gate now performs this control probe itself
(`scripts/blackhole-control-probe.swift`) and exits **3 = ENV-BLOCKED** with
remediation text when the driver is at fault, so an environment failure can
never again read as an application failure.

## Physical iPhone Gate Addendum (Codex, 2026-06-11)

After Xcode account setup, the physical iPhone path advanced past the earlier
signing blocker:

- `devicectl` sees Emilio's iPhone (`00008110-001E4D920181401E`) as paired,
  booted, Developer Mode enabled, and capable of install/launch.
- Xcode created a valid Apple Development identity for the Personal Team.
- The correct team id is the certificate `OU` field: `ZYT77F9B27`.
- `scripts/iphone-companion-device-gate.sh` now auto-detects that team id,
  clears local Finder/file-provider xattrs that can poison device codesign,
  builds for `iphoneos`, signs with the Personal Team profile, and installs
  `studio.mosh.companion` on the phone.
- After the profile was trusted on the phone, the gate passed end to end:
  build, install, and launch on `00008110-001E4D920181401E`.

Current pass command:

```sh
scripts/iphone-companion-device-gate.sh
```

Pass signal: `Mosh Companion installed and launched on
00008110-001E4D920181401E.` Timing from the rerun was 10.12s.

## iPhone Companion Take-Path Addendum (Codex, 2026-06-11)

The physical gate proved signing/install/launch, and a local HTTP continuation
found a real Mac-side take-upload bug before asking Emilio for manual mic QA:

- `/take/chunk` rejected Swift/Python-standard padded Base64 PCM strings
  before they reached `RemotePhoneTakeStore`.
- Root cause: `RemoteCompanionServer` used
  `juce::MemoryBlock::fromBase64Encoding`, while the iOS app sends
  `Data.base64EncodedString()` and existing Mosh import code already uses
  `juce::Base64::convertFromBase64`.
- Fix: decode `/take/chunk` with `juce::Base64::convertFromBase64`, then pass
  the decoded bytes into the existing sequenced PCM append path.
- Regression:
  `remote companion server accepts standard Base64 phone take chunks` in
  `tests/test_remote_companion.cpp`. It starts a take, uploads a padded
  standard Base64 chunk, finishes the take, and verifies the generated WAV is
  routed through `import_clip`.
- Focused proof:
  `build/tests/MoshTests_artefacts/Debug/MoshTests "[remote][takes]"` passed
  22 assertions in 2 test cases.
- Live app proof: launched rebuilt `Mosh.app` with
  `MOSH_NO_AUDIO=1 MOSH_LAB_FEED=1 MOSH_LAB_TOKEN=codex-device-gate`, posted
  three frame-aligned standard Base64 chunks to `/take/chunk`, finished the
  take, and verified `import_clip` plus undo/redo by snapshot counts:
  clips `3 -> 4 -> 3 -> 4`.
- Evidence:
  `_preserved_artifacts/2026-06-12-claude-verify/iphone-companion-e2e/summary.json`
  plus request/response snapshots in the same directory.

Current local gate rerun after the fix:

| Gate | Result |
| --- | --- |
| `cmake --build build` | PASS, 0.24s |
| `MOSH_NO_AUDIO=1 "$APP" --selftest` | PASS, 26.20s, `650/650` |
| `MOSH_NO_AUDIO=1 "$APP" --selftest-undo` | PASS, 0.50s, `18/18` |
| `ctest --test-dir build --output-on-failure` | PASS, 0.08s |
| `scripts/validate-command-log-contract.sh` | PASS, 0.04s, 286 records |
| `scripts/strict-local-v0-gate.sh` | PASS, 139.54s |
| XcodeBuildMCP `test_sim` | PASS, 5/5, 27.744s |
| `scripts/iphone-companion-device-gate.sh` | PASS, 10.12s |

XcodeBuildMCP simulator artifacts:

- Build log:
  `/Users/emiliosanchez-harris/Library/Developer/XcodeBuildMCP/workspaces/ClaudeMosh-61190dceaa86/logs/test_sim_2026-06-12T04-15-44-130Z_pid81375_902c08d1.log`
- Result bundle:
  `/Users/emiliosanchez-harris/Library/Developer/XcodeBuildMCP/workspaces/ClaudeMosh-61190dceaa86/result-bundles/test_sim_2026-06-12T04-15-44-130Z_pid81375_6e84ae8f.xcresult`

Residual manual/hardware risk: the actual iPhone microphone recording gesture
still needs Emilio's hand because automation can build, install, launch, deep
link, and exercise the Mac HTTP endpoint, but it cannot decide whether the
physical phone mic capture workflow feels correct.

Separate UI-startup observation: lab-feed `--demo5` launches still print
repeated `juce_WebBrowserComponent.cpp:170` assertions while the WebView waits
for `window.__JUCE__.backend`. This did not affect the phone-take endpoint fix
and did not appear in the headless selftest assertion surface, but it should be
closed as its own rendered UI startup hardening slice.
