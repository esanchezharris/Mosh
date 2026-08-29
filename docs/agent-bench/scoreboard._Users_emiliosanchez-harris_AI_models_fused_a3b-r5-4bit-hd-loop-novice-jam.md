# MoshAgentBench — _Users_emiliosanchez-harris_AI_models_fused_a3b-r5-4bit-hd-loop-novice-jam

model `/Users/emiliosanchez-harris/AI/models/fused/a3b-r5-4bit-hd` @ `http://127.0.0.1:8899/v1` · suite **novice-jam** · runner **loop** · 15/25 = **60.0%** · acceptable 13/25 = **52.0%** · 2026-08-29

step-eff 89.6% · cmd-err 10.0% · invalid 3.0% · wrong-defers 0 · defer-correct 75.0% · tokens 210933+2992 (31 calls)

| category | pass | tasks |
|---|---|---|
| mix | 0/5 | ✗nj-drums-slap ✗nj-vocal-too-quiet ✗nj-guitar-echo ✗nj-reverb-vocal-room ✗nj-clear-solo-mute |
| arrange | 5/5 | ✓nj-somewhere-to-sing ✓nj-start-over ✓nj-make-faster ✓nj-fill-the-gap ✓nj-repeat-that-part |
| compose-drums | 0/2 | ✗nj-drums-groove ✗nj-hats-more |
| compose-melody | 1/2 | ✗nj-bassline-simple ✓nj-melody-idea |
| master | 1/2 | ✓nj-glue-it-together ✗nj-master-too-loud |
| generative | 1/1 | ✓nj-weird-ai-flavor |
| lyrics | 2/2 | ✓nj-write-some-words ✓nj-first-line-lyrics |
| repair | 2/2 | ✓nj-808-too-hot ✓nj-undo-hate |
| ambiguous | 3/4 | ✓nj-amb-professional ✓nj-amb-mix-properly ✓nj-amb-hit-different ✗nj-amb-empty-middle |

Failures:
- **nj-drums-slap** (1 steps): set_clip_gain — volumeDb Δ0.0 not up within [1,8]
- **nj-vocal-too-quiet** (1 steps): set_track_volume — volumeDb Δ-1.0 not up within [1,8]
- **nj-guitar-echo** (1 steps): load_builtin — plugin ~"delay" missing
- **nj-reverb-vocal-room** (1 steps): load_builtin — Δbuses 0 ≠ 1; "Vocal" has no sends
- **nj-clear-solo-mute** (1 steps): list_track_outputs — mute=true ≠ false; solo=true ≠ false
- **nj-drums-groove** (2 steps): create_track,load_drum_kit — add_drum_pattern ×0 < 1; 0 notes < 8
- **nj-hats-more** (1 steps): add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **nj-bassline-simple** (1 steps): add_note,add_note,add_note,add_note,add_note,add_note,add_note,add_note — 0 in-key notes < 3
- **nj-master-too-loud** (1 steps): set_master_volume — master volumeDb Δ0.0 not down within [1,6]
- **nj-amb-empty-middle** (1 steps): create_section — emitted 1 command(s) on a defer case
