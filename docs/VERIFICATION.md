# Mosh — Hardware Verification Runbook

*Closing the gap between "passes `--selftest` plumbing" and "**actually** produces correct audio /
responds to a mic / syncs between two peers."*

Most of Mosh is proven by the deterministic command-surface harness (`Mosh --selftest` —
**~1200+ checks as of 2026-07, gate-dependent**; it was ~784 when this runbook was written) plus
the UI suites (vitest + Playwright). Those prove the *plumbing*. This runbook proves
the parts that only real hardware (or real audio rendering) can confirm.

**Primary proof vehicle = offline render-to-WAV.** Rather than live-listening or BlackHole
loopback, we bounce the real signal chain to a file (`export_audio` / `bounce_layer_to_clip`, plus the
render-layer job artifacts) and assert on the WAV's contents programmatically
(non-silent? expected level? did the Tier-B transform / SA3 actually change the audio vs its input?).
This is deterministic, headless, and needs no one present — you can audition the saved WAVs later.
Only a few checks are inherently live (audio-input recording and two-window multiplayer sync).

## Prerequisites

| Need | For | Present on this machine |
| --- | --- | --- |
| Release `/Applications/Mosh.app` built from current `main` | everything | rebuild via `./run-mosh.sh deploy` |
| `service/.sa3.env` wired (`service/setup-sa3.sh`) | SA3 transform check | model present at `~/AI/stable-audio-3/optimized/mlx`; run setup to wire |
| `numpy` | WAV analysis | numpy 2.4.4 ✓ |
| Microphone + Privacy→Microphone grant | audio recording | owner-provided, live after explicit input selection/arm |
| `ui/.env.local` brain key | typed agent requests | optional |

## The harness

`scripts/verify-hardware/` (a driver that runs `Mosh --run-script` headlessly to render
evidence WAVs into `verify-artifacts/`, plus a numpy/`wave` analyzer that asserts each WAV and
prints a pass/fail report — see [`scripts/verify-hardware/README.md`](../scripts/verify-hardware/README.md)):

```bash
python3 scripts/verify-hardware/verify.py          # offline checks (1,2,3,5) — self-driven, deterministic
python3 scripts/verify-hardware/verify.py --sa3     # also the real SA3 transform (needs service/setup-sa3.sh)
python3 scripts/verify-hardware/verify.py --rave    # also the real RAVE transform path (needs service/transform/setup-transform.sh)
python3 scripts/verify-hardware/verify.py --rave-insert --bin build-anira/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh
                                                    # the real-time RAVE insert offline render (anira build + transform venv); asserts gap-free
python3 scripts/verify-hardware/verify.py --gate    # also enforce the golden-audio checksum baselines (the pre-merge gate runs this)
python3 scripts/verify-hardware/verify.py --update-golden  # regenerate baselines after an INTENTIONAL DSP/adapter change
# live checks (6,7,8 — owner-driven) are listed per-row below.
```

**Golden-audio gate (`--gate`).** Beyond the RMS/peak BOUNDS each check already asserts, the
deterministic renders (`makes_sound`, `drums`, `transform_fake`, `full_loop`) are pinned to a
committed PCM-checksum baseline ([`golden/manifest.json`](../scripts/verify-hardware/golden/README.md)) —
so a code change that silently alters the SAMPLES reds the gate (with a feature-diff naming
which of `peak`/`rms`/`centroid_hz` moved), not just "still within bounds". `scripts/auto-loop/gate.sh`
runs `--gate`; an intentional DSP/adapter change regenerates the baseline with `--update-golden`.

## Checks

Results below record the **2026-06-20 baseline pass** (plus the dated fixes noted per-row);
offline checks are deterministic — WAV checksums stable across runs — and are re-enforced on
every merge via `verify.py --gate` in `scripts/auto-loop/gate.sh`, so the offline rows stay
continuously proven even though this table's snapshot is from 2026-06-20.

| # | Check | Kind | Asserts | Status |
| --- | --- | --- | --- | --- |
| 1 | Makes sound | offline | non-silent, right duration/level | ✅ 2.0s stereo, peak 0.18, RMS 0.12 |
| 2 | Drums audible | offline | non-silent (silent-drums regression guard) | ✅ 4.0s, peak 0.91, RMS 0.088 |
| 3 | Transform render (fake) | offline | Tier-B `transform` (fake adapter) renders non-silent, differs from input | ✅ `adapter/mode: transform`, **diff-from-input RMS 0.270**, RMS 0.45 |
| 4 | SA3 transform | offline (`--sa3`) | real model renders, quality readout present, differs from input | ✅ `adapter: stable_audio3`, **`pq 6.933`**, non-silent |
| 4b | RAVE transform (real path) | offline (`--rave`) | real `torch.jit` RAVE encode→decode renders non-silent, differs from input | ✅ `backend: rave`, out-RMS 0.71, **diff-from-input 0.37** (synthetic scripted model; user drops real `.ts`) |
| 4c | RAVE insert, real-time (Route C.2) | anira build (`-DMOSH_ENABLE_ANIRA=ON`), offline (`--rave-insert`) | a RAVE insert in the render graph transforms audio AND the offline export is **gap-free** (the C.2 follow-up: anira switches to non-real-time/blocking mode when `PluginRenderContext::isRendering`, so a faster-than-real-time render never drops blocks) | ✅ anira 2.1.0 + LibTorch 2.4.1; `add_rave_insert modelLoaded:true`; wet ≠ dry (**diff-from-dry RMS 0.396**), non-silent, **max exact-zero run = 1 sample** (threshold 256 → no missing-sample gaps); synthetic scripted model, user drops a real `.ts` |
| 5 | Full producer loop | offline | multi-track + mix exports non-silent | ✅ 2.0s, peak 0.34, RMS 0.18 |
| 5b | Relative-ref export (MP-hang guard) | offline | a wave clip with a RELATIVE source ref (multiplayer `mp_commit_track` / `relink_clip` on an unsaved edit) exports WITHOUT hanging (timeout-protected) + non-silent | ✅ fixed 2026-06-22 (resolver `../` asymmetry); was an infinite `ArrangerLauncherSwitchingNode` render-graph recursion |
| 5c | Bypass layer re-route (A/B) | offline | `bypass_layer{true}` RE-ROUTES real audio — it mutes the landed neural clip so the export collapses BACK to the original (pre-render) source, not just flips a status flag | ✅ AL-008: accepted render moves the mix clear of the original (**rendered-vs-orig RMS ≫ 0**) and bypass snaps it back (**bypass-vs-orig RMS ≈ 0 ≪ rendered-vs-orig**) |
| 5d | Freeze stops the reactive re-render | offline | `freeze_layer` actually STOPS the auto-re-render loop (not just a status label), and `unfreeze_layer` restores it — counted in rendered files, with a live service | ✅ the inverse of the reactive check: initial render + a frozen edit + a thawed edit ⇒ exactly **2** layer files (3 = the freeze never held, 1 = the thaw never re-armed). RED-proven: with the `ids::reactive` write removed the frozen edit renders and it reads **3**. `--selftest` cannot see this — `reactiveTouch` returns on `!hasAudio()` before it reads the flag |
| 5e | Spectral helpers self-test (CAP-EXP-001) | offline, no binary | the SHAPE instrument itself: `welch_psd_db` / `harmonic_excess_db` / `noise_floor_db` must put a truncated −87 dBFS tone and a TPDF-dithered one on OPPOSITE sides of the discriminator, on inputs synthesised in numpy where the answer is known | ✅ truncated excess **24.8 dB**, dithered **0.7 dB**, floor rise **+49.9 dB**. RED-proven 3 ways (stop truncating → witness false; blind the discriminator → false; use plain ROUNDING instead of TPDF → excess 28.9 dB, still fails). Every other offline check can only see LEVEL, so none of them could have caught this class |
| 5f | 16-bit export dithers (CAP-EXP-001) | offline | a −87 dBFS tone (≈1.4× the 16-bit LSB) rendered 3 ways from one session: the energy at 2f/3f/4f/5f DROPPED **and** the broadband floor ROSE. The undithered baseline is computed in numpy FROM the 24-bit render (ground truth), not from Mosh's own output; the 32-bit float render proves the untouched path stayed untouched | ✅ RED-proven against a binary built from pristine `origin/main`: its 16-bit render carried **24.79 dB** of harmonic excess over its own floor and reproduced the numpy truncation model **exactly** (identical floor and 2f..5f levels), i.e. the old path floors rather than rounds. GREEN: **0.62 dB** — within that run, **−22.01 dB** of harmonics and **+22.79 dB** of floor against its own ground-truth baseline (**+45.11 dB** against the 24-bit reference). The 32-bit render is untouched |
| 6 | Realtime output path | live | device opens; audio frames flow | ✅ `--live-audio-smoke` **14/14** (MacBook Pro Speakers, CoreAudio 48k) — by-ear out-loud confirm still owner-side |
| 6b | Live MIDI capture (REC-001/002) | live | playing the computer keyboard reaches the RECORDER, not just the monitor: an armed track takes the engine's input path, the notes land in a take, Capture MIDI recovers notes played while NOT recording, and overdub merges into the existing clip | ✅ `--midi-record-smoke` **34/34**, deterministic over 3 consecutive runs, 0 JUCE assertions. RED-proven twice: removing the input route fails **7** checks (the take lands nothing, Capture recovers nothing, overdub lands nothing); forcing `mergeRecordings=false` fails the merge check with clips 3 → 4. `--selftest` structurally cannot see any of it — with no audio device `getAllInputDevices()` is empty, so the routing fork is never taken and the retrospective buffer never fills |
| 6c | Measured latency calibration (LAT-001) | live | `calibrate_latency start` plays a two-second sweep through the output, captures the input in the same device-callback clock, and stores frames + confidence; the RESIDUAL over the driver's own `roundTripLatencyMs` is pushed into Tracktion's record adjustment and a recorded click lands within 1 ms of where it was played | automated: `tests/latency-calibration-smoke.sh <Mosh>` runs `--latency-calibration-smoke` with BlackHole 2ch as output AND input: the sweep loops back digitally, a measurement must land (`applied:true`, never a silent number), then a 1 kHz click played at 1.0 s is recorded through the same loopback and must land within **1 ms** of 1.0 s. Owner-side only: speakers + mic in a real room (a measurement or an honest "ambiguous" / "nothing captured" refusal). Headless surface pinned in `--selftest` LAT-001; detector/residual/lifecycle maths in `MoshTests "[latency]"` |
| 6d | Crash residue + silent-take flag (CAP-001) | live | a take Tracktion streamed to disk when the app died mid-recording is offered on relaunch (adopt at its BWAV position on the named track, or set aside by rename — never deleted), and a landed take that captured nothing carries an amber "silent" badge | automated: `tests/crash-residue-smoke.sh <Mosh>` — run 1 (`--record-hold-smoke`) records from BlackHole 2ch and is `kill -9`ed mid-take; run 2 relaunches headless on the same session and must see `recoveryAvailable` + the take in `recordingResidue` (readable, decision adopt); run 3 adopts it and must find a `recovered` clip of real length on Vox, measured. Owner-side only: the silent badge with a real interface muted. Headless policy in `--selftest` CAP-001; pure decisions in `MoshTests "[residue]"` |
| 7 | Audio-input consent boundary | live | launch stays output-only; explicit audio input/arm requests mic and records | ⏳ owner: verify first explicit audio-recording action prompts once and records |
| 8 | Multiplayer (2-process) | live | protocol green; track-lock + clip-move sync | ✅ `relay/run-mp-selftest.sh` **911/911** — two-window *visual* sync still owner-side |
| 9 | Sketch (beatbox→drums) | gated | recognizable kick/snare/hat land in a real editable clip; tempo set; byte-identical across runs | ✅ `MOSH_SELFTEST_SKETCH=1` **16/16** on the committed fixtures (boom-bap 90 + trap 140), determinism asserted; CLI stdout byte-identical across runs |

**Measured latency calibration** (needs a real audio device with an input; a loopback cable
makes the expected number exact): open the v2 record panel (the **Rec** chip), press
**Calibrate**, stay quiet for two seconds. The row reads "N ms measured · ±R ms on top of the
driver's D ms". Switching sample rate or device marks the record stale and Mosh reverts to
the driver's figure until you calibrate again — a wrong calibration is worse than none.

**Live MIDI capture** (needs a real audio device; nothing else — no MIDI controller):

```bash
build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --midi-record-smoke
```

What makes this automatable rather than owner-driven, unlike its neighbours in this table:
the virtual **"Mosh Keyboard"** MIDI input Mosh publishes. A physical controller cannot be
synthesised, but a virtual device's `handleIncomingMidiMessage` is the exact entry point a
physical one uses — so driving it through `audition_note` *is* a producer playing the
computer keyboard. It is NOT in CI because a GitHub runner has no audio device.

It deliberately asserts nothing about **audibility** — that is check 6's job. Conflating the
two is how a harness ends up proving sound it never measured.

**Sketch gated selftest** (needs `service/sketch/setup-sketch.sh` first):

```bash
MOSH_SELFTEST_SKETCH=1 MOSH_SKETCH_FIXTURE_DIR="$PWD/service/sketch/fixtures" \
  build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest   # run from the repo root
```

The default `Mosh --selftest` (no env) passes identically whether or not the librosa venv is
present (graceful degradation) — it was 893/893 at this table's 2026-06-20 pass; the harness has
since grown to ~1200+ gate-dependent checks. Remaining hands-on for Sketch: the by-ear "does it groove" confirm and a
real beatbox-from-your-mouth take (the fixtures are synthesised, not recorded) — owner-side.

Evidence WAVs + the analyzer `report.json` land in `verify-artifacts/` (git-ignored). The
`--run-script` runner and the harness live in PR #80; this runbook in #78.

## Re-running

The offline checks (1–5) are deterministic — re-run `python3 scripts/verify-hardware/verify.py`
(add `--sa3`) any time a change could affect the signal chain, as a render-level regression guard
on top of `--selftest`.

## Parity hands-on checklist (owner, ≤30 min)

*The L4 lane of the DAW-parity program: the short list of things silicon can't hear. Run a
pass at milestones (or when a row's trigger paths change — the native gate prints an
advisory naming affected rows). Record each pass inline: `last-passed: YYYY-MM-DD @ <short-hash>`.
Everything else about parity is automated — if a row here feels worth automating, it
probably belongs in `verify.py`, not this list.*

**Triggers:** recording/input paths → REC rows · fades/crossfades → EAR-fades ·
warp/stretch → EAR-warp · stems/export → EAR-stems · MIDI input → MIDI-in ·
relay/multiplayer → MP-two-mac · phone pad → PHONE rows.

| id | Steps | Expect | ~min | last-passed |
| --- | --- | --- | --- | --- |
| REC-mic | Arm the vocal track with `arm_track` (until the arm button ships), `set_count_in` 1 bar, record 4 bars against the click, stop. | Take lands where it was played; the count-in bar is audible but excluded from the clip. | 5 | — |
| REC-latency | Record the metronome via a loopback (BlackHole/cable); zoom to a click transient in the recorded take. | Recorded transient within ~5 ms of the grid line (input-latency compensation applied). | 5 | — |
| REC-monitor | Toggle `set_input_monitor` on the armed track while singing. | Live input audibly gates on/off with the toggle. | 1 | — |
| EAR-fades | 1 s fade-in + fade-out on a clip; split a sustained clip and crossfade the splice. | No clicks/pops at any boundary; crossfade is smooth. | 3 | — |
| EAR-warp | Warp a 2-bar 170 BPM loop to a 120 BPM project (`set_clip_warp detect` or Fit-bars). | Downbeats land on the grid; artifacts acceptable at this ratio. | 3 | — |
| EAR-stems | `export_stems` + `export_audio` the same song; import the stems to fresh tracks and A/B against the mixdown. | Indistinguishable by ear (the sample-level `sum≈mix` null lives in `verify.py`, automated). | 4 | — |
| MIDI-in | Connect a MIDI keyboard (picker from G11); play live, then record 2 bars. | Live notes sound with low latency; recorded notes land where played. If a MIDI *take* can't be recorded, that's a capability-matrix MISSING row — file it, don't shrug. | 4 | — |
| MP-two-mac | Two Macs, one session: claim a track from Mac B, move a clip on Mac A. | Lock icon + live clip motion on both within ~1 s. | 5 | — |
| PHONE-pair | V3 → Phone; scan the QR with the iPhone Camera app on the same Wi-Fi. | Safari opens `/pad#token=…`; the banner reads IDLE (or SETUP NEEDED if no Lead/Takes pair exists yet) rather than PAIR PHONE, and the URL host is the Mac's LAN IP (never `.local`, never `pairingUrl`). | 2 | — |
| PHONE-loop | From the phone: Put Me In / Keep / Again / Review Selected Take / Play All / Stop. | The Booth mirrors every action live; Lead and Takes clips land where expected and are audible. | 5 | — |
| PHONE-recover | Background/foreground the phone page; drop Wi-Fi and reconnect; from the Booth's Phone modal, press Stop. | Background/foreground survives without a new scan; Wi-Fi drop/reconnect resumes polling; Stop in the modal ends the pairing and the pad falls back to a PAIR PHONE state — reloading the page then requires a fresh scan. | 3 | — |

### V3 default-shell acceptance (owner; the last row of the V3 parity gate)

*Row §5 of [docs/V3-PARITY-BRIEF-2026-09-17.md](V3-PARITY-BRIEF-2026-09-17.md). One real session on
the built Release with the V3 shell selected, on the owner's Mac. Feel, audibility and latency are
the owner's call; no gate above can close these. Record the pass inline and put the session's
evidence (screenshots, the exported mixdown, notes) in
`~/Library/Mosh/task-evidence/<YYYY-MM-DD>-v3-acceptance/`; the flip PR cites that directory.*

| id | Steps | Expect | ~min | last-passed |
| --- | --- | --- | --- | --- |
| V3-beat | `+ Drum beat`, then ask the dock for a lofi sketch. | Both land audible drum tracks; one ⌘Z each reverts them whole. | 3 | 2026-09-20 owner ear: kit audible (harness 7/7); open: one live-model dock ask |
| V3-vocal | Arm a track, count-in 1 bar, record two takes in the Booth, pick one, Keep. | Takes land where sung, the count-in is audible but excluded, Keep flattens, ⌘Z restores. | 5 | 2026-09-20 owner ear: takes audible, count-in excluded (smoke 59/59); open: real-mic monitoring feel/latency |
| V3-mix | Level/pan/mute/solo, insert 4OSC + a preset, + Bus and a send, zoom and drag a clip. | Every edit audible and one ⌘Z each; nothing feels laggy at 44.1 kHz / 512. | 5 | 2026-09-20 owner ear: edits audible (harness 23/23); open: feel at the desk |
| V3-file | Save, close, reopen, export a mixdown; import a `.mid` from the Browser. | Reopen is identical; the export plays; the MIDI lands as one clip. | 3 | 2026-09-20 owner ear: export plays (harness 9/9) |
| V3-mp | Two Macs: Invite from A, join from B, claim a track on B, edit on A. | Lock badge and edits appear on both within ~1 s; Leave clears. | 5 | — (harness 1/1 two processes, one Mac); open: second physical Mac |
| V3-feel | Ten minutes of ordinary use in each colorway. | Nothing you would not ship as the first thing a new user sees. | 10 | — (harness 2/2, 32 PNGs, 4 viewed); open: ten minutes per colorway |

**Automated half (2026-09-19).** `python3 scripts/v3-acceptance/run.py` runs, on this Mac
against the real engine, every part of the six rows a machine can honestly close, and writes
the evidence directory above (`REPORT.md`, `rows.json`, the renders, the takes, the
screenshots). It exits 0 only when every row it ran passed; every check is one that would
read differently if the feature were absent. What it proves, and what it leaves to the
owner, row by row:

| id | automated (the harness, real engine) | owner still owes (minutes with the artifacts) |
| --- | --- | --- |
| V3-beat | `add_drum_pattern` with no target lands a kit + one-bar pattern as one clip; the offline render has ≥ 6 drum onsets; one undo removes the track. The dock's lofi ask runs against the mock loop in `ui/e2e/v3-beat.spec.ts`. | Does the kit sound like a kit; one real ask to the dock with a live model. |
| V3-vocal | `Mosh --v3-vocal-smoke` on the BlackHole loopback: the 1-bar count-in rolls (phase `count_in`) and is EXCLUDED from the take (the take starts at the entry point and its first sound is the guide played after it); two passes land as non-silent WAVs (the Again pass within the calibrated 2 ms; the count-in pass up to one device block early — a measured Tracktion placement quirk, reported as `take1OffsetMs`); Again rejects/mutes and restarts capture; Keep moves the pass to LEAD audible; undo reverses the keep. Copies of both takes are in the evidence dir. Then `Mosh --v3-booth-smoke` walks the Booth's OWN button path (Add a Vocal track on a Lead with no input, Hear myself: Off, Put Me In from bar 1 with no navigate) and ends takes with the Stop pad, the TopBar stop, Shift+Space and Space; after each it reads `snapshot.loop` (what the Booth renders, never `loop_state`, which adopts unstamped clips) and asserts the take registered as a Part, idle, `lastId` on it, the older unkept pass muted, and that Keep acts on it. Then a take ended by `export_audio` (a stop that bypasses the finalize) leaves no pass in flight: a Booth start that cannot roll right after it (Takes disarmed) names no pass in its `loop_record` / `loop_keep` / `loop_again` result, and the next TopBar Record/Stop take is not stamped as the old pass. Last, the Stop pad (`loop_stop`) ends a take the TopBar started: the transport stops, the take lands non-silent on Takes, and the receipt reads "Stopped". Added 2026-09-23 after the installed app's Booth listed no Parts under an audible take. | Sing into a real mic: audibility, monitoring feel, latency at the desk. |
| V3-mix | level, pan, mute, solo, a 4OSC preset, a send to a reverb bus and a clip move each change the rendered audio in the direction the edit implies, and one undo each returns the render to the baseline; `snapshot()` cost and an upper bound on per-command latency are measured. Zoom is `ui/e2e/v3-timeline.spec.ts`. | Whether it feels immediate at 44.1 kHz / 512. |
| V3-file | `save_as` → `new_project` → `open_project` reproduces the project projection (names, clips, plugins, mixer); the exported mixdown is non-silent and the project's length; a generated `.mid` imports as one clip with four notes; undo removes it. | Play the export somewhere else. |
| V3-mp | two real Mosh processes on this Mac over the local relay (`scripts/playtest/mp-two-window-dry-run.sh`): create/join, claim→commit, bus, group, late-join bootstrap, a multi-second take byte-identical on the peer; `--cloud` adds the cloud-relay smoke. The lock badge on V3 chrome is `ui/e2e/v3-multiplayer.spec.ts` against the mock peer. | A second physical Mac; whether ~1 s feels live. |
| V3-feel | the whole V3 Playwright suite plus `ui/e2e/v3-acceptance-screens.spec.ts`: eight surfaces × four colorways screenshotted, accents proven distinct by pixel readback. | Flip the 32 PNGs; ten minutes of ordinary use per colorway if one looks wrong. |

The harness closes the *engine* and *UI-on-mock* halves. The `last-passed` column stays the
owner's: it is dated when the owner has done the right-hand column with the harness's
artifacts, which is a listening session of minutes, not the original hour.

## Collaborator video — two machines (hardware-gated)

The WebRTC + signaling layer is built and unit-tested (`ui/src/webrtc/*.test.ts`,
`relay/run-mp-selftest.sh`); the macOS 12+ camera permission delegate
(`src/webview/WebViewCameraPermission.mm`) unblocks `getUserMedia` in the packaged app.
This is the operator procedure to prove peer video on real hardware.

1. **Build/deploy** Mosh on both Macs: `./run-mosh.sh deploy` (or copy `/Applications/Mosh.app`).
2. **Relay** — pick one:
   - *Cloud (default, zero-config):* nothing to do; the Supabase relay is baked in.
   - *Local:* on Mac A run `PORT=8771 python3 relay/server.py`; on **both** Macs
     `export MOSH_RELAY_URL=http://<MacA-LAN-IP>:8771` before launching.
3. **Session** — host creates a session (gets a room code); guest joins with that code.
   Confirm each Mac shows the other in the presence cluster.
4. **Camera** — on each Mac, accept the macOS camera prompt (first time), then click the
   camera toggle. Expect: each sees the other's live tile in the Session rail; toggling
   off removes the remote tile and the camera light goes out.
5. **Same-Mac smoke (optional)** — two Mosh instances on one Mac (sharing the one camera)
   partially checks signaling + tiles without a second machine.
6. **Troubleshooting** — no remote video:
   - System Settings → Privacy & Security → Camera → ensure Mosh is enabled.
   - Relay reachability: `curl <MOSH_RELAY_URL>` from both Macs.
   - The Console log line `[webview] camera permission delegate installed` confirms the
     delegate attached (absent → it didn't find the WKWebView; camera will fail).
   - Same-LAN works with STUN only; cross-NAT may need a TURN server (out of scope).
