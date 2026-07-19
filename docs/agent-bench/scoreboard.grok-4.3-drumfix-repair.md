# MoshAgentBench — grok-4.3-drumfix-repair

model `grok-4.3` @ `https://api.x.ai/v1` · runner **single-repair** · 1/4 = **25.0%** · 2026-07-19

step-eff 50.0% · cmd-err 37.5% · invalid 12.5% · wrong-defers 0 · defer-correct – · tokens 28820+542 (7 calls)

| category | pass | tasks |
|---|---|---|
| compose-drums | 1/4 | ✗drums-boombap ✗drums-new-hats ✗drums-trap-sketch ✓drums-mute-hat-lane |

Failures:
- **drums-boombap** (2 steps): set_tempo,create_track,add_drum_pattern,set_tempo,create_track,add_drum_pattern — Δtracks 2 ≠ 1; add_drum_pattern ×0 < 1; 0 notes < 8
- **drums-new-hats** (2 steps): add_drum_pattern,set_track_type,add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **drums-trap-sketch** (1 steps): set_tempo,create_track — add_drum_pattern ×0 < 1; 0 notes < 16
