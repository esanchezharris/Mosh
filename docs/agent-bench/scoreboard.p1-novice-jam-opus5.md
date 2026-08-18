# MoshAgentBench — p1-novice-jam-opus5

model `claude-opus-5` @ `claude-cli(subscription)` · suite **novice-jam** · runner **loop** · 19/25 = **76.0%** · acceptable 9/25 = **36.0%** · 2026-08-17

step-eff 34.6% · cmd-err 6.2% · invalid 0.9% · wrong-defers 1 · defer-correct 75.0% · tokens 2620529+16863 (54 calls)

| category | pass | tasks |
|---|---|---|
| mix | 5/5 | ✓nj-drums-slap ✓nj-vocal-too-quiet ✓nj-guitar-echo ✓nj-reverb-vocal-room ✓nj-clear-solo-mute |
| arrange | 1/5 | ✗nj-somewhere-to-sing ✗nj-start-over ✓nj-make-faster ✗nj-fill-the-gap ✗nj-repeat-that-part |
| compose-drums | 2/2 | ✓nj-drums-groove ✓nj-hats-more |
| compose-melody | 1/2 | ✗nj-bassline-simple ✓nj-melody-idea |
| master | 2/2 | ✓nj-glue-it-together ✓nj-master-too-loud |
| generative | 1/1 | ✓nj-weird-ai-flavor |
| lyrics | 2/2 | ✓nj-write-some-words ✓nj-first-line-lyrics |
| repair | 2/2 | ✓nj-808-too-hot ✓nj-undo-hate |
| ambiguous | 3/4 | ✓nj-amb-professional ✗nj-amb-mix-properly ✓nj-amb-hit-different ✓nj-amb-empty-middle |

Failures:
- **nj-somewhere-to-sing** (5 steps): create_track,create_track,arm_track,set_input_monitor,set_count_in,set_metronome,set_input_monitor,save,save — Δtracks 2 ≠ 1
- **nj-start-over** (0 steps): deferred — pos 10s ∉ [0,0.5]
- **nj-fill-the-gap** (3 steps): move_clip,save,move_clip,save — delete_time_range ×0 < 1
- **nj-repeat-that-part** (3 steps): duplicate_clip,duplicate_clip,move_clip,move_clip — Δclips 2 ≠ 1
- **nj-bassline-simple** (4 steps): create_track,create_track,load_builtin,add_midi_clip — add_note ×0 < 3; 0 in-key notes < 3
- **nj-amb-mix-properly** (6 steps): set_track_volume,set_track_volume,set_track_volume,set_track_volume,set_track_pan,set_track_pan,set_track_volume,set_track_volume,set_track_volume,set_track_volume,set_track_pan,set_track_pan,create_bus,load_builtin,load_builtin,add_send,add_send,load_master_builtin,load_master_builtin,set_master_plugin_param,set_master_plugin_param,set_master_volume,save — emitted 23 command(s) on a defer case
