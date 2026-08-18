# MoshAgentBench — p3-novice-jam-r5hd-cal2

model `/Users/emiliosanchez-harris/.cache/huggingface/hub/models--mlx-community--Qwen3-30B-A3B-Instruct-2507-8bit/snapshots/cc56d334b04419b9178729f2ced9e4003f18073b/` @ `http://127.0.0.1:8090/v1` · suite **novice-jam** · runner **loop** · 16/25 = **64.0%** · acceptable 9/25 = **36.0%** · 2026-08-17

step-eff 67.9% · cmd-err 24.3% · invalid 4.0% · wrong-defers 0 · defer-correct 50.0% · tokens 242799+11498 (36 calls)

| category | pass | tasks |
|---|---|---|
| mix | 3/5 | ✓nj-drums-slap ✓nj-vocal-too-quiet ✗nj-guitar-echo ✗nj-reverb-vocal-room ✓nj-clear-solo-mute |
| arrange | 4/5 | ✓nj-somewhere-to-sing ✓nj-start-over ✓nj-make-faster ✗nj-fill-the-gap ✓nj-repeat-that-part |
| compose-drums | 0/2 | ✗nj-drums-groove ✗nj-hats-more |
| compose-melody | 1/2 | ✗nj-bassline-simple ✓nj-melody-idea |
| master | 2/2 | ✓nj-glue-it-together ✓nj-master-too-loud |
| generative | 1/1 | ✓nj-weird-ai-flavor |
| lyrics | 1/2 | ✓nj-write-some-words ✗nj-first-line-lyrics |
| repair | 2/2 | ✓nj-808-too-hot ✓nj-undo-hate |
| ambiguous | 2/4 | ✗nj-amb-professional ✗nj-amb-mix-properly ✓nj-amb-hit-different ✓nj-amb-empty-middle |

Failures:
- **nj-guitar-echo** (2 steps): load_builtin,set_plugin_param,set_plugin_param,set_plugin_param,set_plugin_param — plugin ~"delay" missing
- **nj-reverb-vocal-room** (2 steps): load_builtin,set_plugin_param,set_plugin_param,set_plugin_param — Δbuses 0 ≠ 1; "Vocal" has no sends
- **nj-fill-the-gap** (3 steps): list_takes,trim_clip,move_clip — delete_time_range ×0 < 1
- **nj-drums-groove** (1 steps): create_track — add_drum_pattern ×0 < 1; 0 notes < 8
- **nj-hats-more** (1 steps): add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **nj-bassline-simple** (2 steps): create_track,load_drum_kit — add_note ×0 < 3; 0 in-key notes < 3
- **nj-first-line-lyrics** (1 steps): create_lyric_sheet — set_lyric_line ×0 < 1
- **nj-amb-professional** (2 steps): load_builtin,set_plugin_param,set_plugin_param — emitted 3 command(s) on a defer case
- **nj-amb-mix-properly** (6 steps): set_track_volume,set_track_volume,set_track_volume,set_track_volume,set_track_pan,set_track_pan,load_master_builtin,set_master_plugin_param,set_master_plugin_param,set_master_plugin_param,set_master_plugin_param,set_track_automation_mode,load_builtin,set_plugin_param,set_plugin_param — emitted 15 command(s) on a defer case
