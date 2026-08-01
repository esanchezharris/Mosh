# Production-v2 End-to-End Usability Audit

Status: **IN PROGRESS — not release-certified**

Campaign tracker: [#516](https://github.com/zeke431/Mosh/issues/516)

Pinned trunk: `609bde7d12aca6155bf77dbf1d9aec2093925def`
Audit ID: `production-v2-20260730`

This is the durable, reader-safe ledger. Raw screenshots, logs, app copies, and
audio stay outside the repository under `~/Library/Mosh/audits/production-v2-20260730/`.
Paths in this document are audit-relative so that owner names and unrelated
session data are not published.

## Campaign rules

- Production v2 only. Classic, dev labs, iPhone UI, physical MIDI, live camera,
  and two-Mac behavior are excluded.
- The installed application is tested before the pinned `origin/main` Release.
- The owner checkout and owner session are not mutated.
- Fresh black-box Computer Use evidence is frozen before source or JSONL
  diagnostics.
- Every user-visible root cause gets its own issue. Fixes are serial, one PR at
  a time, and the owner merges.
- A row is not `PASS` merely because a control exists. The expected visible
  result and, for mutations, the matching JSONL command must both be observed.

## Frozen baselines

### Installed application

| Property | Frozen value |
|---|---|
| Source | `/Applications/Mosh.app` |
| Bundle timestamp | `2026-07-25T09:37:48-0700` |
| Bundle ID | `studio.mosh.app` |
| Architecture | arm64 |
| Binary SHA-256 | `2bdbe2d4955fbe1c177d578d0aa9e5637775160ec3281405698238e2fda998af` |
| UI SHA-256 | `20d61337584c9dbf73ad2a15f0ccb11dc46e93f95f5d6be213e27c34c6e60055` |
| Info.plist SHA-256 | `e2f55b6136c1e7ba7aaba7160dae307b742f2d7976598f8010b6228b9b471c7c` |
| Signing | ad-hoc; sealed resources; strict verification passed |
| Frozen copy | `installed-cold/Mosh.app` |
| Metadata artifact | `installed-cold/metadata.txt` (`66ab4eff03fe38d13b886b7c127b79ffc42d072dfba61c7fbed545bb5a78367b`) |

The first cold run is retained as a harness incident: duplicate
`studio.mosh.app` bundles made target identity ambiguous. Its findings are not
product evidence. The corrected run used a copy with unique bundle ID
`studio.mosh.audit.installed.20260730`, ad-hoc re-signed after the frozen hashes
were recorded. The unique runtime copy is a harness derivative, not the frozen
artifact.

The owner application remained open and was not used after the targeting
incident. A defensive copy of its project edit is stored at
`owner-session-recovery/session.tracktionedit`
(`9eabfdcf207d94395706de90ccf74fbc4cec36f7f3b8f9b82f5a0750bdddb13c`).

### Pinned `origin/main` Release

| Property | Frozen value |
|---|---|
| Source SHA | `609bde7d12aca6155bf77dbf1d9aec2093925def` |
| Build preset | `macos-arm64-release-app` |
| Binary timestamp | `2026-07-30T15:57:32-0700` |
| Binary SHA-256 | `369f657eed285884ab825b7d3b931641973eadc9f4ce25c989580e17da43df2d` |
| UI SHA-256 | `3018eae0158a23582221a629126254721f4ee9de609fa145c1f70cec08d4e698` |
| Signing | linker ad-hoc, no team identifier |
| Strict verification | FAIL: sealed-resource/signature mismatch |
| Frozen copy | `origin-main-release/Mosh.app` |
| Metadata artifact | `origin-main-release/metadata.md` (`6bf3193923e31f9311f707a85f0235eed2304752dfb5644a8eb5202c381b542f`) |

The first raw parallel build hit the known fresh-`node_modules` race. Running
the dependency preinstall already encoded in `scripts/auto-loop/gate.sh`
(`npm ci --no-audit --no-fund`) made the identical Release build pass. This is
an invocation/setup artifact, not a product regression.

### Isolation

| Artifact | Session leaf | Port |
|---|---|---:|
| Corrected installed cold run | `_audits/production-v2-20260730-installed-valid` | 8872 |
| Timeline fixed Release v2 | `_audits/production-v2-20260730-timeline-fix-v2` | 8874 |

Each run has its own project directory, command log, stdout, and stderr. Apps
were launched by LaunchServices with the environment attached to the new
process. Direct binary launch was rejected because it exited before presenting
the production surface.

## Configured inventory at freeze

No credential values were read or recorded.

- Credential/config keys present for OpenAI, Anthropic, Gemini, xAI,
  OpenRouter, DeepSeek, and Moonshot; model and sample-library selectors are
  also present.
- CoreAudio devices: built-in microphone, built-in speakers, BlackHole 2ch,
  and an owner-labelled Continuity microphone. The Continuity device is
  excluded from this campaign.
- Safe plugin candidates are selected from the installed AU/VST3 inventory:
  Apple/built-in effects plus bounded, license-safe candidates such as
  TAL-Chorus-LX and ValhallaSupermassive. The audit does not launch every
  third-party plugin, shell, licensed processor, or instrument.

Configured means present, not yet proven working. Backend and plugin success
remain acceptance gates below.

## Corrected black-box baseline

Black-box artifact:
`installed-cold-valid/BLACK_BOX_REPORT.md`
(`cd8b7037cdff2aa4a5ff6ea42a0ba6ae1af4aac5eeb44cb8cf140868f1c146c7`)
Machine inventory:
`installed-cold-valid/inventory.json`
(`db1d5a7c857ff02822c2346a2488d541adfd6ad06c3dae1a40e5cc48e1bdb3a0`)

The auditor had only the creative brief, Computer Use, screenshots, and the AX
tree. It did not inspect source, logs, or hidden commands.

| ID | Control/state | Precondition | Gesture | Expected result | Observed result | Artifact | Severity | Issue | Fix PR | Retest |
|---|---|---|---|---|---|---|---|---|---|---|
| S01 | First production-v2 surface | Unique installed bundle; isolated blank session | Launch and inspect | Correct app identity; blank usable project | Correct bundle, `session`, and zero tracks | `installed-cold-valid/baseline.png` | NOTE | — | — | PASS |
| S02 | macOS menus | Main window | Click File, Edit, Transport | Menus open and expose labelled actions | Menus opened; entries visible in AX | `installed-cold-valid/baseline.png` | NOTE | — | — | PASS |
| S03 | Save/export dialogs | Main window | File > Save As; File > Export Audio; Cancel | Native dialogs open and cancel without mutation | Both dialogs opened and cancelled | `save-as-dialog.png`, `export-dialog.png` | NOTE | — | — | PASS surface only |
| S04 | Track creation | Blank project | Add track > instrument | Track and MIDI clip appear | Track and clip appeared | `add-track-menu.png`, `piano-roll.png` | NOTE | — | — | PASS |
| S05 | Piano roll/drum editor | Selected MIDI clip | Open editor; switch drums; Escape | Editors open, change mode, dismiss | Both modes visible; Escape dismissed | `piano-roll.png`, `drum-editor.png` | NOTE | — | — | PASS surface only |
| S06 | Generative surface | Selected track | Open Gen; enter prompt; Compile/Re-imagine | Visible busy state and supported backend result | Busy then READY was visible; audio/backend integrity not yet checked | `generative-ready.png` | MAJOR | pending diagnostic | — | PARTIAL |
| S07 | Lyrics surface | Selected track | Write Lyrics; suggest; analyze; dismiss | Suggestion and analysis flows remain editable | Flows were reachable; model identity/output integrity not yet checked | `lyrics-suggestion.png`, `lyrics-flow.png` | MAJOR | pending diagnostic | — | PARTIAL |
| S08 | FX and clip tabs | Selected clip | Open FX/Clip; toggle clip mute | Correct panels and visible state change | Panels and mute control were reachable | `fx-inspector.png` | NOTE | — | — | PASS surface only |
| S09 | Browser/search | Main window | Open Browser; search sample/plugin | Results surface accepts search | Browser and plugin search reached | `plugin-browser.png` | NOTE | — | — | PASS surface only |
| S10 | Master plugin picker AX | Main window | Open + Plugin; inspect AX | Every visible row has an accessible control | Reported visual/AX mismatch; screenshot does not independently prove the picker rows | `plugin-browser.png` | MAJOR | pending informed reproduction | — | BLOCKED |
| S11 | Whole-song navigator | One track | Coordinate drag `(300,128)` to `(900,128)` | Playhead updates throughout held drag and commits endpoint | Readout moved, but isolated JSONL later showed one command for the entire drag | `before-navigator-drag.png`, `after-navigator-drag.png` | MAJOR | [#517](https://github.com/zeke431/Mosh/issues/517) | pending | FAIL |
| S12 | Detailed bar ruler | One track | Coordinate drag `(300,170)` to `(900,170)` | Playhead updates throughout held drag and commits endpoint | Readout moved, but isolated JSONL later showed one command for the entire drag | `before-ruler-drag.png`, `after-ruler-drag.png` | MAJOR | [#517](https://github.com/zeke431/Mosh/issues/517) | pending | FAIL |
| S13 | Transport rapid action | One track | Play, Stop, metronome, count-in, rapid Play | Stable labelled state with no hang | Stable in observed surface | `rapid-transport.png` | NOTE | — | — | PASS observed actions |
| S14 | Collaboration launcher | Main window | Open then dismiss create/join | Modal opens without permission prompt | Modal opened and closed | `collaboration-launcher.png` | NOTE | — | — | PASS surface only |
| S15 | Moshi prompt | Main window | Enter a benign request; send | Visible progress/result and undo posture | Response surfaced; mutation, clarification, cancel, and undo remain untested | `moshi-response.png` | MAJOR | pending journey | — | PARTIAL |
| A01 | Empty state | Blank project | Inspect and add track | Useful, actionable empty state | Actionable empty state | `baseline.png` | NOTE | — | — | PASS |
| A02 | Disabled state | Missing required input | Inspect disabled actions; supply input | Disabled reason clears at precondition | Observed in lyric flow | `lyrics-editor.png` | NOTE | — | — | PASS sampled |
| A03 | Busy/error | Generative action | Start and wait | Busy terminates; errors explain recovery | Busy reached READY; error state not forced | `generative-ready.png` | MAJOR | pending error-state pass | — | PARTIAL |
| A04 | Cancellation | Native dialogs/overlays | Open; Escape/Cancel | Dismiss without stray mutation | Observed for sampled dialogs/overlays | `save-as-dialog.png`, `export-dialog.png` | NOTE | — | — | PASS sampled |
| A05 | Rapid action | Transport | Double Play | No crash/hang/false state | Stable | `rapid-transport.png` | NOTE | — | — | PASS |
| A06 | Narrow window/themes | Main window | Resize; toggle both themes | Controls remain reachable and readable | Theme control found; safe resize was not reached by the black-box tool | `baseline.png` | MINOR | pending controlled pass | — | BLOCKED |
| A07 | Keyboard/Escape | Editors/overlays | Escape | Dismiss current transient surface | Observed in sampled editors | `piano-roll.png`, `lyrics-suggestion.png` | NOTE | — | — | PASS sampled |
| A08 | Focus/tooltips | Main window | Keyboard focus and hover/AX inspection | Meaningful names/help/focus | Sampled controls exposed names/help | `baseline.png`, `save-as-dialog.png` | MINOR | pending exhaustive pass | — | PARTIAL |
| A09 | Undo/redo | Edit menu | Inspect entries | Undo/redo are reachable | Entries exposed; behavior not yet exercised | `more-tools.png` | MAJOR | pending journey | — | PARTIAL |
| A10 | Shift-drag range | Detailed ruler | Shift-held drag | Range appears; no transport scrub | Black-box tool could not hold a modifier; informed native pass below succeeds | `shift-drag-attempt.png` | NOTE | — | — | PASS informed |
| A11 | Audio track selection | MIDI clip selected; audio track present | Select audio track header | Track selection and inspector target are unambiguous | Audio track showed selected while MIDI clip inspector remained visible | `audio-selection-mismatch.png` | MAJOR | [#518](https://github.com/zeke431/Mosh/issues/518) | — | FAIL |
| A12 | Degraded-audio Settings recovery | Exact Release candidate; MacBook Pro Speakers + BlackHole 2ch pairing | Launch through the bounded timeout; click Retry; open File/options > Settings | Degraded mode remains responsive and Settings explains the unavailable device | Baseline `379bd6a1` blocked in Settings; the approved repair merged at `e520550b`. A final merged-Release device rerun is paused because audit launches still share the owner's global audio preferences (#557). | Issue #527 exact-head audit manifest, screenshots, redacted Retry JSONL | BLOCKER | [#527](https://github.com/zeke431/Mosh/issues/527) | [#528](https://github.com/zeke431/Mosh/pull/528) | PASS pre-merge; exact merged-Release rerun blocked by #557 |

Correction to the source-free report: direct comparison of
`before-ruler-drag.png` and `after-ruler-drag.png` shows that the MIDI clip
remained anchored at bar 1. “The clip moved” was a visual false positive and is
not a finding.

## Finding ledger

| Finding | Severity | Root cause/disposition | Issue | Fix PR | Native retest |
|---|---|---|---|---|---|
| Timeline navigator and ruler emit only one seek for a held Computer Use drag | MAJOR | Pointer-owned continuous scrub fix merged at `364cb6fe`; click and Shift-range behavior preserved | [#517](https://github.com/zeke431/Mosh/issues/517) | [#519](https://github.com/zeke431/Mosh/pull/519) | PASS on exact merged Release |
| Audio-track selection leaves the MIDI clip inspector visible | MAJOR | Canonical clip selection now clears before the multiplayer-aware track transition; merged at `f3e68992` | [#518](https://github.com/zeke431/Mosh/issues/518) | [#520](https://github.com/zeke431/Mosh/pull/520) | PASS on exact merged Release |
| Packaged Moshi substitutes demo commands after a brain-provider failure | MAJOR | Both single-shot and agentic-loop callers now fail visibly without commands; browser mocks use an explicit `e2e` mode and isolated `dist-e2e`, legacy/ambient development builds abort, and a real native WebView disables demo brains. The complete exact-head evidence successor merged at `6c3687db`. | [#521](https://github.com/zeke431/Mosh/issues/521) | [#522](https://github.com/zeke431/Mosh/pull/522) | PASS on exact merged Release |
| Agentic terminal task drawer is exposed to accessibility before its pixels become visible | MAJOR | The entrance animation started at `opacity: 0`; the fix keeps the drawer opaque from mount while retaining its 6 px motion. The complete exact-head evidence successor merged at `379bd6a1`. | [#525](https://github.com/zeke431/Mosh/issues/525) | [#526](https://github.com/zeke431/Mosh/pull/526) | PASS on exact merged Release |
| Settings hangs after a bounded audio-startup timeout | BLOCKER | The old in-process timeout abandoned a thread inside CoreAudio, leaving process-local HAL state poisoned; Settings then synchronously re-entered device scanning. The approved repair moved the saved/default setup preflight into a killable child, suppressed degraded enumeration, rejected DTD/entity declarations before parsing setup XML, and merged at `e520550b`. | [#527](https://github.com/zeke431/Mosh/issues/527) | [#528](https://github.com/zeke431/Mosh/pull/528) | PASS pre-merge; final merged-Release device rerun blocked by #557 |
| Failed audio Retry duplicates the persistent degraded-audio warning | MINOR | Retry is bounded and truthful, but its failure notification repeats the existing banner and remains visible; separate presentation/accessibility root cause parked behind #528 | [#529](https://github.com/zeke431/Mosh/issues/529) | pending | FAIL candidate; does not block #527 |
| Primary Stop exits recording without surfacing the take | BLOCKER | The v2 Stop and To-start controls used generic transport stop instead of the take-aware `stop_recording` lifecycle. The candidate routes recording stops through the existing MoshOps seam, serializes rapid transport actions, and preserves non-recording behavior. Prior native proof lands, saves, and reloads a non-silent take; a fresh exact-head device rerun is blocked by #557. | [#531](https://github.com/zeke431/Mosh/issues/531) | pending | Candidate under exact-SHA gate/review |
| Recorded take can persist with its source offset at EOF | BLOCKER | Dedicated lifecycle proof exposed a distinct placement defect: a non-zero timeline recording can reference the end of its source and render silent. This is not fixed by #531. | [#545](https://github.com/zeke431/Mosh/issues/545) | pending | FAIL frozen reproduction |
| Audit sessions rewrite global audio preferences despite `MOSH_SELFTEST_SESSION` | BLOCKER | Project/session artifacts isolate correctly, but native audit launches still rewrite the shared `Settings.xml`. Further device/UI runs are paused rather than risking the open owner session; normal installed-app defaults must remain unchanged while audit settings gain an isolated root. | [#557](https://github.com/zeke431/Mosh/issues/557) | pending | FAIL exact reproduction |
| Master plugin picker may omit visible rows from AX | MAJOR | Black-box evidence is inconclusive; reproduce with exact visual and AX snapshots | pending | — | pending |
| Narrow-window coverage unavailable through the black-box adapter | MINOR | Harness limitation, not yet a product defect | — | — | pending |
| Canonical raw Release fails strict codesign verification | NOTE | Packaging evidence; not yet classified as distribution defect | pending packaging disposition | — | pending |

## Current serial-fix boundary

PRs #519, #520, #522, #526, and #528 are merged. The canonical campaign
baseline is merge SHA `e520550b597163d51122e0cff1de42b11f58ec56`.
Owner-only draft PR #523 remains deliberately open and unmerged.

The broader-showcase run exposed three independent recording/audit blockers.
Issue #531 owns the visible Stop/To-start lifecycle and rapid-action routing;
issue #545 owns invalid recorded-source placement; issue #557 owns audit
settings isolation. They must not be collapsed into one fix or one proof.
Issue #531 has preserved native proof for Record -> Stop -> visible take ->
save/reopen plus exact UI/gate evidence, but any new commit requires a new
five-lane exact-SHA review. Further device launches are paused until #557 makes
them safe for the still-open owner session.

The showcase, configured-backend pass, same-Mac collaboration run, export
matrix, stem validation, and final merged-SHA inventory rerun remain open.

## Audio timeout recovery evidence

Exact merged baseline: `379bd6a1f6a653317bce98115f2fb686ad7444b0`

The baseline Release showed the actionable degraded-audio banner after the
MacBook Pro Speakers + BlackHole 2ch probe timed out. Opening Settings then
blocked the message thread in
`cmdListAudioDevices -> scanForDevices -> AudioObjectGetPropertyData`, while
the original probe thread remained blocked in `AudioDeviceStart`.

- Baseline screenshot:
  `merged-379bd6a1/audio-device-failure-before-settings.jpg`
  (`9b92f2db12d21bd2daac3679f1a9763aa6842b7769a68d5cc8d8e8ece0fd16c6`)
- Baseline sample:
  `merged-379bd6a1/showcase-settings-hang.sample.txt`
  (`f04a072d05fdf0f1d7a5f39f4974e2bd328ef50657fb78aa46a109f916cc1dc0`)

PR #528 launches the same executable with an exact `--audio-probe` mode token,
passes the complete saved `DEVICESETUP` XML as one bounded, non-empty encoded
argument (or the literal default setup), and accepts exactly one nonce-bound
JSON result.
Timeout returns only after the helper is killed and reaped. A successful
preflight is followed by one Tracktion initialization of the same XML setup;
probe refusal degrades instead of attempting a different fallback device. In
degraded mode the real `list_audio_devices` command returns an empty inventory
without entering the HAL. Retry reuses the same boundary.

The immutable candidates `6a0e5afc`, `0254ab10`, and `a20c5651` and their
gates remain archived as predecessor evidence. `6a0e5afc` proved the real
Speakers + BlackHole timeout could open Settings but did not visibly exercise
Retry. `a20c5651` proved the real degraded list → Retry → list command sequence
but failed four review lanes for the gaps above.

The repaired focused battery is 105 assertions across twelve cases. It bounds the
parent's persisted-file read and XML serialization before argv construction,
rejects oversized/malformed/invalid-UTF-8/wrong-root setups, and observes a
small nested-entity setup rejected before either XML parse. It also observes a
portable timed-out child stop writing its heartbeat after kill/reap. The probe
command stays within a conservative Windows process-command envelope, and a
real Retry with a corrupt persisted setup fails closed before launching a
fallback probe. CTest also
launches the real Release executable with a 60-second child stall and a 250 ms
parent bound. Before the command journey it round-trips system-default,
output-only, and input-only setups through a real child argv boundary without
touching hardware. It then calls `list_audio_devices`,
`retry_audio_device`, and `list_audio_devices`. The smoke passes only when all
three argv probes reach the injected stall, both list calls return within one
second with `audioEnabled:false` and zero device types, and Retry returns its
second bounded timeout within two seconds.

Candidate `84e29db241882b838596a5d1956433ea4e0429dd` is frozen under
`~/Library/Mosh/audits/production-v2-20260730/issue-527-84e29db2/`.
Its final uncontended native gate hashes to
`41d1c336f44848c8f0abce5372c8afc4de2e4bca547bfc8c0a5661276f25998c`;
the executable smoke hashes to
`dc0e5d5a9bc4f616f8c07e11b7f453b430b945e04dac598d1ce6ae0d644c0812`.
The native QA ledger hashes to
`0d9acc07c2cb9b81cb2b5244081c9f067efd085b5a1530c0ae279a8ac9955e07`;
the Settings screenshot to
`fb2ba51bb2d6b4cf331bfaf175af2c755448ea705c355bcb59b214092eb41284`;
and the redacted Retry command record to
`1bc3ec25c61295bcc3a665f791e8a7118f8bc417a61af1081990d1a96e4d1b0a`.
The first concurrent gate attempt remains archived as diagnostic history; an
isolated rerun and the final uncontended gate both passed. Later successors
repaired exact-token dispatch and the rolling evidence contract. Their proof
is intentionally not back-written here: the authoritative issue #527 manifest
must bind its exact SHA after the commit is frozen, or the candidate is not
eligible for merge.

## Timeline scrub fix evidence

Working branch: `codex/timeline-drag-scrub`
Base: `609bde7d12aca6155bf77dbf1d9aec2093925def`

### RED and GREEN

| Check | Result |
|---|---|
| Initial drag component RED | BarRuler and SongNav each emitted only the pointer-down seek |
| Computer Use platform RED | Captured movement reported `buttons=0`; first fixed runtime still emitted only the initial seek |
| Platform regression RED | `SongNav.test.ts` failed at one call versus two expected |
| Targeted GREEN | 12/12 BarRuler + SongNav tests pass |
| TypeScript | `npm run typecheck` passes |
| Full UI suite before platform edge fix | 226 files passed, 1 skipped; 2,191 tests passed, 1 skipped |
| Production UI build after platform edge fix | Vite build passes; 301 modules |

The handler uses pointer capture, request-animation-frame coalescing,
pointer-cancel/lost-capture cleanup, and an exact pointer-up commit. It does not
trust `PointerEvent.buttons` after capture because the native Computer Use path
reports zero during a valid held drag.

### Native Release evidence

Fixed source app hashes:

- Binary: `369f657eed285884ab825b7d3b931641973eadc9f4ce25c989580e17da43df2d`
- UI: `74b6e21e10154d2754eb7788c69590d2e0ab0e47b7398557a5ab09faf5d13f69`
- Uniquely signed runtime binary:
  `d69f8d4649d97f54d85a73c78211cf7672c9404f1b4d02e68cd6a9535cc072a5`

Computer Use supplied one movement sample per drag:

- SongNav emitted the immediate start and exact endpoint (`seq 4–5`).
- BarRuler emitted the immediate start and exact endpoint (`seq 6–7`).
- Before/after screenshots are
  `timeline-fix-v2/computer-{nav,ruler}-{before,after}.jpeg`.

The repository-style Quartz/native harness then supplied 15 held movement
samples:

- SongNav emitted 17 ordered positions (`seq 8–24`), including immediate start
  and exact final position.
- BarRuler emitted 17 ordered positions (`seq 25–41`), including immediate
  start and exact final position.
- A Shift-held ruler drag created the visible range toolbar and band while the
  transport-command count remained exactly 38.
- Shift evidence:
  `timeline-fix-v2/quartz-shift-range.jpeg`
  (`1ffa6911831270a4a652a2da1e84cdeb3a950518125ef23e061a477616f2ae90`).
- Native command log snapshot:
  `timeline-fix-v2/mosh-log-after-native-qa.jsonl`
  (`d2f49aa68ffa61e20331a5592d54dcd78509550ee633b71fe9595798eca0bab3`).

The first implementation commit was
`82227fdd28b50b41e0c2c85ad25688c4f0c4109a`. Its native gate passed:
selftest `2214/2214` ×3 deterministically with zero JUCE assertions, Catch2
100%, `verify.py` 29/29, Vitest 2,191 passed plus one skipped, and zero
conformance failures. The gate log is
`timeline-fix-v2/native-gate-82227fdd.log`
(`34c308327ac9a5e84a61626cf731990304b2f1a9d2002cb598be2036b83bb553`).

The first code-quality lane then found two real lifecycle defects: a final
pointer-up could duplicate an endpoint already committed by the last animation
frame, and a Shift-range was not owned by its initiating pointer. Focused RED
tests reproduced both failures. The hardening follow-up deduplicates committed
positions, isolates range and scrub pointers, tolerates DOMs without pointer
capture APIs, and adds lost-capture, unmount, same-endpoint, and multi-pointer
regressions. A later exact-SHA review found and repaired two more lifecycle
boundaries: a second pointer can no longer replace an active SongNav scrub, and
unmounting BarRuler releases a Shift-range capture and clears the drag state.
The final immutable-SHA manifest, rerun hashes, review verdicts, debugging
audit, and PR handoff live under the final `timeline-fix-v6` evidence directory
and in the PR body. They are generated only after the final commit so they
cannot falsely attest to a mutable tree.

## T0 capability ledger

The disposition column is the repository’s frozen capability-matrix posture;
runtime verdict is this campaign’s observed state. `NOT REACHED` is not a
failure claim.

| Capability | Matrix engine/UI | Runtime verdict |
|---|---|---|
| CAP-AUT-002 Automation modes | partial / partial | NOT REACHED |
| CAP-AUT-006 Mixer/send automation | partial / partial | NOT REACHED |
| CAP-CLP-001 Move/copy/paste/duplicate/marquee/select-similar | shipped / partial | NOT REACHED |
| CAP-CLP-002 Snap configuration/adaptive/bypass | n/a / partial | NOT REACHED |
| CAP-CLP-004 Split clips | shipped / shipped | NOT REACHED |
| CAP-CLP-005 Trim/crop | shipped / partial | NOT REACHED |
| CAP-CLP-009 Per-clip gain | shipped / shipped | Surface reached; behavior NOT REACHED |
| CAP-CLP-013 Per-clip mute | shipped / shipped | PASS sampled |
| CAP-CLP-016 Clip loop/region/play-start | shipped / partial | NOT REACHED |
| CAP-CLP-017 Ripple editing | partial / missing | ABSENT/PARTIAL per frozen matrix; issue disposition pending |
| CAP-EFX-003 Insert ordering/bypass/enable | shipped / partial | NOT REACHED |
| CAP-EXP-001 Master export formats/bit depth/dither/offline | partial / partial | Dialog reached; files NOT REACHED |
| CAP-MID-001 Piano-roll entry/edit/preview | shipped / partial | Editor reached; behavior NOT REACHED |
| CAP-MID-003 Per-note velocity | shipped / partial | NOT REACHED |
| CAP-MID-004 Quantize strength/swing | partial / partial | NOT REACHED |
| CAP-MIX-001 Track volume/pan/mute/solo | shipped / shipped | Surface reached; mutations NOT REACHED |
| CAP-PRJ-001 New/open/save/save-as | shipped / shipped | Dialog reached; equality/reload NOT REACHED |
| CAP-PRJ-005 Multi-level undo/redo/history | partial / partial | Surface reached; behavior NOT REACHED |
| CAP-REC-004 Timeline audio recording/multi-track | shipped / partial | FAIL baseline: hidden take #531; invalid source placement #545; lifecycle candidate under review |
| CAP-REC-006 Count-in | shipped / shipped | Control reached; recording behavior NOT REACHED |
| CAP-TMP-001 Numeric tempo/fine tune | shipped / shipped | Surface reached; mutation NOT REACHED |
| CAP-TRK-001 Track types | shipped / shipped | PASS sampled for instrument/drum; aux/audio pending |
| CAP-TRK-002 Rename/recolor/reorder/delete/icons | partial / partial | NOT REACHED |
| CAP-TRK-009 Inactive tracks/inserts | partial / partial | NOT REACHED |
| CAP-TRN-001 Play/stop/pause/resume | shipped / shipped | PASS sampled; long-session pending |
| CAP-TRN-002 Seek/navigation | shipped / shipped | Installed FAIL; exact merged Release PASS at `364cb6fe`; final campaign rerun pending |
| CAP-TRN-004 Loop region keyboard set/move/resize | shipped / partial | Shift range PASS; loop behavior NOT REACHED |
| CAP-TRN-005 Metronome configuration | partial / partial | Toggle reached; audio/routing NOT REACHED |

## Showcase and final acceptance

- [ ] Original 60–90 second alt-rap project completed entirely through UI
- [ ] Saved, reloaded, reopened, recovery-tested, and equality-checked
- [ ] 24-bit WAV mixdown meets loudness/true-peak/dropout limits
- [ ] Non-empty aligned stems pass common-zero/duration and stem-sum checks
- [ ] Loop, section, custom-range, tail, AIFF, FLAC, and bit-depth pairs exported
- [ ] Mix and stems reimported through the visible UI
- [ ] CoreAudio playback, built-in mic, BlackHole, meters, monitoring, and plugin audio observed
- [ ] Moshi creative, clarification, undoable correction, and cancellation journeys pass
- [ ] Every visible configured generative/lyric backend passes or has a user-owned credential/permission blocker
- [ ] Two isolated same-Mac instances pass room, presence, claiming, sync, disconnect, and rejoin
- [ ] Camera denial path passes
- [ ] Every frozen inventory row passes on one exact final Release SHA

The campaign remains red until every item above is checked and every finding has
an issue/disposition. Musical taste remains an owner listen after measurable
workflow and audio integrity pass.
