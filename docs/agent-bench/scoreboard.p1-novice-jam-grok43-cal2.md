# MoshAgentBench — p1-novice-jam-grok43-cal2

model `grok-4.3` @ `https://api.x.ai/v1` · suite **novice-jam** · runner **loop** · 19/25 = **76.0%** · acceptable 16/25 = **64.0%** · 2026-08-17

step-eff 84.4% · cmd-err 11.7% · invalid 0.0% · wrong-defers 1 · defer-correct 100.0% · tokens 244316+2867 (36 calls)

| category | pass | tasks |
|---|---|---|
| mix | 4/5 | ✓nj-drums-slap ✓nj-vocal-too-quiet ✓nj-guitar-echo ✗nj-reverb-vocal-room ✓nj-clear-solo-mute |
| arrange | 3/5 | ✗nj-somewhere-to-sing ✓nj-start-over ✓nj-make-faster ✗nj-fill-the-gap ✓nj-repeat-that-part |
| compose-drums | 0/2 | ✗nj-drums-groove ✗nj-hats-more |
| compose-melody | 2/2 | ✓nj-bassline-simple ✓nj-melody-idea |
| master | 1/2 | ✗nj-glue-it-together ✓nj-master-too-loud |
| generative | 1/1 | ✓nj-weird-ai-flavor |
| lyrics | 2/2 | ✓nj-write-some-words ✓nj-first-line-lyrics |
| repair | 2/2 | ✓nj-808-too-hot ✓nj-undo-hate |
| ambiguous | 4/4 | ✓nj-amb-professional ✓nj-amb-mix-properly ✓nj-amb-hit-different ✓nj-amb-empty-middle |

Failures:
- **nj-reverb-vocal-room** (1 steps): load_builtin — Δbuses 0 ≠ 1; "Vocal" has no sends
- **nj-somewhere-to-sing** (2 steps): create_track,create_track — Δtracks 2 ≠ 1
- **nj-fill-the-gap** (1 steps): move_clip — delete_time_range ×0 < 1
- **nj-drums-groove** (4 steps): create_track,add_drum_pattern,add_drum_pattern,add_drum_pattern — add_drum_pattern ×0 < 1; 0 notes < 8
- **nj-hats-more** (1 steps): add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **nj-glue-it-together** (0 steps): deferred — master ~"comp" missing (chain: empty)
