# MoshAgentBench — _Users_emiliosanchez-harris_AI_models_mlx_Qwen3-30B-A3B-Instruct-2507-4bit-loop-novice-jam

model `/Users/emiliosanchez-harris/AI/models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit` @ `http://127.0.0.1:8899/v1` · suite **novice-jam** · runner **loop** · 14/25 = **56.0%** · acceptable 8/25 = **32.0%** · 2026-08-29

step-eff 56.3% · cmd-err 20.6% · invalid 2.0% · wrong-defers 2 · defer-correct 100.0% · tokens 273086+13142 (40 calls)

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
| ambiguous | 4/4 | ✓nj-amb-professional ✓nj-amb-mix-properly ✓nj-amb-hit-different ✓nj-amb-empty-middle |

Failures:
- **nj-drums-slap** (0 steps): deferred — volumeDb Δ0.0 not up within [1,8]
- **nj-guitar-echo** (3 steps): load_builtin,load_builtin,set_plugin_param,set_plugin_param,set_plugin_param — plugin ~"delay" missing
- **nj-reverb-vocal-room** (3 steps): load_master_builtin,set_master_plugin_param,set_master_plugin_param,set_master_plugin_param,bypass_master_plugin — Δbuses 0 ≠ 1; "Vocal" has no sends
- **nj-fill-the-gap** (5 steps): move_clip,trim_clip,create_track,rename_track,load_drum_kit,add_drum_pattern,trim_clip,move_clip — delete_time_range ×0 < 1; start 8s ∉ [3.9,4.1]
- **nj-repeat-that-part** (4 steps): list_track_outputs,duplicate_clip,move_clip,duplicate_clip,move_clip — Δclips 2 ≠ 1
- **nj-drums-groove** (5 steps): create_track,load_drum_kit,create_track,add_drum_pattern,create_track,set_track_color,set_track_icon,load_drum_kit,add_drum_pattern — Δtracks 3 ≠ 1; add_drum_pattern ×0 < 1; 0 notes < 8
- **nj-hats-more** (3 steps): list_drum_kits,list_drum_kits,load_drum_kit — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **nj-bassline-simple** (3 steps): create_track,create_track,load_builtin — add_note ×0 < 3; 0 in-key notes < 3
- **nj-first-line-lyrics** (1 steps): create_lyric_sheet — set_lyric_line ×0 < 1
- **nj-808-too-hot** (1 steps): set_track_volume — net level Δ-4.0 dB not down ≥ 6
- **nj-undo-hate** (0 steps): deferred — tempo 174 ≠ 120; undo ×0 < 1
