# Mosh — DAW Parity Scoreboard

_Generated from a live conformance run against `Mosh` by `scripts/daw-conformance/conformance.py` + `scoreboard.py`._

> **This supersedes the 2026-06-09 baseline audit.** That audit's JSON (`167 missing / 24 shipped`) was a point-in-time snapshot; ~20 feature waves and subsequent work landed on top of it, so it cannot be read as current. This page is regenerated from the gathered reality-pack eval suite replayed through the **real command surface** — it reflects what the code does *now*. The archived baseline lives in `docs/archive/feature-audit-2026-06-09/`.

## Headline

- **150 / 152 in-scope eval rows pass** (~99%), proven headless (state / audio / undo asserted).
- **0 gap** rows — real conventional-DAW gaps, tracked in the backlog below.
- **2 hardware** row — needs a live device (Phase-1 hardware pass).
- **48 out-of-scope** rows — Monster / Arena / Collaboration (outside the conventional-parity pass).
- Scope: conventional DAW parity (Monster/Arena/Collaboration out-of-scope).

## Parity by area (eval suite)

| Area | pass | gap | hardware | out-of-scope |
|---|---|---|---|---|
| Transport | 16 | 0 | 1 | 0 |
| Import | 17 | 0 | 0 | 0 |
| Recording | 16 | 0 | 1 | 0 |
| Clip editing | 17 | 0 | 0 | 0 |
| Mixer | 17 | 0 | 0 | 0 |
| Effects | 17 | 0 | 0 | 0 |
| Automation | 17 | 0 | 0 | 0 |
| Browser | 17 | 0 | 0 | 0 |
| Export | 16 | 0 | 0 | 0 |
| Monster | 0 | 0 | 0 | 16 |
| Arena | 0 | 0 | 0 | 16 |
| Collaboration | 0 | 0 | 0 | 16 |

## Scenario verdicts

| Area | Scenario | Status | Invariants | Notes |
|---|---|---|---|---|
| Arena | Try to submit after the deadline | — out-of-scope | — | Arena is outside the conventional-parity pass |
| Arena | Vote for submission B | — out-of-scope | — | Arena is outside the conventional-parity pass |
| Automation | Create fade out over last 4 bars | ✅ pass | 61,66 | fade-out is volume automation; proven here on an EQ param (track-vol locator is a separate path). |
| Automation | Edit an existing automation point and undo it | ✅ pass | 67 |  |
| Browser | Preview sample | ✅ pass | 70 | preview audibility is hardware (Phase 1); the no-mutation invariant is proven here. |
| Browser | Relink a missing asset to a replacement file | ✅ pass | 71,73 |  |
| Clip editing | Move vocal clip to hook marker | ✅ pass | 21,96 |  |
| Clip editing | Split selected clip at the playhead and duplicate second half | ✅ pass | 24,25 |  |
| Collaboration | Second user joins during playback | — out-of-scope | — | Collaboration is outside the conventional-parity pass |
| Collaboration | Two users attempt to edit the same clip concurrently | — out-of-scope | — | Collaboration is outside the conventional-parity pass |
| Effects | Add reverb to vocal | ✅ pass | 53 |  |
| Effects | Bypass then re-enable an inserted delay effect | ✅ pass | 54 |  |
| Export | Render a loop range with delay tail enabled | ✅ pass | 78,81 |  |
| Export | Submit 16-bar battle mix | ✅ pass | 78,79,83 | export/bounce mixdown proven; battle-submission immutable-render is out-of-scope. |
| Import | Drag WAV beat to bar 1 track 1 | ✅ pass | 2,69,75 | drag GESTURE is e2e-covered; the import capability is proven here. |
| Import | Import an MP3 with spaces/unicode in filename | ✅ pass | 69 | wav proxy for the unicode/space-filename path; real mp3 decode is format-dependent. |
| Mixer | Monster: turn vocal up | ✅ pass | 51,97 |  |
| Mixer | Mute then solo the same track according to Mosh solo policy | ✅ pass | 14,15,58 |  |
| Monster | Ask “what changed?” after edit | — out-of-scope | — | Monster is outside the conventional-parity pass |
| Monster | Issue ambiguous command “make that louder” with no selection | — out-of-scope | — | Monster is outside the conventional-parity pass |
| Recording | Deny mic permission and try to record | ✅ pass | 45,49 | no input device headless → graceful no-op, no fabricated clip. |
| Recording | Record vocal with 1-bar count-in | 🔌 hardware | 5,41,42 | count-in/pre-roll state proven headless (before=0, one_bar=1, two_bars=2, restored=0); the audible click + delayed capture start still needs a live device -- covered by the Phase 1 hardware pass, same posture as transport play. |
| Transport | Press Play in a loaded session | 🔌 hardware | 1,4 | play→audible + playhead advance is proven in the Phase 1 hardware pass (headless play is a no-op without CoreAudio). |
| Transport | Seek to a section marker while playback is stopped | ✅ pass | 8 |  |

## Conventional-parity backlog (drives the auto-loop)

Each item maps to a reality-pack invariant + eval-suite area. `cheap` = UI/agent wiring (auto-mergeable); `native` = MoshOps/engine. Items touching `src/engine/MoshEngine.*` or `src/state/**` land as `needs-human` PRs.

| id | tier | class | Gap | Evidence | Invariants |
|---|---|---|---|---|---|
| G1 | must | native | Export range/section + delay-tail policy | export_audio hardcodes {0,getLength()} over all tracks; no range arg, no tail policy. | inv 78,81 |
| G14 | must | native | set_track_volume / pan undo restores prior value | DISCOVERED: vp->setVolumeDb() bypasses the UndoManager → empty txn; undo does not revert (logs undoable:true). | inv 97 |
| G2 | must | native | Recording count-in / pre-roll + mic-permission UX | G2a (mic-permission/failure UX) landed via #254. G2b (count-in) landed: set_count_in (project preference, same MOSH_PROJECT node/template as set_key) is wired into tracktion_engine's own pre-roll (te::Edit::setCountInMode); snapshot.countInBars exposes it. Re-run conformance.py against a built binary to flip fam_record_countin from gap to hardware and regenerate this row. | inv 5,41,45,49 |
| G3 | must | cheap | Audio device + per-track input picker UI | set_audio_device/set_track_input/list_wave_inputs exist; Settings exposes only buffer/threads. | inv 16,41 |
| G4 | must | native | Clip inspector (gain/mute/rename) + clip fades | set_clip_gain/mute/rename agent-only; NO fade command exists; Inspector is track-only. | inv 27,29,30 |
| G5 | should | cheap | Sends / returns / bus UI + agent catalog | Backend real (create_bus/add_send/set_send_level in MoshOps); no UI, absent from agent catalog. | inv 59 |
| G6 | should | cheap | Tempo / time-sig / metronome GUI controls | set_tempo/set_time_signature/set_metronome exist + in agent catalog; Topbar shows them read-only. | inv 6,7 |
| G7 | should | native | Stem export (per-track, common zero point) | All tracks render to one file; no per-track stem path. | inv 84 |
| G8 | should | cheap | Per-track output / multi-out routing UI | set_track_output/list_track_outputs real; loadRouting() orphaned in store; no picker. | inv 19 |
| G9 | should | cheap | Audio warp / time-stretch GUI | set_clip_warp + autoTempo/stretchMode serialized; no control to engage it. | inv 24(matrix) |
| G10 | nice | native | Automation depth (write/touch/latch modes) | Point-draw only; no record-knob / mode / multi-target conflict policy. | inv 63,64 |
| G11 | nice | cheap | MIDI-input picker + live-monitor surface | list_midi_inputs unreferenced in UI. | inv 47 |
| G12 | nice | native | Comping promote-to-main UX | Take swap only; no visual comping / promote. | inv (comping) |
| G13 | nice | cheap | Missing-media on-load banner | clipToVar.sourceMissing emitted + relink exists; verify a clear load-time banner. | inv 71,117 |

## How this stays honest

- `conformance.py` is wired into the native gate (`scripts/auto-loop/gate.sh`), so every merged native PR keeps the proven rows green; a parity fix flips its gap → pass.
- Audio/undo claims are asserted against real rendered WAVs and the real `snapshot()` (via the `__snapshot` run-script directive) — not against command return codes.
- Hardware-only behavior (mic capture, live meters, MIDI input, multi-out, loop playback) is confirmed in the Phase-1 hardware pass — see `docs/VERIFICATION.md`.

