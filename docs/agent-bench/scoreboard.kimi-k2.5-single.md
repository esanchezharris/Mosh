# MoshAgentBench — kimi-k2.5-single

model `moonshotai/kimi-k2.5` @ `https://openrouter.ai/api/v1` · runner **single** · 19/34 = **55.9%** · 2026-07-19

step-eff 100.0% · cmd-err 10.8% · invalid 2.9% · wrong-defers 8 · defer-correct 100.0% · tokens 135390+45605 (34 calls)

| category | pass | tasks |
|---|---|---|
| arrange | 4/6 | ✗arr-clear-middle ✓arr-close-gap ✓arr-loop-first-second ✗arr-split-dup ✓arr-map-sections ✓arr-move-trim |
| compose-drums | 0/4 | ✗drums-boombap ✗drums-new-hats ✗drums-trap-sketch ✗drums-mute-hat-lane |
| compose-melody | 3/4 | ✗mel-bass-in-key ✓mel-keys-in-key ✓mel-quantize ✓mel-set-key |
| mix | 4/5 | ✓mix-balance ✓mix-vocal-space ✗mix-submix ✓mix-clip-not-fader ✓mix-cleanup |
| master | 0/3 | ✗master-glue ✗master-eq-before-comp ✗master-trim |
| generative | 1/3 | ✗gen-lofi ✗gen-reimagine-subtle ✓gen-run-render |
| lyrics | 2/2 | ✓lyr-start-sheet ✓lyr-first-line |
| repair | 1/3 | ✓rep-clipping-808 ✗rep-move-comp ✗rep-rogue-tempo |
| ambiguous | 4/4 | ✓amb-make-better ✓amb-delete-bad ✓amb-fix-timing ✓amb-upload |

Failures:
- **arr-clear-middle** (1 steps): delete_time_range — clip [4.00,5.00] on "Vocal" overlaps [4,8]
- **arr-split-dup** (1 steps): deferred — Δclips 0 ≠ 2; split_clip ×0 < 1; duplicate_clip ×0 < 1
- **drums-boombap** (1 steps): deferred — tempo 120 ≠ 90; Δtracks 0 ≠ 1; add_drum_pattern ×0 < 1; 0 notes < 8
- **drums-new-hats** (1 steps): set_track_type,add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **drums-trap-sketch** (1 steps): deferred — tempo 120 ≠ 140; add_drum_pattern ×0 < 1; 0 notes < 16
- **drums-mute-hat-lane** (1 steps): set_drum_lane — set_drum_lane ×0 < 1
- **mel-bass-in-key** (1 steps): deferred — add_note ×0 < 3; 0 in-key notes < 3
- **mix-submix** (1 steps): create_track,set_track_output,set_track_output — set_track_output ×0 < 2
- **master-glue** (1 steps): deferred — master ~"comp" missing (chain: empty)
- **master-eq-before-comp** (1 steps): load_master_builtin — master ~"eq" missing (chain: Compressor); master chain missing "eq"
- **master-trim** (1 steps): set_master_volume — master volumeDb Δ1.0 not down within [1,6]
- **gen-lofi** (1 steps): deferred — compile_render|create_render_layer ×0 < 1
- **gen-reimagine-subtle** (1 steps): deferred — compile_render|create_render_layer ×0 < 1; hasRenderLayer=false ≠ true
- **rep-move-comp** (1 steps): deferred — plugin ~"comp" unexpectedly present; plugin ~"comp" missing
- **rep-rogue-tempo** (1 steps): delete_time_range — tempo point at 4s unexpectedly present; remove_tempo_change ×0 < 1
