# MoshAgentBench — grok-4.3-drumfix

model `grok-4.3` @ `https://api.x.ai/v1` · runner **single** · 0/4 = **0.0%** · 2026-07-19

step-eff – · cmd-err 70.8% · invalid 25.0% · wrong-defers 0 · defer-correct – · tokens 16248+342 (4 calls)

| category | pass | tasks |
|---|---|---|
| compose-drums | 0/4 | ✗drums-boombap ✗drums-new-hats ✗drums-trap-sketch ✗drums-mute-hat-lane |

Failures:
- **drums-boombap** (1 steps): set_tempo,add_drum_pattern — Δtracks 0 ≠ 1; add_drum_pattern ×0 < 1; 0 notes < 8
- **drums-new-hats** (1 steps): add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **drums-trap-sketch** (1 steps): set_tempo,create_track,add_drum_pattern — add_drum_pattern ×0 < 1; 0 notes < 16
- **drums-mute-hat-lane** (1 steps): set_drum_lane — set_drum_lane ×0 < 1
