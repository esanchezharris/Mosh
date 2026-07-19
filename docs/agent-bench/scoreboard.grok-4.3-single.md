# MoshAgentBench — grok-4.3-single

model `grok-4.3` @ `https://api.x.ai/v1` · runner **single** · 23/34 = **67.6%** · 2026-07-19

step-eff 100.0% · cmd-err 9.8% · invalid 2.9% · wrong-defers 5 · defer-correct 100.0% · tokens 139705+1992 (34 calls)

| category | pass | tasks |
|---|---|---|
| arrange | 5/6 | ✓arr-clear-middle ✓arr-close-gap ✓arr-loop-first-second ✗arr-split-dup ✓arr-map-sections ✓arr-move-trim |
| compose-drums | 0/4 | ✗drums-boombap ✗drums-new-hats ✗drums-trap-sketch ✗drums-mute-hat-lane |
| compose-melody | 4/4 | ✓mel-bass-in-key ✓mel-keys-in-key ✓mel-quantize ✓mel-set-key |
| mix | 4/5 | ✓mix-balance ✓mix-vocal-space ✗mix-submix ✓mix-clip-not-fader ✓mix-cleanup |
| master | 1/3 | ✓master-glue ✗master-eq-before-comp ✗master-trim |
| generative | 2/3 | ✓gen-lofi ✗gen-reimagine-subtle ✓gen-run-render |
| lyrics | 2/2 | ✓lyr-start-sheet ✓lyr-first-line |
| repair | 1/3 | ✓rep-clipping-808 ✗rep-move-comp ✗rep-rogue-tempo |
| ambiguous | 4/4 | ✓amb-make-better ✓amb-delete-bad ✓amb-fix-timing ✓amb-upload |

Failures:
- **arr-split-dup** (1 steps): deferred — Δclips 0 ≠ 2; split_clip ×0 < 1; duplicate_clip ×0 < 1
- **drums-boombap** (1 steps): set_tempo,create_track,add_drum_pattern — add_drum_pattern ×0 < 1; 0 notes < 8
- **drums-new-hats** (1 steps): add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **drums-trap-sketch** (1 steps): set_tempo,add_drum_pattern — add_drum_pattern ×0 < 1; 0 notes < 16
- **drums-mute-hat-lane** (1 steps): set_drum_lane — set_drum_lane ×0 < 1
- **mix-submix** (1 steps): deferred — "Rhythm" missing; set_track_output ×0 < 2
- **master-eq-before-comp** (1 steps): deferred — master ~"eq" missing (chain: Compressor); master chain missing "eq"
- **master-trim** (1 steps): set_master_volume — master volumeDb Δ1.0 not down within [1,6]
- **gen-reimagine-subtle** (1 steps): compile_render — hasRenderLayer=false ≠ true
- **rep-move-comp** (1 steps): deferred — plugin ~"comp" unexpectedly present; plugin ~"comp" missing
- **rep-rogue-tempo** (1 steps): deferred — tempo point at 4s unexpectedly present; remove_tempo_change ×0 < 1
