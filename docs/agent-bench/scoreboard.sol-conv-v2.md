# MoshAgentBench — sol-conv-v2

model `gpt-5.6-sol` @ `codex-cli(subscription)` · runner **single** · 9/12 = **75.0%** · 2026-07-28

step-eff 100.0% · cmd-err 1.7% · invalid 0.0% · wrong-defers 0 · defer-correct – · tokens 651947+5290 (29 calls)

| category | pass | tasks |
|---|---|---|
| converse-clarify | 1/3 | ✗conv-clarify-louder ✓conv-clarify-trim ✗conv-clarify-two-step |
| converse-correct | 3/3 | ✓conv-correct-too-much ✓conv-correct-wrong-track ✓conv-correct-undo |
| converse-session | 3/3 | ✓conv-session-beat ✓conv-session-arrange ✓conv-session-mix |
| converse-recover | 2/3 | ✗conv-recover-clipping ✓conv-recover-solo ✓conv-recover-tempo |

Failures:
- **conv-clarify-louder** (2 steps): set_master_volume,set_track_volume — turn 0 acted (1 command(s)) instead of asking
- **conv-clarify-two-step** (3 steps): normalize_clip,normalize_clip,set_track_volume,set_track_volume,set_track_volume,set_track_volume,set_master_volume,set_track_volume — 7 command(s) emitted before turn 2; volumeDb Δ-10.0 not down within [2,6]
- **conv-recover-clipping** (2 steps): set_track_volume,set_track_volume — volumeDb=6 ≠ 0
