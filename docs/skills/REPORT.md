# Mosh skills library v1

## Observed result and denominator

**0/40 skills pass the ≥95% reproduction requirement.** Exact command rendering succeeds for 9954/10030 selected rows (99.24%); 0/10030 rows (0.00%) have demonstrated reproduction.

| Training disposition | Rows | Share of the entire training corpus |
|---|---:|---:|
| Reproduced | 0 | 0.00% |
| Selected but failed | 76 | 0.58% |
| Selected but unverified | 9954 | 76.60% |
| Shape outside the selected executable library | 2964 | 22.81% |

Full denominator: **12994 rows**. Missing authentic setup/snapshot/history is explicitly recorded for **9954 selected rows**. A failed schema or rendering row may also lack setup; earlier failure does not establish setup availability. No row was discarded to improve a pass rate.

Reproduction requires authentic starting state, successful ordered execution, and independently observable command effects. A successful response, a matching template, or a mock’s generic ok result is insufficient. Native audio, plugin windows, actual recording, service-generated lyrics, and owner listening are separate acceptance surfaces.

## Step 1: measurements

Base: `0e57fe520d486568e90b674fbc6427e089871f1d`. Counts retain every row and exact ordered command repetition.

| Dataset | Rows | Distinct shapes | Shapes for 50% / 80% / 95% | Shape in training |
|---|---:|---:|---|---|
| s2-mix-v5 | 12994 | 111 | 23 / 42 / 61 | 12994/12994 (100.00%) |
| evalA | 210 | 45 | 18 / 29 / 38 | 207/210 (98.57%) |
| frozen300 | 300 | 5 | 2 / 4 / 4 | 300/300 (100.00%) |

The 40 executable shapes cover **10030/12994 (77.19%)** of training by shape. 250 empty-command rows remain in the denominator and receive no executable skill.

The frozen source contains 2990 rows. Frozen300 uses the evaluator’s stable DJB2-id sort followed by slice(0,300). Selected-ID-list SHA256: `2bec3e0d739b474cd128fee77b06a783188d2657bb5eee1a7ea1cb695a7d2f28`.

### Verified input SHA256

- evalA: `d68ec63696ee1e88c2bb39c7ff21ae98e1dca4b60d9b762a680b33ac4019c911`
- frozen300: `1868ed3153ef7a212c72911f26f8aedb94997eb76e1e45f6df822f65ff9d7a2c`
- train: `3c4e2e8b2ecc3562404fb824aa0b7dd131bd908e936c946cc8d3507adbf071eb`

### Complete original shape rankings

#### Training

| Rank | Exact ordered commands | Rows |
|---:|---|---:|
| 1 | set_tempo | 401 |
| 2 | add_midi_clip | 400 |
| 3 | set_time_signature | 400 |
| 4 | add_note → add_note → add_note → add_note → add_note → add_note → add_note → add_note | 394 |
| 5 | split_clip | 366 |
| 6 | remove_note | 300 |
| 7 | move_clip | 299 |
| 8 | trim_clip | 298 |
| 9 | build_skeleton_from_clip | 292 |
| 10 | duplicate_clip | 276 |
| 11 | move_section | 252 |
| 12 | ∅ (no commands) | 250 |
| 13 | set_key | 248 |
| 14 | set_master_volume | 248 |
| 15 | set_clip_gain | 244 |
| 16 | add_test_tone_clip | 240 |
| 17 | save | 240 |
| 18 | rename_clip | 236 |
| 19 | set_track_type | 236 |
| 20 | redo | 228 |
| 21 | remove_section | 228 |
| 22 | undo | 228 |
| 23 | open_plugin_editor | 224 |
| 24 | set_input_monitor | 224 |
| 25 | set_master_pan | 224 |
| 26 | set_track_pan | 217 |
| 27 | remove_track | 216 |
| 28 | set_clip_mute | 216 |
| 29 | set_metronome | 216 |
| 30 | rename_track | 213 |
| 31 | create_annotation | 212 |
| 32 | create_section | 212 |
| 33 | rename_section | 212 |
| 34 | set_track_volume | 212 |
| 35 | remove_clip | 204 |
| 36 | set_transport | 204 |
| 37 | load_drum_kit | 201 |
| 38 | create_track | 200 |
| 39 | arm_track | 192 |
| 40 | set_track_solo | 189 |
| 41 | set_track_mute | 188 |
| 42 | stop_recording | 176 |
| 43 | freeze_layer | 168 |
| 44 | reject_render | 156 |
| 45 | remove_render_layer | 152 |
| 46 | suggest_next_line | 144 |
| 47 | create_lyric_sheet | 140 |
| 48 | remove_lyric_line | 120 |
| 49 | bounce_layer_to_clip | 116 |
| 50 | bypass_plugin | 116 |
| 51 | create_render_layer → set_render_param → render_layer | 112 |
| 52 | regenerate_lyric | 88 |
| 53 | set_track_type → load_drum_kit | 81 |
| 54 | bypass_layer | 80 |
| 55 | assign_sample | 72 |
| 56 | create_render_layer → render_layer | 72 |
| 57 | fill_lyric_gap | 68 |
| 58 | import_clip | 68 |
| 59 | set_plugin_param | 68 |
| 60 | load_builtin | 64 |
| 61 | create_render_layer → set_render_param | 60 |
| 62 | accept_render | 48 |
| 63 | analyze_lyrics | 48 |
| 64 | complete_lyrics | 48 |
| 65 | create_render_layer | 40 |
| 66 | remove_plugin | 40 |
| 67 | set_lyric_line | 40 |
| 68 | arm_track → set_input_monitor | 32 |
| 69 | sketch_beatbox | 28 |
| 70 | stop_recording → save | 28 |
| 71 | move_clip → trim_clip | 20 |
| 72 | arm_track → arm_track | 16 |
| 73 | duplicate_clip → move_clip | 16 |
| 74 | set_note | 16 |
| 75 | quantize_notes | 12 |
| 76 | render_layer | 12 |
| 77 | set_track_solo → set_track_solo → set_track_solo → set_track_solo | 12 |
| 78 | set_transport → stop_recording | 12 |
| 79 | arm_track → arm_track → arm_track → arm_track | 8 |
| 80 | duplicate_clip → move_clip → move_clip | 8 |
| 81 | set_lyric_constraint | 8 |
| 82 | undo → redo | 8 |
| 83 | set_track_mute → set_track_mute | 5 |
| 84 | arm_track → set_transport | 4 |
| 85 | create_lyric_sheet → complete_lyrics | 4 |
| 86 | create_lyric_sheet → set_lyric_constraint → set_lyric_line → set_lyric_line → set_lyric_line → set_lyric_line | 4 |
| 87 | create_lyric_sheet → set_lyric_line → set_lyric_line | 4 |
| 88 | create_section → set_track_mute | 4 |
| 89 | create_track → create_section | 4 |
| 90 | create_track → load_drum_kit | 4 |
| 91 | duplicate_clip → move_clip → move_clip → move_clip | 4 |
| 92 | load_drum_kit → arm_track | 4 |
| 93 | move_clip → set_clip_gain | 4 |
| 94 | set_master_pan → set_track_pan → set_track_pan → set_track_pan → set_track_pan | 4 |
| 95 | set_master_volume → set_track_volume | 4 |
| 96 | set_metronome → create_annotation | 4 |
| 97 | set_track_type → load_drum_kit → arm_track | 4 |
| 98 | set_transport → set_transport | 4 |
| 99 | sketch_beatbox → move_clip | 4 |
| 100 | sketch_beatbox → set_track_type | 4 |
| 101 | sketch_beatbox → set_transport | 4 |
| 102 | set_note → set_note → set_note → set_note | 3 |
| 103 | add_note → add_note → add_note | 2 |
| 104 | add_note → add_note → add_note → add_note | 2 |
| 105 | add_note → add_note → add_note → add_note → add_note → add_note | 2 |
| 106 | add_note → add_note → add_note → add_note → add_note → add_note → add_note | 2 |
| 107 | load_builtin → set_plugin_param | 1 |
| 108 | load_builtin → set_plugin_param → set_plugin_param | 1 |
| 109 | load_builtin → set_plugin_param → set_plugin_param → set_plugin_param | 1 |
| 110 | load_builtin → set_track_volume | 1 |
| 111 | set_note → set_note → set_note → set_note → set_note → set_note → set_note → set_note | 1 |

#### evalA

| Rank | Exact ordered commands | Rows |
|---:|---|---:|
| 1 | add_midi_clip | 6 |
| 2 | add_note → add_note → add_note → add_note → add_note → add_note → add_note → add_note | 6 |
| 3 | create_annotation | 6 |
| 4 | create_section | 6 |
| 5 | create_track | 6 |
| 6 | move_section | 6 |
| 7 | reject_render | 6 |
| 8 | remove_section | 6 |
| 9 | remove_track | 6 |
| 10 | rename_section | 6 |
| 11 | rename_track | 6 |
| 12 | save | 6 |
| 13 | set_key | 6 |
| 14 | set_master_pan | 6 |
| 15 | set_master_volume | 6 |
| 16 | set_metronome | 6 |
| 17 | set_tempo | 6 |
| 18 | set_time_signature | 6 |
| 19 | set_track_mute | 6 |
| 20 | set_track_pan | 6 |
| 21 | set_track_solo | 6 |
| 22 | set_track_volume | 6 |
| 23 | set_transport | 6 |
| 24 | undo | 6 |
| 25 | arm_track | 5 |
| 26 | build_skeleton_from_clip | 5 |
| 27 | stop_recording | 5 |
| 28 | suggest_next_line | 5 |
| 29 | bypass_plugin | 4 |
| 30 | load_drum_kit | 4 |
| 31 | redo | 4 |
| 32 | remove_note | 4 |
| 33 | render_layer | 4 |
| 34 | set_track_type | 4 |
| 35 | set_track_type → load_drum_kit | 4 |
| 36 | assign_sample | 3 |
| 37 | remove_plugin | 3 |
| 38 | set_input_monitor | 3 |
| 39 | create_render_layer | 2 |
| 40 | set_note | 2 |
| 41 | arm_track → set_input_monitor | 1 |
| 42 | create_track → sketch_beatbox | 1 |
| 43 | set_render_param | 1 |
| 44 | sketch_beatbox → set_tempo | 1 |
| 45 | stop_recording → save | 1 |

#### frozen300

| Rank | Exact ordered commands | Rows |
|---:|---|---:|
| 1 | add_midi_clip | 79 |
| 2 | add_note → add_note → add_note → add_note → add_note → add_note → add_note → add_note | 78 |
| 3 | set_tempo | 75 |
| 4 | set_time_signature | 67 |
| 5 | add_note → add_note → add_note | 1 |


## Skill-by-skill validation

Pass requires reproduced rows / every provenance row ≥95%. Exact rendering alone does not pass a skill; failed and unverified rows remain in its denominator.

| Rank | Skill artifact | Rows | Exact render | Reproduced | Failed | Unverified | Reproduction rate | Pass ≥95% | Undo mode |
|---:|---|---:|---:|---:|---:|---:|---:|---|---|
| 1 | [sft-01-set-tempo](../../skills/sft-01-set-tempo.json) | 401 | 401 | 0 | 0 | 401 | 0.00% | NO | per_mutation |
| 2 | [sft-02-add-midi-clip](../../skills/sft-02-add-midi-clip.json) | 400 | 400 | 0 | 0 | 400 | 0.00% | NO | per_mutation |
| 3 | [sft-03-set-time-signature](../../skills/sft-03-set-time-signature.json) | 400 | 400 | 0 | 0 | 400 | 0.00% | NO | per_mutation |
| 4 | [sft-04-add-note-8](../../skills/sft-04-add-note-8.json) | 394 | 394 | 0 | 0 | 394 | 0.00% | NO | per_mutation |
| 5 | [sft-05-split-clip](../../skills/sft-05-split-clip.json) | 366 | 366 | 0 | 0 | 366 | 0.00% | NO | per_mutation |
| 6 | [sft-06-remove-note](../../skills/sft-06-remove-note.json) | 300 | 300 | 0 | 0 | 300 | 0.00% | NO | per_mutation |
| 7 | [sft-07-move-clip](../../skills/sft-07-move-clip.json) | 299 | 299 | 0 | 0 | 299 | 0.00% | NO | per_mutation |
| 8 | [sft-08-trim-clip](../../skills/sft-08-trim-clip.json) | 298 | 298 | 0 | 0 | 298 | 0.00% | NO | per_mutation |
| 9 | [sft-09-build-skeleton-from-clip](../../skills/sft-09-build-skeleton-from-clip.json) | 292 | 252 | 0 | 40 | 252 | 0.00% | NO | per_mutation |
| 10 | [sft-10-duplicate-clip](../../skills/sft-10-duplicate-clip.json) | 276 | 276 | 0 | 0 | 276 | 0.00% | NO | per_mutation |
| 11 | [sft-11-move-section](../../skills/sft-11-move-section.json) | 252 | 252 | 0 | 0 | 252 | 0.00% | NO | per_mutation |
| 12 | [sft-12-set-key](../../skills/sft-12-set-key.json) | 248 | 248 | 0 | 0 | 248 | 0.00% | NO | none |
| 13 | [sft-13-set-master-volume](../../skills/sft-13-set-master-volume.json) | 248 | 244 | 0 | 4 | 244 | 0.00% | NO | per_mutation |
| 14 | [sft-14-set-clip-gain](../../skills/sft-14-set-clip-gain.json) | 244 | 244 | 0 | 0 | 244 | 0.00% | NO | per_mutation |
| 15 | [sft-15-add-test-tone-clip](../../skills/sft-15-add-test-tone-clip.json) | 240 | 240 | 0 | 0 | 240 | 0.00% | NO | per_mutation |
| 16 | [sft-16-save](../../skills/sft-16-save.json) | 240 | 240 | 0 | 0 | 240 | 0.00% | NO | none |
| 17 | [sft-17-rename-clip](../../skills/sft-17-rename-clip.json) | 236 | 236 | 0 | 0 | 236 | 0.00% | NO | per_mutation |
| 18 | [sft-18-set-track-type](../../skills/sft-18-set-track-type.json) | 236 | 236 | 0 | 0 | 236 | 0.00% | NO | per_mutation |
| 19 | [sft-19-redo](../../skills/sft-19-redo.json) | 228 | 228 | 0 | 0 | 228 | 0.00% | NO | history |
| 20 | [sft-20-remove-section](../../skills/sft-20-remove-section.json) | 228 | 228 | 0 | 0 | 228 | 0.00% | NO | per_mutation |
| 21 | [sft-21-undo](../../skills/sft-21-undo.json) | 228 | 228 | 0 | 0 | 228 | 0.00% | NO | history |
| 22 | [sft-22-open-plugin-editor](../../skills/sft-22-open-plugin-editor.json) | 224 | 224 | 0 | 0 | 224 | 0.00% | NO | none |
| 23 | [sft-23-set-input-monitor](../../skills/sft-23-set-input-monitor.json) | 224 | 224 | 0 | 0 | 224 | 0.00% | NO | none |
| 24 | [sft-24-set-master-pan](../../skills/sft-24-set-master-pan.json) | 224 | 224 | 0 | 0 | 224 | 0.00% | NO | per_mutation |
| 25 | [sft-25-set-track-pan](../../skills/sft-25-set-track-pan.json) | 217 | 217 | 0 | 0 | 217 | 0.00% | NO | per_mutation |
| 26 | [sft-26-remove-track](../../skills/sft-26-remove-track.json) | 216 | 216 | 0 | 0 | 216 | 0.00% | NO | per_mutation |
| 27 | [sft-27-set-clip-mute](../../skills/sft-27-set-clip-mute.json) | 216 | 216 | 0 | 0 | 216 | 0.00% | NO | per_mutation |
| 28 | [sft-28-set-metronome](../../skills/sft-28-set-metronome.json) | 216 | 216 | 0 | 0 | 216 | 0.00% | NO | none |
| 29 | [sft-29-rename-track](../../skills/sft-29-rename-track.json) | 213 | 213 | 0 | 0 | 213 | 0.00% | NO | per_mutation |
| 30 | [sft-30-create-annotation](../../skills/sft-30-create-annotation.json) | 212 | 212 | 0 | 0 | 212 | 0.00% | NO | per_mutation |
| 31 | [sft-31-create-section](../../skills/sft-31-create-section.json) | 212 | 212 | 0 | 0 | 212 | 0.00% | NO | per_mutation |
| 32 | [sft-32-rename-section](../../skills/sft-32-rename-section.json) | 212 | 212 | 0 | 0 | 212 | 0.00% | NO | per_mutation |
| 33 | [sft-33-set-track-volume](../../skills/sft-33-set-track-volume.json) | 212 | 212 | 0 | 0 | 212 | 0.00% | NO | per_mutation |
| 34 | [sft-34-remove-clip](../../skills/sft-34-remove-clip.json) | 204 | 204 | 0 | 0 | 204 | 0.00% | NO | per_mutation |
| 35 | [sft-35-set-transport](../../skills/sft-35-set-transport.json) | 204 | 172 | 0 | 32 | 172 | 0.00% | NO | none |
| 36 | [sft-36-load-drum-kit](../../skills/sft-36-load-drum-kit.json) | 201 | 201 | 0 | 0 | 201 | 0.00% | NO | per_mutation |
| 37 | [sft-37-create-track](../../skills/sft-37-create-track.json) | 200 | 200 | 0 | 0 | 200 | 0.00% | NO | per_mutation |
| 38 | [sft-38-arm-track](../../skills/sft-38-arm-track.json) | 192 | 192 | 0 | 0 | 192 | 0.00% | NO | none |
| 39 | [sft-39-set-track-solo](../../skills/sft-39-set-track-solo.json) | 189 | 189 | 0 | 0 | 189 | 0.00% | NO | per_mutation |
| 40 | [sft-40-set-track-mute](../../skills/sft-40-set-track-mute.json) | 188 | 188 | 0 | 0 | 188 | 0.00% | NO | per_mutation |

## Owner-authored musical values

**54 slots in 17 skills** carry `NEEDS_OWNER_VALUE`. These markers are rejected by rendering. A training minimum, median, or maximum describes evidence and is never an audible recommendation or a substitute for an owner-supplied value.

Statistics below are per distinct generated slot, preserving its original row weighting. Medians are not averaged across skills or notes. Bounds come from the cited native handler; absent bounds mean no fixed range was established there.

| Skill | Slot | Unit | Training min | Training median | Training max | Native bounds | Native source |
|---|---|---|---:|---:|---:|---|---|
| sft-01-set-tempo | step1_bpm | BPM | 30 | 118 | 350 | 20 … 999 | [source](../../src/moshops/MoshOps.TempoProject.cpp#L180) |
| sft-02-add-midi-clip | step1_length | seconds | 1.5225694444444446 | 159.0087470728502 | 1881.25 | not fixed … not fixed | [source](../../src/moshops/MoshOps.cpp#L1847) |
| sft-02-add-midi-clip | step1_start | seconds | 0 | 0 | 0 | not fixed … not fixed | [source](../../src/moshops/MoshOps.cpp#L1846) |
| sft-03-set-time-signature | step1_denominator | note-value denominator | 2 | 4 | 16 | 1 … 32 | [source](../../src/moshops/MoshOps.TempoProject.cpp#L196) |
| sft-03-set-time-signature | step1_numerator | beats per bar | 1 | 4 | 12 | 1 … 32 | [source](../../src/moshops/MoshOps.TempoProject.cpp#L195) |
| sft-04-add-note-8 | step1_length | beats | 0.0625 | 0.47395833333333337 | 21.916666666666668 | 0.0625 … not fixed | [source](../../src/moshops/MoshOps.cpp#L2477) |
| sft-04-add-note-8 | step1_pitch | MIDI note number | 0 | 60 | 91 | 0 … 127 | [source](../../src/moshops/MoshOps.cpp#L2475) |
| sft-04-add-note-8 | step1_start | beats | 0 | 4 | 372 | 0 … not fixed | [source](../../src/moshops/MoshOps.cpp#L2476) |
| sft-04-add-note-8 | step1_velocity | MIDI velocity | 1 | 99 | 127 | 1 … 127 | [source](../../src/moshops/MoshOps.cpp#L2478) |
| sft-04-add-note-8 | step2_length | beats | 0.0625 | 0.40885416666666663 | 8 | 0.0625 … not fixed | [source](../../src/moshops/MoshOps.cpp#L2477) |
| sft-04-add-note-8 | step2_pitch | MIDI note number | 26 | 60.5 | 91 | 0 … 127 | [source](../../src/moshops/MoshOps.cpp#L2475) |
| sft-04-add-note-8 | step2_start | beats | 0 | 4.923177083333334 | 375 | 0 … not fixed | [source](../../src/moshops/MoshOps.cpp#L2476) |
| sft-04-add-note-8 | step2_velocity | MIDI velocity | 1 | 98 | 127 | 1 … 127 | [source](../../src/moshops/MoshOps.cpp#L2478) |
| sft-04-add-note-8 | step3_length | beats | 0.0625 | 0.3958333333333333 | 8.06875 | 0.0625 … not fixed | [source](../../src/moshops/MoshOps.cpp#L2477) |
| sft-04-add-note-8 | step3_pitch | MIDI note number | 24 | 61.5 | 103 | 0 … 127 | [source](../../src/moshops/MoshOps.cpp#L2475) |
| sft-04-add-note-8 | step3_start | beats | 0 | 6 | 375.5 | 0 … not fixed | [source](../../src/moshops/MoshOps.cpp#L2476) |
| sft-04-add-note-8 | step3_velocity | MIDI velocity | 1 | 95 | 127 | 1 … 127 | [source](../../src/moshops/MoshOps.cpp#L2478) |
| sft-04-add-note-8 | step4_length | beats | 0.0625 | 0.4375 | 23.958333333333332 | 0.0625 … not fixed | [source](../../src/moshops/MoshOps.cpp#L2477) |
| sft-04-add-note-8 | step4_pitch | MIDI note number | 28 | 62 | 93 | 0 … 127 | [source](../../src/moshops/MoshOps.cpp#L2475) |
| sft-04-add-note-8 | step4_start | beats | 0 | 7 | 376 | 0 … not fixed | [source](../../src/moshops/MoshOps.cpp#L2476) |
| sft-04-add-note-8 | step4_velocity | MIDI velocity | 1 | 97 | 127 | 1 … 127 | [source](../../src/moshops/MoshOps.cpp#L2478) |
| sft-04-add-note-8 | step5_length | beats | 0.0625 | 0.4166666666666667 | 15.989583333333334 | 0.0625 … not fixed | [source](../../src/moshops/MoshOps.cpp#L2477) |
| sft-04-add-note-8 | step5_pitch | MIDI note number | 28 | 61 | 113 | 0 … 127 | [source](../../src/moshops/MoshOps.cpp#L2475) |
| sft-04-add-note-8 | step5_start | beats | 0 | 7.775 | 384 | 0 … not fixed | [source](../../src/moshops/MoshOps.cpp#L2476) |
| sft-04-add-note-8 | step5_velocity | MIDI velocity | 1 | 95 | 127 | 1 … 127 | [source](../../src/moshops/MoshOps.cpp#L2478) |
| sft-04-add-note-8 | step6_length | beats | 0.0625 | 0.4166666666666667 | 15.989583333333334 | 0.0625 … not fixed | [source](../../src/moshops/MoshOps.cpp#L2477) |
| sft-04-add-note-8 | step6_pitch | MIDI note number | 24 | 62 | 113 | 0 … 127 | [source](../../src/moshops/MoshOps.cpp#L2475) |
| sft-04-add-note-8 | step6_start | beats | 0 | 8 | 392 | 0 … not fixed | [source](../../src/moshops/MoshOps.cpp#L2476) |
| sft-04-add-note-8 | step6_velocity | MIDI velocity | 1 | 96 | 127 | 1 … 127 | [source](../../src/moshops/MoshOps.cpp#L2478) |
| sft-04-add-note-8 | step7_length | beats | 0.0625 | 0.44375 | 15.989583333333334 | 0.0625 … not fixed | [source](../../src/moshops/MoshOps.cpp#L2477) |
| sft-04-add-note-8 | step7_pitch | MIDI note number | 27 | 62 | 91 | 0 … 127 | [source](../../src/moshops/MoshOps.cpp#L2475) |
| sft-04-add-note-8 | step7_start | beats | 0.5 | 8.5 | 398 | 0 … not fixed | [source](../../src/moshops/MoshOps.cpp#L2476) |
| sft-04-add-note-8 | step7_velocity | MIDI velocity | 1 | 95 | 127 | 1 … 127 | [source](../../src/moshops/MoshOps.cpp#L2478) |
| sft-04-add-note-8 | step8_length | beats | 0.0625 | 0.4166666666666667 | 15.989583333333334 | 0.0625 … not fixed | [source](../../src/moshops/MoshOps.cpp#L2477) |
| sft-04-add-note-8 | step8_pitch | MIDI note number | 28 | 62 | 96 | 0 … 127 | [source](../../src/moshops/MoshOps.cpp#L2475) |
| sft-04-add-note-8 | step8_start | beats | 0 | 9.109375 | 399.5 | 0 … not fixed | [source](../../src/moshops/MoshOps.cpp#L2476) |
| sft-04-add-note-8 | step8_velocity | MIDI velocity | 1 | 96 | 127 | 1 … 127 | [source](../../src/moshops/MoshOps.cpp#L2478) |
| sft-05-split-clip | step1_time | seconds | 1 | 5.5 | 14 | not fixed … not fixed | [source](../../src/moshops/MoshOps.Clips.cpp#L460) |
| sft-07-move-clip | step1_start | seconds | 0 | 4 | 16 | 0 … not fixed | [source](../../src/moshops/MoshOps.Clips.cpp#L374) |
| sft-08-trim-clip | step1_length | seconds | 1 | 5 | 24 | 0.01 … not fixed | [source](../../src/moshops/MoshOps.Clips.cpp#L416) |
| sft-08-trim-clip | step1_start | seconds | 0 | 1 | 12 | not fixed … not fixed | [source](../../src/moshops/MoshOps.Clips.cpp#L415) |
| sft-11-move-section | step1_endBeat | beats | 4 | 24 | 48 | not fixed … not fixed | [source](../../src/moshops/MoshOps.Notes.cpp#L161) |
| sft-11-move-section | step1_startBeat | beats | 0 | 5 | 32 | not fixed … not fixed | [source](../../src/moshops/MoshOps.Notes.cpp#L160) |
| sft-13-set-master-volume | step1_db | dB | -100 | -3 | 4 | -48 … 6 | [source](../../src/moshops/MoshOps.Mixer.cpp#L381) |
| sft-14-set-clip-gain | step1_gainDb | dB | -7 | -1 | 6 | -48 … 24 | [source](../../src/moshops/MoshOps.Clips.cpp#L745) |
| sft-15-add-test-tone-clip | step1_freq | Hz | 0 | 440 | 1000 | not fixed … not fixed | [source](../../src/moshops/MoshOps.Clips.cpp#L321) |
| sft-15-add-test-tone-clip | step1_seconds | seconds | 0 | 1 | 5 | not fixed … not fixed | [source](../../src/moshops/MoshOps.Clips.cpp#L320) |
| sft-24-set-master-pan | step1_pan | pan | -1 | 0 | 1 | -1 … 1 | [source](../../src/moshops/MoshOps.Mixer.cpp#L394) |
| sft-25-set-track-pan | step1_pan | pan | -1 | 0 | 1 | -1 … 1 | [source](../../src/moshops/MoshOps.Tracks.cpp#L923) |
| sft-30-create-annotation | step1_beat | beats | 0 | 7 | 15 | not fixed … not fixed | [source](../../src/moshops/MoshOps.Notes.cpp#L576) |
| sft-31-create-section | step1_endBeat | beats | 4 | 32 | 88 | not fixed … not fixed | [source](../../src/moshops/MoshOps.Notes.cpp#L122) |
| sft-31-create-section | step1_startBeat | beats | 0 | 24 | 80 | not fixed … not fixed | [source](../../src/moshops/MoshOps.Notes.cpp#L121) |
| sft-33-set-track-volume | step1_db | dB | -96 | -4 | 4 | not fixed … not fixed | [source](../../src/moshops/MoshOps.Tracks.cpp#L892) |
| sft-35-set-transport | step1_position | seconds | 0 | 0 | 16 | not fixed … not fixed | [source](../../src/moshops/MoshOps.TempoProject.cpp#L158) |

## Training rows without demonstrated reproduction

Every original training shape appears below, including selected shapes with failed or unverified rows. The ID links lead to the exhaustive original row lists; selected row outcomes and reasons are in [row-validation.jsonl](row-validation.jsonl). Shape matches are not treated as successful reproduction.

| Training rank | Exact ordered shape | All rows | Unselected | Failed | Unverified | Reproduced | Exhaustive IDs |
|---:|---|---:|---:|---:|---:|---:|---|
| 1 | set_tempo | 401 | 0 | 0 | 401 | 0 | [train[0].rows](shapes.json) |
| 2 | add_midi_clip | 400 | 0 | 0 | 400 | 0 | [train[1].rows](shapes.json) |
| 3 | set_time_signature | 400 | 0 | 0 | 400 | 0 | [train[2].rows](shapes.json) |
| 4 | add_note → add_note → add_note → add_note → add_note → add_note → add_note → add_note | 394 | 0 | 0 | 394 | 0 | [train[3].rows](shapes.json) |
| 5 | split_clip | 366 | 0 | 0 | 366 | 0 | [train[4].rows](shapes.json) |
| 6 | remove_note | 300 | 0 | 0 | 300 | 0 | [train[5].rows](shapes.json) |
| 7 | move_clip | 299 | 0 | 0 | 299 | 0 | [train[6].rows](shapes.json) |
| 8 | trim_clip | 298 | 0 | 0 | 298 | 0 | [train[7].rows](shapes.json) |
| 9 | build_skeleton_from_clip | 292 | 0 | 40 | 252 | 0 | [train[8].rows](shapes.json) |
| 10 | duplicate_clip | 276 | 0 | 0 | 276 | 0 | [train[9].rows](shapes.json) |
| 11 | move_section | 252 | 0 | 0 | 252 | 0 | [train[10].rows](shapes.json) |
| 12 | ∅ (no commands) | 250 | 250 | 0 | 0 | 0 | [train[11].rows](shapes.json) |
| 13 | set_key | 248 | 0 | 0 | 248 | 0 | [train[12].rows](shapes.json) |
| 14 | set_master_volume | 248 | 0 | 4 | 244 | 0 | [train[13].rows](shapes.json) |
| 15 | set_clip_gain | 244 | 0 | 0 | 244 | 0 | [train[14].rows](shapes.json) |
| 16 | add_test_tone_clip | 240 | 0 | 0 | 240 | 0 | [train[15].rows](shapes.json) |
| 17 | save | 240 | 0 | 0 | 240 | 0 | [train[16].rows](shapes.json) |
| 18 | rename_clip | 236 | 0 | 0 | 236 | 0 | [train[17].rows](shapes.json) |
| 19 | set_track_type | 236 | 0 | 0 | 236 | 0 | [train[18].rows](shapes.json) |
| 20 | redo | 228 | 0 | 0 | 228 | 0 | [train[19].rows](shapes.json) |
| 21 | remove_section | 228 | 0 | 0 | 228 | 0 | [train[20].rows](shapes.json) |
| 22 | undo | 228 | 0 | 0 | 228 | 0 | [train[21].rows](shapes.json) |
| 23 | open_plugin_editor | 224 | 0 | 0 | 224 | 0 | [train[22].rows](shapes.json) |
| 24 | set_input_monitor | 224 | 0 | 0 | 224 | 0 | [train[23].rows](shapes.json) |
| 25 | set_master_pan | 224 | 0 | 0 | 224 | 0 | [train[24].rows](shapes.json) |
| 26 | set_track_pan | 217 | 0 | 0 | 217 | 0 | [train[25].rows](shapes.json) |
| 27 | remove_track | 216 | 0 | 0 | 216 | 0 | [train[26].rows](shapes.json) |
| 28 | set_clip_mute | 216 | 0 | 0 | 216 | 0 | [train[27].rows](shapes.json) |
| 29 | set_metronome | 216 | 0 | 0 | 216 | 0 | [train[28].rows](shapes.json) |
| 30 | rename_track | 213 | 0 | 0 | 213 | 0 | [train[29].rows](shapes.json) |
| 31 | create_annotation | 212 | 0 | 0 | 212 | 0 | [train[30].rows](shapes.json) |
| 32 | create_section | 212 | 0 | 0 | 212 | 0 | [train[31].rows](shapes.json) |
| 33 | rename_section | 212 | 0 | 0 | 212 | 0 | [train[32].rows](shapes.json) |
| 34 | set_track_volume | 212 | 0 | 0 | 212 | 0 | [train[33].rows](shapes.json) |
| 35 | remove_clip | 204 | 0 | 0 | 204 | 0 | [train[34].rows](shapes.json) |
| 36 | set_transport | 204 | 0 | 32 | 172 | 0 | [train[35].rows](shapes.json) |
| 37 | load_drum_kit | 201 | 0 | 0 | 201 | 0 | [train[36].rows](shapes.json) |
| 38 | create_track | 200 | 0 | 0 | 200 | 0 | [train[37].rows](shapes.json) |
| 39 | arm_track | 192 | 0 | 0 | 192 | 0 | [train[38].rows](shapes.json) |
| 40 | set_track_solo | 189 | 0 | 0 | 189 | 0 | [train[39].rows](shapes.json) |
| 41 | set_track_mute | 188 | 0 | 0 | 188 | 0 | [train[40].rows](shapes.json) |
| 42 | stop_recording | 176 | 176 | 0 | 0 | 0 | [train[41].rows](shapes.json) |
| 43 | freeze_layer | 168 | 168 | 0 | 0 | 0 | [train[42].rows](shapes.json) |
| 44 | reject_render | 156 | 156 | 0 | 0 | 0 | [train[43].rows](shapes.json) |
| 45 | remove_render_layer | 152 | 152 | 0 | 0 | 0 | [train[44].rows](shapes.json) |
| 46 | suggest_next_line | 144 | 144 | 0 | 0 | 0 | [train[45].rows](shapes.json) |
| 47 | create_lyric_sheet | 140 | 140 | 0 | 0 | 0 | [train[46].rows](shapes.json) |
| 48 | remove_lyric_line | 120 | 120 | 0 | 0 | 0 | [train[47].rows](shapes.json) |
| 49 | bounce_layer_to_clip | 116 | 116 | 0 | 0 | 0 | [train[48].rows](shapes.json) |
| 50 | bypass_plugin | 116 | 116 | 0 | 0 | 0 | [train[49].rows](shapes.json) |
| 51 | create_render_layer → set_render_param → render_layer | 112 | 112 | 0 | 0 | 0 | [train[50].rows](shapes.json) |
| 52 | regenerate_lyric | 88 | 88 | 0 | 0 | 0 | [train[51].rows](shapes.json) |
| 53 | set_track_type → load_drum_kit | 81 | 81 | 0 | 0 | 0 | [train[52].rows](shapes.json) |
| 54 | bypass_layer | 80 | 80 | 0 | 0 | 0 | [train[53].rows](shapes.json) |
| 55 | assign_sample | 72 | 72 | 0 | 0 | 0 | [train[54].rows](shapes.json) |
| 56 | create_render_layer → render_layer | 72 | 72 | 0 | 0 | 0 | [train[55].rows](shapes.json) |
| 57 | fill_lyric_gap | 68 | 68 | 0 | 0 | 0 | [train[56].rows](shapes.json) |
| 58 | import_clip | 68 | 68 | 0 | 0 | 0 | [train[57].rows](shapes.json) |
| 59 | set_plugin_param | 68 | 68 | 0 | 0 | 0 | [train[58].rows](shapes.json) |
| 60 | load_builtin | 64 | 64 | 0 | 0 | 0 | [train[59].rows](shapes.json) |
| 61 | create_render_layer → set_render_param | 60 | 60 | 0 | 0 | 0 | [train[60].rows](shapes.json) |
| 62 | accept_render | 48 | 48 | 0 | 0 | 0 | [train[61].rows](shapes.json) |
| 63 | analyze_lyrics | 48 | 48 | 0 | 0 | 0 | [train[62].rows](shapes.json) |
| 64 | complete_lyrics | 48 | 48 | 0 | 0 | 0 | [train[63].rows](shapes.json) |
| 65 | create_render_layer | 40 | 40 | 0 | 0 | 0 | [train[64].rows](shapes.json) |
| 66 | remove_plugin | 40 | 40 | 0 | 0 | 0 | [train[65].rows](shapes.json) |
| 67 | set_lyric_line | 40 | 40 | 0 | 0 | 0 | [train[66].rows](shapes.json) |
| 68 | arm_track → set_input_monitor | 32 | 32 | 0 | 0 | 0 | [train[67].rows](shapes.json) |
| 69 | sketch_beatbox | 28 | 28 | 0 | 0 | 0 | [train[68].rows](shapes.json) |
| 70 | stop_recording → save | 28 | 28 | 0 | 0 | 0 | [train[69].rows](shapes.json) |
| 71 | move_clip → trim_clip | 20 | 20 | 0 | 0 | 0 | [train[70].rows](shapes.json) |
| 72 | arm_track → arm_track | 16 | 16 | 0 | 0 | 0 | [train[71].rows](shapes.json) |
| 73 | duplicate_clip → move_clip | 16 | 16 | 0 | 0 | 0 | [train[72].rows](shapes.json) |
| 74 | set_note | 16 | 16 | 0 | 0 | 0 | [train[73].rows](shapes.json) |
| 75 | quantize_notes | 12 | 12 | 0 | 0 | 0 | [train[74].rows](shapes.json) |
| 76 | render_layer | 12 | 12 | 0 | 0 | 0 | [train[75].rows](shapes.json) |
| 77 | set_track_solo → set_track_solo → set_track_solo → set_track_solo | 12 | 12 | 0 | 0 | 0 | [train[76].rows](shapes.json) |
| 78 | set_transport → stop_recording | 12 | 12 | 0 | 0 | 0 | [train[77].rows](shapes.json) |
| 79 | arm_track → arm_track → arm_track → arm_track | 8 | 8 | 0 | 0 | 0 | [train[78].rows](shapes.json) |
| 80 | duplicate_clip → move_clip → move_clip | 8 | 8 | 0 | 0 | 0 | [train[79].rows](shapes.json) |
| 81 | set_lyric_constraint | 8 | 8 | 0 | 0 | 0 | [train[80].rows](shapes.json) |
| 82 | undo → redo | 8 | 8 | 0 | 0 | 0 | [train[81].rows](shapes.json) |
| 83 | set_track_mute → set_track_mute | 5 | 5 | 0 | 0 | 0 | [train[82].rows](shapes.json) |
| 84 | arm_track → set_transport | 4 | 4 | 0 | 0 | 0 | [train[83].rows](shapes.json) |
| 85 | create_lyric_sheet → complete_lyrics | 4 | 4 | 0 | 0 | 0 | [train[84].rows](shapes.json) |
| 86 | create_lyric_sheet → set_lyric_constraint → set_lyric_line → set_lyric_line → set_lyric_line → set_lyric_line | 4 | 4 | 0 | 0 | 0 | [train[85].rows](shapes.json) |
| 87 | create_lyric_sheet → set_lyric_line → set_lyric_line | 4 | 4 | 0 | 0 | 0 | [train[86].rows](shapes.json) |
| 88 | create_section → set_track_mute | 4 | 4 | 0 | 0 | 0 | [train[87].rows](shapes.json) |
| 89 | create_track → create_section | 4 | 4 | 0 | 0 | 0 | [train[88].rows](shapes.json) |
| 90 | create_track → load_drum_kit | 4 | 4 | 0 | 0 | 0 | [train[89].rows](shapes.json) |
| 91 | duplicate_clip → move_clip → move_clip → move_clip | 4 | 4 | 0 | 0 | 0 | [train[90].rows](shapes.json) |
| 92 | load_drum_kit → arm_track | 4 | 4 | 0 | 0 | 0 | [train[91].rows](shapes.json) |
| 93 | move_clip → set_clip_gain | 4 | 4 | 0 | 0 | 0 | [train[92].rows](shapes.json) |
| 94 | set_master_pan → set_track_pan → set_track_pan → set_track_pan → set_track_pan | 4 | 4 | 0 | 0 | 0 | [train[93].rows](shapes.json) |
| 95 | set_master_volume → set_track_volume | 4 | 4 | 0 | 0 | 0 | [train[94].rows](shapes.json) |
| 96 | set_metronome → create_annotation | 4 | 4 | 0 | 0 | 0 | [train[95].rows](shapes.json) |
| 97 | set_track_type → load_drum_kit → arm_track | 4 | 4 | 0 | 0 | 0 | [train[96].rows](shapes.json) |
| 98 | set_transport → set_transport | 4 | 4 | 0 | 0 | 0 | [train[97].rows](shapes.json) |
| 99 | sketch_beatbox → move_clip | 4 | 4 | 0 | 0 | 0 | [train[98].rows](shapes.json) |
| 100 | sketch_beatbox → set_track_type | 4 | 4 | 0 | 0 | 0 | [train[99].rows](shapes.json) |
| 101 | sketch_beatbox → set_transport | 4 | 4 | 0 | 0 | 0 | [train[100].rows](shapes.json) |
| 102 | set_note → set_note → set_note → set_note | 3 | 3 | 0 | 0 | 0 | [train[101].rows](shapes.json) |
| 103 | add_note → add_note → add_note | 2 | 2 | 0 | 0 | 0 | [train[102].rows](shapes.json) |
| 104 | add_note → add_note → add_note → add_note | 2 | 2 | 0 | 0 | 0 | [train[103].rows](shapes.json) |
| 105 | add_note → add_note → add_note → add_note → add_note → add_note | 2 | 2 | 0 | 0 | 0 | [train[104].rows](shapes.json) |
| 106 | add_note → add_note → add_note → add_note → add_note → add_note → add_note | 2 | 2 | 0 | 0 | 0 | [train[105].rows](shapes.json) |
| 107 | load_builtin → set_plugin_param | 1 | 1 | 0 | 0 | 0 | [train[106].rows](shapes.json) |
| 108 | load_builtin → set_plugin_param → set_plugin_param | 1 | 1 | 0 | 0 | 0 | [train[107].rows](shapes.json) |
| 109 | load_builtin → set_plugin_param → set_plugin_param → set_plugin_param | 1 | 1 | 0 | 0 | 0 | [train[108].rows](shapes.json) |
| 110 | load_builtin → set_track_volume | 1 | 1 | 0 | 0 | 0 | [train[109].rows](shapes.json) |
| 111 | set_note → set_note → set_note → set_note → set_note → set_note → set_note → set_note | 1 | 1 | 0 | 0 | 0 | [train[110].rows](shapes.json) |

## Corpus defects and native-contract differences

The measurement pass found **4 HUH rows with executable commands**, at original training lines 3672, 11970, 11971, and 11972. They remain in the full denominator. Their immutable provenance IDs are:

- `sha256:3c4e2e8b2ecc3562404fb824aa0b7dd131bd908e936c946cc8d3507adbf071eb#L3672`
- `sha256:3c4e2e8b2ecc3562404fb824aa0b7dd131bd908e936c946cc8d3507adbf071eb#L11970`
- `sha256:3c4e2e8b2ecc3562404fb824aa0b7dd131bd908e936c946cc8d3507adbf071eb#L11971`
- `sha256:3c4e2e8b2ecc3562404fb824aa0b7dd131bd908e936c946cc8d3507adbf071eb#L11972`

Selected-row failures are retained without coercing null to absence, silently clamping a gold value, or rewriting an unsupported action:

| Observed corpus defect | Affected rows | Treatment |
|---|---:|---|
| Explicit null skeleton grid | 40 | A present null does not satisfy the string slot; the row fails exact rendering. |
| Master-volume db = -100 | 4 | Native master range is -48..6 dB; preserving the gold value fails bounded rendering. |
| Transport action = seek | 32 | Native seeks through position; seek is not a recognized action choice. It is not rewritten. |

The [whole-corpus audit](corpus-audit.json) covers all 12994 training rows and records 88 rows with native-name, HUH, or explicit-null issues. It also records 9 unresolved native handler extractions. Unresolved extraction is an evidence limitation, not proof that the native command is unsupported. The artifact includes exhaustive row IDs, command shapes, reasons, and extraction diagnostics; this is not a complete semantic corpus audit.

| Whole-corpus audit detail | Distinct rows | Diagnostic occurrences |
|---|---:|---:|
| Skeleton wait is explicitly null (overlaps null-grid rows) | 32 | 32 |
| Unselected sketch_beatbox.bars is explicitly null | 16 | 16 |
| Unselected create_lyric_sheet.sectionId is an unknown native argument | 4 | 4 |
| Unselected set_lyric_constraint.sectionId is an unknown native argument | 4 | 4 |
| Unselected set_note has unresolved extraction, not proven native incompatibility | 20 | 72 |

Rows and diagnostic occurrences are different units; one row may have several steps or overlapping defects. The counts above must not be added to obtain a unique-row total.

Source disagreements and deliberately narrower catalog declarations:

- The [documented transport action list](../02_MOSHOPS_CONTRACT.md#L41) omits continue, to_start, and to_end, all handled by [native transport](../../src/moshops/MoshOps.TempoProject.cpp#L54) and its [navigation branches](../../src/moshops/MoshOps.TempoProject.cpp#L148).
- The [agent catalog](../../ui/src/agent/commands.ts#L124) describes note velocity as 0..127; the [native add-note handler](../../src/moshops/MoshOps.cpp#L2478) clamps it to 1..127.
- The [catalog’s transport choices](../../ui/src/agent/commands.ts#L172) omit continue, which the [native transport handler](../../src/moshops/MoshOps.TempoProject.cpp#L54) handles. Position is the seek field.
- The [catalog’s skeleton description](../../ui/src/agent/commands.ts#L280) says no words; [native extraction](../../src/moshops/MoshOps.Lyrics.cpp#L835) can retain sung words verbatim.
- The [catalog’s ripple hint](../../ui/src/agent/commands.ts#L73) excludes trackId generally; the [native restriction](../../src/moshops/MoshOps.Clips.cpp#L368) rejects a resolved different destination.
- Native defaults may depend on state: [trim](../../src/moshops/MoshOps.Clips.cpp#L415) retains omitted values; [MIDI-clip creation](../../src/moshops/MoshOps.cpp#L1824) can create a track. An unavailable snapshot never becomes an invented constant.
- The [track-fader handler](../../src/moshops/MoshOps.Tracks.cpp#L892) does not apply its linked-followers’ -70..6 dB clamp to the selected-track input. The [master fader](../../src/moshops/MoshOps.Mixer.cpp#L381) has its own -48..6 dB clamp.

## Authentic setup recovery

Recorded evidence: [setup-recovery.json](setup-recovery.json).

```json
{
  "authenticSetupsRecovered": 0,
  "selectedRows": 10030,
  "status": "unverified",
  "reason": "Prepared rows retain messages only; shortened Current session text does not preserve original snapshots, notes, plugins, history, or setup commands.",
  "searched": [
    "service/sft/.sft-data/s2-mix-v5-prep/train.jsonl",
    "~/Library/Mosh/sft-data-durable/train.jsonl (identical prepared corpus)",
    "~/Library/Mosh/work/sft/r8-4b-smoke/train.jsonl (119 messages-only rows)",
    "service/sft/.artifacts/a3b-r4-cuda-bundle.tgz (v4 messages-only train/prefilter/manifest)",
    "bounded inventories under ~/Library/Mosh/work, durable data, service/sft, and two .claude worktrees",
    "legacy ~/Documents/ClaudeMosh, intelligent-banach paths, ~/mosh-corpus absent"
  ],
  "retainedSegments": [
    {
      "trainingLines": [
        12675,
        12829
      ],
      "source": "offset-coords.jsonl",
      "sourceLines": [
        1,
        155
      ],
      "sha256": "6194fb43ad0708950fbbc7cb8048743855b214cd7b2b07b3a4bcc798812037aa"
    },
    {
      "trainingLines": [
        12830,
        12889
      ],
      "source": "render-routing.jsonl",
      "sourceLines": [
        1,
        60
      ],
      "sha256": "2a3c4ee5cc1ef8de42f011ed62389dfa49973fb26b96a4844393f72408693427"
    },
    {
      "trainingLines": [
        12890,
        12994
      ],
      "source": "r5_train_additions.jsonl",
      "sourceLines": [
        1,
        105
      ],
      "sha256": "6085bf99efa01701ef543f03c6707f8476d3b122256eb531cc1693a0033dd80e"
    }
  ],
  "segmentsAreSetupEvidence": false,
  "heldoutGoldArgs": "Absent in evalA and frozen source; startCommands describe initial setup only, goldCommandNames omit target arguments."
}
```

## Undo and materialized transactions

31 skills use per-mutation native transactions, 7 change non-undoable state, and 2 navigate existing history. A mined skill is a template, not a new atomic transaction boundary.

The eight-note shape emits eight separate add_note calls, each with its [own native transaction](../../src/moshops/MoshOps.cpp#L2481). It does not satisfy the original corpus system’s one-undo promise for the whole eight-command trajectory. The native note-array form is a different command shape; this miner preserves the original eight unbatched calls rather than silently replacing them.

Opening a transaction is not proof that a mutation was materialized. Track and master faders use [undoable value actions](../../src/moshops/MoshOpsInternal.h#L77); [track-volume plugin creation](../../src/moshops/MoshOps.Tracks.cpp#L870) occurs inside its transaction. Actual undo/redo restoration still needs starting-state and effect evidence.

[Skeleton generation](../../src/moshops/MoshOps.Lyrics.cpp#L816) opens its undo transaction only when a successful result lands. [Test-tone creation](../../src/moshops/MoshOps.Clips.cpp#L325) generates a file before delegating to import_clip; import undo does not remove the generated source file. Save, transport, monitoring, record-arm, metronome, and musical-key preferences are not ordinary undoable edit steps.

## Schema extensions and runtime boundary

The existing [Python base schema](../../service/skills/schema.py) field layout is retained: name, description, slots, template.commands, predicates, provenance, and triggers. This artifact format adds schemaVersion, stable id, 5–10 examples, slots[].input question/choice/constraint/source/statistics metadata, and mining rank/shape/bindings/undo metadata. slots[].default is already a base-schema extension; here NEEDS_OWNER_VALUE is a refusal marker rather than a representative recommendation.

The stored template deliberately retains the existing literal {slot} placeholder syntax, rather than the requested ${slot} notation. Placeholders occupy a whole JSON value. A {stepN.result.field} reference resolves field beneath a successful prior response’s data object, preserving its native result envelope. Missing or unsuccessful results fail rendering instead of supplying a guessed ID; see the [renderer](../../ui/src/skillMining/render.ts).

Stored slot types are string, number, boolean, list<note>, list<string>, list<number>, and list<param>; the separate six input kinds are choice_static, choice_snapshot, set, flag, number, and text. The generated top-40 corpus shapes use scalar arguments. A numeric static choice retains a number in the command, and a list type does not turn repeated command steps into a batch.

snapshot_choice and command_effect are [offline predicate types](../../ui/src/skillMining/types.ts), distinct from the legacy router’s predicate vocabulary. The [mined Python adapter](../../service/skills/mined_schema.py) preserves and validates the richer portable artifact; the legacy Skill adapter alone does not preserve its added metadata or execute its new predicates. The generated catalog is not wired into the production brain/router, and no model weights or production UI were changed by this mining work.

## Held-out shape ceilings

These are exact ordered shape-coverage ceilings only. Held-out gold argument values and wording were not read by this report. One skill must match the whole shape; two skills must match a contiguous split in order. Behavioral expressibility and router accuracy remain unverified.

| Library | Dataset | All rows | One skill | Two additional | At most two skills |
|---|---|---:|---:|---:|---:|
| Candidates | evalA | 210 | 167 (79.52%) | 5 | 172 (81.90%) |
| Candidates | frozen300 | 300 | 299 (99.67%) | 0 | 299 (99.67%) |
| Passed ≥95% only | evalA | 210 | 0 (0.00%) | 0 | 0 (0.00%) |
| Passed ≥95% only | frozen300 | 300 | 0 (0.00%) | 0 | 0 (0.00%) |

Freeze before: `95b3771e0ce51162a051e45009415e87ac045845ca77b20843c017a2d4a08c9a`. Freeze after: `95b3771e0ce51162a051e45009415e87ac045845ca77b20843c017a2d4a08c9a`. The recorded hashes match.

See [heldout.json](heldout.json) for exhaustive held-out shape outcomes. These results establish no benchmark accuracy or musical acceptance.

## Structured-question readiness

The current artifacts contain **105 slots**, 105 nonempty questions, and 12 explicit optional-presence questions. Counts below classify the stored input kind, not a model’s success rate.

| Input kind | Slots |
|---|---:|
| Static choices | 6 |
| Snapshot or explicit-catalog choices | 30 |
| Boolean choices | 7 |
| Numeric entry | 53 |
| Free text | 9 |
| Sets | 0 |

1 static-choice slots are numeric native domains, such as power-of-two time-signature denominators. They remain numeric in emitted commands, and owner-value policy still applies. Arbitrary quantities and observed training values are not converted into enumerated choices.

Snapshot choices resolve through the current native fields or an explicitly supplied catalog response:

- `sections[].id`
- `tracks[].clips[].id`
- `tracks[].clips[].notes[].i`
- `tracks[].id`
- `tracks[].plugins[].index`

The offline checks reject IDs absent from the supplied snapshot and ambiguous target scopes. The caller must supply a fresh snapshot; its freshness is not independently established here. Track, clip, section, plugin, and note choices are not filled with corpus IDs. Plugin and note indices retain native snapshot identities.

[Jev’s structured-selection source](https://typesafe.ai/blog/introducing-system-one-models-and-jev) is a design reference for question-based input collection. These counts establish metadata readiness only: no Jev integration, benchmark score, routing accuracy, successful user dialogue, or musical-quality claim follows from them.

## Verification gates

Recorded evidence: [gates.json](gates.json).

```json
{
  "gates": [
    {
      "name": "TypeScript",
      "command": "cd ui && npm run typecheck",
      "status": "passed",
      "details": "tsc --noEmit and tsc -p tsconfig.e2e.json exit 0; covers all new validator code.",
      "evidence": "/Users/emiliosanchez-harris/Library/Mosh/task-evidence/skills-library-v1/typecheck.log"
    },
    {
      "name": "Full Vitest",
      "command": "cd ui && npm test",
      "status": "passed",
      "details": "475 files passed, 1 file skipped; 4852 tests passed, 1 skipped. All 164 new skillMining tests passed in this full run.",
      "evidence": "/Users/emiliosanchez-harris/Library/Mosh/task-evidence/skills-library-v1/full-vitest.log"
    },
    {
      "name": "Offline Python",
      "command": "cd service/skills && python3 -m pytest -q",
      "status": "passed",
      "details": "196 tests passed, including legacy skills tests and new mined-schema tests.",
      "evidence": "/Users/emiliosanchez-harris/Library/Mosh/task-evidence/skills-library-v1/python-tests.log"
    },
    {
      "name": "CLI surface",
      "command": "cd ui && npm exec -- tsx src/skillMining/cli.ts --help; measure; mine; validate; check; freeze; heldout; report; verify",
      "status": "passed",
      "details": "Help and complete workflow executed. Unknown option deliberately rejected with exit 1; this is expected bad-input behavior.",
      "evidence": "/Users/emiliosanchez-harris/Library/Mosh/task-evidence/skills-library-v1/cli-invalid.log"
    },
    {
      "name": "Deterministic regeneration",
      "command": "cd ui && npm exec -- tsx src/skillMining/cli.ts check",
      "status": "passed",
      "details": "Two independent inventories agree; all 40 files regenerate byte-for-byte with complete provenance and verbatim examples. Frozen300 ID selection digest matches pinned measurement.",
      "evidence": "determinism.json"
    },
    {
      "name": "Freeze across held-out read",
      "command": "cd ui && npm exec -- tsx src/skillMining/cli.ts verify",
      "status": "passed",
      "details": "Identical library/rules/evidence digest before and after held-out shape read: 95b3771e0ce51162a051e45009415e87ac045845ca77b20843c017a2d4a08c9a.",
      "evidence": "FREEZE.json"
    },
    {
      "name": "95% skill reproduction acceptance",
      "command": "cd ui && npm exec -- tsx src/skillMining/cli.ts validate (before freeze)",
      "status": "failed",
      "details": "0/40 skills pass. Of 10030 selected rows, 9954 render exactly but lack authentic setup and remain unverified; 76 fail typed/choice/range validation. Zero rows have verified reproduction.",
      "evidence": "row-validation.jsonl"
    },
    {
      "name": "Held-out behavioral expressibility",
      "command": "Read only against frozen library",
      "status": "unverified",
      "details": "Gold target arguments are absent. Candidate shape ceilings: evalA 167/210 one, +5 exactly two, 172/210 at most two; frozen300 299/300 one, +0 exactly two. Validated-subset ceiling is zero on both.",
      "evidence": "heldout.json"
    }
  ],
  "limits": "No native application, audio, service generation, router accuracy, or listening claim. No runtime edits, dependencies, training, deployment, PR, merge or follow-up tasks."
}
```

## Reproducible artifacts

[Measurements](measurements.json), [complete shapes and row IDs](shapes.json), [skill verdicts](validation.json), and [per-row validation](row-validation.jsonl) are the report’s quantitative sources. Optional evidence remains explicitly pending until its artifact is present. The generator reads current skills and aggregate evidence only; it does not open held-out raw arguments or wording.
