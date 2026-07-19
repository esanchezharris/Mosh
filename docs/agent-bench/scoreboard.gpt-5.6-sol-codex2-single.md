# MoshAgentBench — gpt-5.6-sol-codex2-single

model `gpt-5.6-sol` @ `codex-cli(subscription)` · runner **single** · 19/34 = **55.9%** · 2026-07-19

step-eff 100.0% · cmd-err 12.7% · invalid 2.9% · wrong-defers 6 · defer-correct 100.0% · tokens 660281+4525 (34 calls)

| category | pass | tasks |
|---|---|---|
| arrange | 3/6 | ✓arr-clear-middle ✗arr-close-gap ✗arr-loop-first-second ✗arr-split-dup ✓arr-map-sections ✓arr-move-trim |
| compose-drums | 1/4 | ✗drums-boombap ✗drums-new-hats ✗drums-trap-sketch ✓drums-mute-hat-lane |
| compose-melody | 2/4 | ✓mel-bass-in-key ✗mel-keys-in-key ✗mel-quantize ✓mel-set-key |
| mix | 4/5 | ✓mix-balance ✓mix-vocal-space ✗mix-submix ✓mix-clip-not-fader ✓mix-cleanup |
| master | 0/3 | ✗master-glue ✗master-eq-before-comp ✗master-trim |
| generative | 2/3 | ✓gen-lofi ✗gen-reimagine-subtle ✓gen-run-render |
| lyrics | 2/2 | ✓lyr-start-sheet ✓lyr-first-line |
| repair | 1/3 | ✓rep-clipping-808 ✗rep-move-comp ✗rep-rogue-tempo |
| ambiguous | 4/4 | ✓amb-make-better ✓amb-delete-bad ✓amb-fix-timing ✓amb-upload |

Failures:
- **arr-close-gap** (1 steps): delete_time_range — start 8s ∉ [3.9,4.1]
- **arr-loop-first-second** (1 steps): set_clip_loop — loopEnabled=undefined ≠ true; set_clip_loop ×0 < 1
- **arr-split-dup** (1 steps): deferred — Δclips 0 ≠ 2; split_clip ×0 < 1; duplicate_clip ×0 < 1
- **drums-boombap** (1 steps): set_tempo,create_track,add_drum_pattern — add_drum_pattern ×0 < 1; 0 notes < 8
- **drums-new-hats** (1 steps): add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **drums-trap-sketch** (1 steps): set_tempo,add_drum_pattern — add_drum_pattern ×0 < 1; 0 notes < 16
- **mel-keys-in-key** (1 steps): deferred — add_note ×0 < 4; 0 in-key notes < 4
- **mel-quantize** (1 steps): quantize_notes — quantize_notes ×0 < 1
- **mix-submix** (1 steps): deferred — "Rhythm" missing; set_track_output ×0 < 2
- **master-glue** (1 steps): list_builtins — master ~"comp" missing (chain: empty)
- **master-eq-before-comp** (1 steps): deferred — master ~"eq" missing (chain: empty); master chain missing "eq"
- **master-trim** (1 steps): set_master_volume — master volumeDb Δ1.0 not down within [1,6]
- **gen-reimagine-subtle** (1 steps): compile_render — hasRenderLayer=false ≠ true
- **rep-move-comp** (1 steps): deferred — plugin ~"comp" unexpectedly present; plugin ~"comp" missing
- **rep-rogue-tempo** (1 steps): deferred — tempo point at 4s unexpectedly present; remove_tempo_change ×0 < 1
