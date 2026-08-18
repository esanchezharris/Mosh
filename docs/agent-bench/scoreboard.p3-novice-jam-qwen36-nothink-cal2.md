# MoshAgentBench — p3-novice-jam-qwen36-nothink-cal2

model `/Users/emiliosanchez-harris/.cache/huggingface/hub/models--mlx-community--Qwen3.6-35B-A3B-4bit/snapshots/38740b847e4cb78f352aba30aa41c76e08e6eb46/` @ `http://127.0.0.1:8090/v1` · suite **novice-jam** · runner **loop** · 17/25 = **68.0%** · acceptable 13/25 = **52.0%** · 2026-08-18

step-eff 56.5% · cmd-err 15.7% · invalid 3.7% · wrong-defers 0 · defer-correct 75.0% · tokens 259390+11615 (38 calls)

| category | pass | tasks |
|---|---|---|
| mix | 4/5 | ✓nj-drums-slap ✓nj-vocal-too-quiet ✓nj-guitar-echo ✗nj-reverb-vocal-room ✓nj-clear-solo-mute |
| arrange | 2/5 | ✗nj-somewhere-to-sing ✗nj-start-over ✓nj-make-faster ✗nj-fill-the-gap ✓nj-repeat-that-part |
| compose-drums | 0/2 | ✗nj-drums-groove ✗nj-hats-more |
| compose-melody | 2/2 | ✓nj-bassline-simple ✓nj-melody-idea |
| master | 2/2 | ✓nj-glue-it-together ✓nj-master-too-loud |
| generative | 1/1 | ✓nj-weird-ai-flavor |
| lyrics | 2/2 | ✓nj-write-some-words ✓nj-first-line-lyrics |
| repair | 1/2 | ✗nj-808-too-hot ✓nj-undo-hate |
| ambiguous | 3/4 | ✓nj-amb-professional ✓nj-amb-mix-properly ✓nj-amb-hit-different ✗nj-amb-empty-middle |

Failures:
- **nj-reverb-vocal-room** (7 steps): load_builtin,load_builtin,set_plugin_param,list_builtins,set_plugin_param,open_plugin_editor,set_plugin_param — Δbuses 0 ≠ 1; "Vocal" has no sends
- **nj-somewhere-to-sing** (5 steps): create_track,create_bus,load_builtin,create_track,create_bus,create_track,create_bus,load_builtin,create_track,create_bus,add_send,arm_track — Δtracks 8 ≠ 1
- **nj-start-over** (2 steps): remove_clip,remove_clip,remove_clip,create_track — pos 10s ∉ [0,0.5]
- **nj-fill-the-gap** (2 steps): delete_time_range,delete_time_range — clip[1] on "Drums" not found
- **nj-drums-groove** (4 steps): create_track,create_track,add_drum_pattern,create_track,add_drum_pattern — Δtracks 3 ≠ 1; 0 notes < 8
- **nj-hats-more** (3 steps): add_drum_pattern,add_drum_pattern,add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **nj-808-too-hot** (2 steps): set_track_volume,set_track_volume — net level Δ-3.0 dB not down ≥ 6
- **nj-amb-empty-middle** (4 steps): add_drum_pattern,add_drum_pattern,add_midi_clip,add_note,add_note,add_note,add_note,create_track,add_drum_pattern — emitted 9 command(s) on a defer case
