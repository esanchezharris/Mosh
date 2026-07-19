# MoshAgentBench — gpt-5.4-mini-drumfix

model `gpt-5.4-mini` @ `https://api.openai.com/v1` · runner **single** · 1/4 = **25.0%** · 2026-07-19

step-eff 100.0% · cmd-err 29.2% · invalid 0.0% · wrong-defers 0 · defer-correct – · tokens 15767+433 (4 calls)

| category | pass | tasks |
|---|---|---|
| compose-drums | 1/4 | ✗drums-boombap ✗drums-new-hats ✗drums-trap-sketch ✓drums-mute-hat-lane |

Failures:
- **drums-boombap** (1 steps): set_tempo,create_track,add_drum_pattern — add_drum_pattern ×0 < 1; 0 notes < 8
- **drums-new-hats** (1 steps): set_drum_lane,add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **drums-trap-sketch** (1 steps): set_tempo,create_track,add_drum_pattern — add_drum_pattern ×0 < 1; 0 notes < 16
