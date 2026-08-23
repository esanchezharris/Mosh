# MoshAgentBench — p3-novice-jam-r8-4b-final-cal2

model `/Users/emiliosanchez-harris/AI/models/fused/r8-4b-final` @ `http://127.0.0.1:8080/v1` · suite **novice-jam** · runner **loop** · 12/25 = **48.0%** · acceptable 11/25 = **44.0%** · 2026-08-23

step-eff 87.5% · cmd-err 9.2% · invalid 0.0% · wrong-defers 6 · defer-correct 100.0% · tokens 189011+4660 (28 calls)

| category | pass | tasks |
|---|---|---|
| mix | 2/5 | ✗nj-drums-slap ✓nj-vocal-too-quiet ✗nj-guitar-echo ✗nj-reverb-vocal-room ✓nj-clear-solo-mute |
| arrange | 3/5 | ✓nj-somewhere-to-sing ✗nj-start-over ✓nj-make-faster ✗nj-fill-the-gap ✓nj-repeat-that-part |
| compose-drums | 0/2 | ✗nj-drums-groove ✗nj-hats-more |
| compose-melody | 1/2 | ✗nj-bassline-simple ✓nj-melody-idea |
| master | 0/2 | ✗nj-glue-it-together ✗nj-master-too-loud |
| generative | 0/1 | ✗nj-weird-ai-flavor |
| lyrics | 0/2 | ✗nj-write-some-words ✗nj-first-line-lyrics |
| repair | 2/2 | ✓nj-808-too-hot ✓nj-undo-hate |
| ambiguous | 4/4 | ✓nj-amb-professional ✓nj-amb-mix-properly ✓nj-amb-hit-different ✓nj-amb-empty-middle |

Failures:
- **nj-drums-slap** (0 steps): deferred — volumeDb Δ0.0 not up within [1,8]
- **nj-guitar-echo** (3 steps): load_builtin,set_plugin_param,set_plugin_param,set_plugin_param,set_track_volume — plugin ~"delay" missing
- **nj-reverb-vocal-room** (1 steps): set_track_type,load_builtin,set_track_volume,set_track_pan,set_track_mute — Δbuses 0 ≠ 1; "Vocal" has no sends
- **nj-start-over** (1 steps): set_tempo,set_key,set_time_signature,set_master_volume,set_track_volume,set_track_volume,set_track_volume,set_track_volume — pos 10s ∉ [0,0.5]
- **nj-fill-the-gap** (1 steps): trim_clip — delete_time_range ×0 < 1; start 12s ∉ [3.9,4.1]
- **nj-drums-groove** (1 steps): create_track,set_track_volume,set_track_pan,set_track_mute,set_track_solo,set_track_active — add_drum_pattern ×0 < 1; 0 notes < 8
- **nj-hats-more** (0 steps): deferred — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **nj-bassline-simple** (1 steps): create_track,set_track_color,set_track_volume,set_track_pan,set_track_active — add_note ×0 < 3; 0 in-key notes < 3
- **nj-glue-it-together** (0 steps): deferred — master ~"comp" missing (chain: empty)
- **nj-master-too-loud** (1 steps): set_master_volume — master volumeDb Δ0.0 not down within [1,6]
- **nj-weird-ai-flavor** (0 steps): deferred — compile_render|create_render_layer ×0 < 1
- **nj-write-some-words** (0 steps): deferred — create_lyric_sheet ×0 < 1
- **nj-first-line-lyrics** (0 steps): deferred — set_lyric_line ×0 < 1
