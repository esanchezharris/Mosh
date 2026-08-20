# MoshAgentBench — p3-novice-jam-a3b-r7-final-cal2

model `/Users/emiliosanchez-harris/AI/models/fused/a3b-r7-4bit-final` @ `http://127.0.0.1:8080/v1` · suite **novice-jam** · runner **loop** · 12/25 = **48.0%** · acceptable 8/25 = **32.0%** · 2026-08-20

step-eff 78.3% · cmd-err 23.7% · invalid 6.0% · wrong-defers 2 · defer-correct 50.0% · tokens 243787+11742 (36 calls)

| category | pass | tasks |
|---|---|---|
| mix | 2/5 | ✗nj-drums-slap ✓nj-vocal-too-quiet ✗nj-guitar-echo ✗nj-reverb-vocal-room ✓nj-clear-solo-mute |
| arrange | 3/5 | ✓nj-somewhere-to-sing ✓nj-start-over ✓nj-make-faster ✗nj-fill-the-gap ✗nj-repeat-that-part |
| compose-drums | 0/2 | ✗nj-drums-groove ✗nj-hats-more |
| compose-melody | 1/2 | ✗nj-bassline-simple ✓nj-melody-idea |
| master | 2/2 | ✓nj-glue-it-together ✓nj-master-too-loud |
| generative | 1/1 | ✓nj-weird-ai-flavor |
| lyrics | 1/2 | ✓nj-write-some-words ✗nj-first-line-lyrics |
| repair | 0/2 | ✗nj-808-too-hot ✗nj-undo-hate |
| ambiguous | 2/4 | ✓nj-amb-professional ✗nj-amb-mix-properly ✓nj-amb-hit-different ✗nj-amb-empty-middle |

Failures:
- **nj-drums-slap** (0 steps): deferred — volumeDb Δ0.0 not up within [1,8]
- **nj-guitar-echo** (2 steps): load_builtin,set_plugin_param,set_plugin_param,set_plugin_param — plugin ~"delay" missing
- **nj-reverb-vocal-room** (3 steps): load_master_builtin,set_master_plugin_param,set_master_plugin_param,set_master_plugin_param,bypass_master_plugin — Δbuses 0 ≠ 1; "Vocal" has no sends
- **nj-fill-the-gap** (4 steps): list_takes,trim_clip,list_takes,move_clip — delete_time_range ×0 < 1
- **nj-repeat-that-part** (1 steps): list_clips — Δclips 0 ≠ 1; duplicate_clip ×0 < 1
- **nj-drums-groove** (2 steps): create_track,load_drum_kit — add_drum_pattern ×0 < 1; 0 notes < 8
- **nj-hats-more** (2 steps): list_drum_kits,load_drum_kit — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **nj-bassline-simple** (2 steps): create_track,load_builtin — add_note ×0 < 3; 0 in-key notes < 3
- **nj-first-line-lyrics** (1 steps): create_lyric_sheet — set_lyric_line ×0 < 1
- **nj-808-too-hot** (1 steps): set_track_volume — net level Δ-4.0 dB not down ≥ 6
- **nj-undo-hate** (0 steps): deferred — tempo 174 ≠ 120; undo ×0 < 1
- **nj-amb-mix-properly** (7 steps): set_track_volume,set_track_volume,set_track_volume,set_track_volume,set_track_pan,set_track_pan,load_builtin,load_master_builtin,set_track_volume,set_transport,set_plugin_param — emitted 11 command(s) on a defer case
- **nj-amb-empty-middle** (3 steps): create_section,add_note,add_note,add_note,add_note,add_drum_pattern — emitted 6 command(s) on a defer case
