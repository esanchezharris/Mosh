# MoshAgentBench — kimi-k3-single

model `moonshotai/kimi-k3` @ `https://openrouter.ai/api/v1` · runner **single** · 24/34 = **70.6%** · 2026-07-19

step-eff 100.0% · cmd-err 8.3% · invalid 0.0% · wrong-defers 1 · defer-correct 50.0% · tokens 139849+28715 (34 calls)

| category | pass | tasks |
|---|---|---|
| arrange | 5/6 | ✓arr-clear-middle ✓arr-close-gap ✓arr-loop-first-second ✗arr-split-dup ✓arr-map-sections ✓arr-move-trim |
| compose-drums | 1/4 | ✗drums-boombap ✗drums-new-hats ✗drums-trap-sketch ✓drums-mute-hat-lane |
| compose-melody | 4/4 | ✓mel-bass-in-key ✓mel-keys-in-key ✓mel-quantize ✓mel-set-key |
| mix | 5/5 | ✓mix-balance ✓mix-vocal-space ✓mix-submix ✓mix-clip-not-fader ✓mix-cleanup |
| master | 1/3 | ✓master-glue ✗master-eq-before-comp ✗master-trim |
| generative | 3/3 | ✓gen-lofi ✓gen-reimagine-subtle ✓gen-run-render |
| lyrics | 2/2 | ✓lyr-start-sheet ✓lyr-first-line |
| repair | 1/3 | ✓rep-clipping-808 ✗rep-move-comp ✗rep-rogue-tempo |
| ambiguous | 2/4 | ✗amb-make-better ✓amb-delete-bad ✗amb-fix-timing ✓amb-upload |

Failures:
- **arr-split-dup** (1 steps): split_clip — Δclips 0 ≠ 2; split_clip ×0 < 1; duplicate_clip ×0 < 1
- **drums-boombap** (1 steps): set_tempo,create_track,add_drum_pattern — Δtracks 2 ≠ 1; 0 notes < 8
- **drums-new-hats** (1 steps): add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **drums-trap-sketch** (1 steps): set_tempo,create_track,add_drum_pattern — add_drum_pattern ×0 < 1; 0 notes < 16
- **master-eq-before-comp** (1 steps): list_builtins — master ~"eq" missing (chain: Compressor); master chain missing "eq"
- **master-trim** (1 steps): set_master_volume — master volumeDb Δ1.0 not down within [1,6]
- **rep-move-comp** (1 steps): remove_plugin,load_builtin — plugin ~"comp" unexpectedly present
- **rep-rogue-tempo** (1 steps): deferred — tempo point at 4s unexpectedly present; remove_tempo_change ×0 < 1
- **amb-make-better** (1 steps): normalize_clip,normalize_clip,set_clip_fade,set_clip_fade — emitted 4 command(s) on a defer case
- **amb-fix-timing** (1 steps): quantize_notes,set_clip_warp,set_clip_warp — emitted 3 command(s) on a defer case
