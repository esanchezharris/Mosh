# Verified capability truth — P0 of the DAW-parity program (2026-07-18)

*Input to the Phase-2 capability matrix (`daw_capability_matrix.csv`). Every row below was
verified against source on this date (branch even with `main` @ `363724d2`), not inferred
from docs — the previous "known missing" lists had drifted badly (six of the items commonly
cited as missing had already shipped).*

## Shipped since the reality-pack was locked (2026-06-26) — previously miscounted as gaps

| Capability | Evidence | Landed |
|---|---|---|
| Export range (full/loop/custom) + delay-tail policy | `cmdExportAudio` `range/start/end/tail/tailSeconds`; `fam_export_range_tail` drives them | #410 (`27e8686a`) |
| Per-track stem export, common zero point | `export_stems`; isolation fix for upstream `te::toBitSet` always-all-tracks bug | #410 (`4241a9d2`, `8c63878f`) |
| Clip fades in/out + crossfade | `set_clip_fade`, `set_clip_crossfade` + Inspector controls | #410 (`0812e7e1`) |
| Clip inspector gain / mute / rename | `a54d4fc1` | #410 |
| Count-in / pre-roll | `set_count_in` + producer-facing UI | #410 (`c2b91d38`, `aa31fe10`) |
| Automation write-mode recording + bulk curve author | `set_track_automation_mode`, `write_automation_curve` | #414 (`27c04af6`) |
| Ripple delete + clip loop region | `delete_time_range{ripple}`, `set_clip_loop` | #424/#425 |
| Clip reverse / normalize / crossfade UI | `set_clip_reverse`, `normalize_clip` | #417 |
| Master-bus plugin hosting | `load_master_plugin` + 6 sibling commands | #420 |
| Tempo map: mid-song tempo changes + curves | `insert_tempo_change`, `remove_tempo_change`, `set_tempo_curve` | Waves T/V |
| Track grouping / submix | `create_group_track`, `ungroup_track` | Wave D |
| Takes + comping promote | `list_takes`/`set_current_take`/`keep_take`/`mark_take` + Inspector takes UI ("Keep current take") | Wave B + #393 |
| Warp / stretch | `set_clip_warp{detect}`, `stretch_clip`, `detect_clip_bpm` | #357 |
| Bounded plugin scan (hang-proof) | background thread + dead-man's-pedal blacklist + progress events | #348 |

Conformance re-run on a fresh binary (2026-07-18): **150/152 in-scope pass, 0 gap, 2 hardware**
(the two hardware rows are play→audible and count-in→audible-click — live-device territory).
`docs/FEATURE_AUDIT.md` regenerated; `docs/auto-loop/backlog.jsonl` reconciled
(G1/G2b/G4a/G4b/G7/G10/G12/FIT-003 → done with commit evidence; successor **G10b** filed for
touch/latch).

## Verified MISSING (engine axis) — candidates for Phase-3 expansion waves

| Capability | Verification | Suggested tier |
|---|---|---|
| Sidechain routing (key an FX from another track) | no `sidechain` surface anywhere in `MoshOps.cpp` dispatch | T1 |
| Punch in/out recording | no `punch` surface | T1 |
| Mid-song time-signature changes | `cmdSetTimeSignature` takes only `numerator`/`denominator` — global, no position | T1 |
| MIDI CC / pitch-bend editing | no cc/bend commands; note surface is `add_note`/`set_note`/`remove_note` only | T1 |
| Swing / groove on quantize | `cmdQuantizeNotes` has `division` + `strength` only | T1 |
| Plugin presets (.fxp / named save-load) | no `preset` command surface | T1 |
| Classic markers / locators | `create_section` + `create_annotation` exist (Mosh's idiom — matrix should judge whether they satisfy the capability); no dedicated locator jump-list | T1 (judge) |
| MP3 export | format manager resolves wav/aiff/flac; MP3 absent (licensing posture) | T1 (maybe X) |
| VCA / DCA groups | no surface (group tracks are audio submixes, not VCAs) | T2 |
| MIDI learn | no surface | T2 |
| Per-transient warp markers | whole-clip warp only (documented deferred) | T2 |
| Region-level swipe comping | take-level promote shipped; per-region comp across takes absent | T1/T2 (owner call) |
| Project / track templates | no surface | T2 |
| Input monitoring UI affordance + arm button | native `arm_track`/`set_input_monitor` complete; no UI affordance (the canonical UI-reachability gap — Phase 5 files it) | T0 **UI axis** |

*Dispatch-surface size at verification time: 203 commands (`grep 'if (name == "' src/moshops/MoshOps.cpp`).*
