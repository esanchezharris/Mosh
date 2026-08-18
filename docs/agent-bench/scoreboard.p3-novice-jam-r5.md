# MoshAgentBench — p3-novice-jam-r5

model `/Users/emiliosanchez-harris/AI/models/fused/a3b-r5-4bit-hd` @ `http://127.0.0.1:8090/v1` · suite **novice-jam** · runner **loop** · 17/25 = **68.0%** · acceptable 16/25 = **64.0%** · 2026-08-17

step-eff 96.4% · cmd-err 8.0% · invalid 2.0% · wrong-defers 1 · defer-correct 75.0% · tokens 221760+1975 (34 calls)

| category | pass | tasks |
|---|---|---|
| mix | 1/5 | ✗nj-drums-slap ✗nj-vocal-too-quiet ✓nj-guitar-echo ✗nj-reverb-vocal-room ✗nj-clear-solo-mute |
| arrange | 5/5 | ✓nj-somewhere-to-sing ✓nj-start-over ✓nj-make-faster ✓nj-fill-the-gap ✓nj-repeat-that-part |
| compose-drums | 0/2 | ✗nj-drums-groove ✗nj-hats-more |
| compose-melody | 1/2 | ✗nj-bassline-simple ✓nj-melody-idea |
| master | 2/2 | ✓nj-glue-it-together ✓nj-master-too-loud |
| generative | 1/1 | ✓nj-weird-ai-flavor |
| lyrics | 2/2 | ✓nj-write-some-words ✓nj-first-line-lyrics |
| repair | 2/2 | ✓nj-808-too-hot ✓nj-undo-hate |
| ambiguous | 3/4 | ✓nj-amb-professional ✓nj-amb-mix-properly ✓nj-amb-hit-different ✗nj-amb-empty-middle |

Failures:
- **nj-drums-slap** (0 steps): deferred — volumeDb Δ0.0 not up within [1,8]
- **nj-vocal-too-quiet** (1 steps): set_track_volume — volumeDb Δ-2.5 not up within [1,8]
- **nj-reverb-vocal-room** (1 steps): create_bus — "Vocal" has no sends
- **nj-clear-solo-mute** (1 steps): list_track_outputs — mute=true ≠ false; solo=true ≠ false
- **nj-drums-groove** (1 steps): create_track — add_drum_pattern ×0 < 1; 0 notes < 8
- **nj-hats-more** (3 steps): add_drum_pattern,add_drum_pattern,add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **nj-bassline-simple** (2 steps): create_track,add_drum_pattern — add_note ×0 < 3; 0 in-key notes < 3
- **nj-amb-empty-middle** (1 steps): create_section — emitted 1 command(s) on a defer case
