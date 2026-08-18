# MoshAgentBench — p1-smoke2-grok

model `grok-4.3` @ `https://api.x.ai/v1` · suite **novice-jam** · runner **loop** · 2/3 = **66.7%** · acceptable 2/3 = **66.7%** · 2026-08-17

step-eff 100.0% · cmd-err 0.0% · invalid 0.0% · wrong-defers 1 · defer-correct 100.0% · tokens 19651+122 (3 calls)

| category | pass | tasks |
|---|---|---|
| mix | 1/1 | ✓nj-vocal-too-quiet |
| arrange | 0/1 | ✗nj-make-faster |
| ambiguous | 1/1 | ✓nj-amb-professional |

Failures:
- **nj-make-faster** (0 steps): deferred — tempo 120 < 121
