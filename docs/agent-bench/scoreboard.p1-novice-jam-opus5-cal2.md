# MoshAgentBench — p1-novice-jam-opus5-cal2

model `claude-opus-5` @ `claude-cli(subscription)` · suite **novice-jam** · runner **loop** · 18/25 = **72.0%** · acceptable 13/25 = **52.0%** · 2026-08-17

step-eff 51.7% · cmd-err 6.0% · invalid 0.0% · wrong-defers 0 · defer-correct 75.0% · tokens 1906972+14927 (43 calls)

| category | pass | tasks |
|---|---|---|
| mix | 4/5 | ✓nj-drums-slap ✓nj-vocal-too-quiet ✓nj-guitar-echo ✗nj-reverb-vocal-room ✓nj-clear-solo-mute |
| arrange | 3/5 | ✗nj-somewhere-to-sing ✓nj-start-over ✓nj-make-faster ✗nj-fill-the-gap ✓nj-repeat-that-part |
| compose-drums | 1/2 | ✗nj-drums-groove ✓nj-hats-more |
| compose-melody | 1/2 | ✗nj-bassline-simple ✓nj-melody-idea |
| master | 2/2 | ✓nj-glue-it-together ✓nj-master-too-loud |
| generative | 1/1 | ✓nj-weird-ai-flavor |
| lyrics | 1/2 | ✗nj-write-some-words ✓nj-first-line-lyrics |
| repair | 2/2 | ✓nj-808-too-hot ✓nj-undo-hate |
| ambiguous | 3/4 | ✓nj-amb-professional ✓nj-amb-mix-properly ✓nj-amb-hit-different ✗nj-amb-empty-middle |

Failures:
- **nj-reverb-vocal-room** (3 steps): create_bus,create_bus,load_builtin,add_send — Δbuses 2 ≠ 1
- **nj-somewhere-to-sing** (4 steps): create_track,load_builtin,create_bus,add_send,arm_track,add_send,add_send — Δtracks 2 ≠ 1
- **nj-fill-the-gap** (2 steps): delete_time_range,delete_time_range — clip[1] on "Drums" not found
- **nj-drums-groove** (3 steps): set_tempo,create_track,set_tempo,create_track,add_drum_pattern — Δtracks 2 ≠ 1; 0 notes < 8
- **nj-bassline-simple** (6 steps): create_track,create_track,create_track,load_builtin,add_midi_clip,trim_clip,add_note,add_note,add_note,add_note,add_note,add_note,add_note,add_note,set_track_volume,set_track_pan — 0 in-key notes < 3
- **nj-write-some-words** (4 steps): create_lyric_sheet,create_lyric_sheet,set_lyric_constraint,set_lyric_line,set_lyric_line,set_lyric_line,set_lyric_line,set_lyric_line,set_lyric_line,set_lyric_line,set_lyric_line —  (brain: Error: claude-cli: unparseable output (exit 0): {"is_error":false,"duration_api_ms":2173,"num_turns":1,"stop_reason":"end_turn","session_id":"786c1077-b285-4132-be50-12a8cff2429d","total_cost_usd":0.1)
- **nj-amb-empty-middle** (6 steps): create_section,add_midi_clip,create_section,add_midi_clip,remove_clip,remove_section,add_note,add_note,add_note,add_note,remove_section,remove_section — emitted 12 command(s) on a defer case
