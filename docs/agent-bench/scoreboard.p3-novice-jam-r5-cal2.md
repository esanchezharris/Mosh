# MoshAgentBench — p3-novice-jam-r5-cal2

model `/Users/emiliosanchez-harris/AI/models/fused/a3b-r5-4bit-hd` @ `http://127.0.0.1:8090/v1` · suite **novice-jam** · runner **loop** · 17/25 = **68.0%** · acceptable 16/25 = **64.0%** · 2026-08-17

step-eff 96.4% · cmd-err 8.0% · invalid 2.0% · wrong-defers 0 · defer-correct 75.0% · tokens 194960+3048 (29 calls)

| category | pass | tasks |
|---|---|---|
| mix | 3/5 | ✗nj-drums-slap ✓nj-vocal-too-quiet ✓nj-guitar-echo ✗nj-reverb-vocal-room ✓nj-clear-solo-mute |
| arrange | 4/5 | ✓nj-somewhere-to-sing ✓nj-start-over ✓nj-make-faster ✗nj-fill-the-gap ✓nj-repeat-that-part |
| compose-drums | 0/2 | ✗nj-drums-groove ✗nj-hats-more |
| compose-melody | 1/2 | ✗nj-bassline-simple ✓nj-melody-idea |
| master | 1/2 | ✓nj-glue-it-together ✗nj-master-too-loud |
| generative | 1/1 | ✓nj-weird-ai-flavor |
| lyrics | 2/2 | ✓nj-write-some-words ✓nj-first-line-lyrics |
| repair | 2/2 | ✓nj-808-too-hot ✓nj-undo-hate |
| ambiguous | 3/4 | ✓nj-amb-professional ✓nj-amb-mix-properly ✓nj-amb-hit-different ✗nj-amb-empty-middle |

Failures:
- **nj-drums-slap** (1 steps): set_clip_gain — volumeDb Δ0.0 not up within [1,8]
- **nj-reverb-vocal-room** (1 steps): load_builtin — Δbuses 0 ≠ 1; "Vocal" has no sends
- **nj-fill-the-gap** (2 steps): trim_clip,trim_clip — delete_time_range ×0 < 1
- **nj-drums-groove** (2 steps): create_track,load_drum_kit — add_drum_pattern ×0 < 1; 0 notes < 8
- **nj-hats-more** (1 steps): add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **nj-bassline-simple** (1 steps): add_note,add_note,add_note,add_note,add_note,add_note,add_note,add_note — 0 in-key notes < 3
- **nj-master-too-loud** (1 steps): set_master_volume — master volumeDb Δ0.0 not down within [1,6]
- **nj-amb-empty-middle** (1 steps): create_section — emitted 1 command(s) on a defer case
