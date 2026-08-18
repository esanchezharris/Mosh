# MoshAgentBench — p3-smoke-r5

model `/Users/emiliosanchez-harris/AI/models/fused/a3b-r5-4bit-hd` @ `http://127.0.0.1:8090/v1` · suite **novice-jam** · runner **loop** · 2/3 = **66.7%** · acceptable 2/3 = **66.7%** · 2026-08-17

step-eff 100.0% · cmd-err 0.0% · invalid 0.0% · wrong-defers 0 · defer-correct 100.0% · tokens 32278+165 (5 calls)

| category | pass | tasks |
|---|---|---|
| mix | 0/1 | ✗nj-vocal-too-quiet |
| arrange | 1/1 | ✓nj-make-faster |
| ambiguous | 1/1 | ✓nj-amb-professional |

Failures:
- **nj-vocal-too-quiet** (1 steps): set_track_volume — volumeDb Δ-2.5 not up within [1,8]
