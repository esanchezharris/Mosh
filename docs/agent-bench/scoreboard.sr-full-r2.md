# MoshAgentBench — sr-full-r2

model `claude-sonnet-5` @ `claude-cli(subscription)` · runner **single** · 24/34 = **70.6%** · 2026-07-28

step-eff 100.0% · cmd-err 14.2% · invalid 0.0% · wrong-defers 2 · defer-correct 100.0% · tokens 3588448+39334 (34 calls)

| category | pass | tasks |
|---|---|---|
| arrange | 5/6 | ✓arr-clear-middle ✓arr-close-gap ✓arr-loop-first-second ✗arr-split-dup ✓arr-map-sections ✓arr-move-trim |
| compose-drums | 1/4 | ✗drums-boombap ✗drums-new-hats ✗drums-trap-sketch ✓drums-mute-hat-lane |
| compose-melody | 4/4 | ✓mel-bass-in-key ✓mel-keys-in-key ✓mel-quantize ✓mel-set-key |
| mix | 3/5 | ✓mix-balance ✗mix-vocal-space ✗mix-submix ✓mix-clip-not-fader ✓mix-cleanup |
| master | 1/3 | ✗master-glue ✗master-eq-before-comp ✓master-trim |
| generative | 2/3 | ✓gen-lofi ✓gen-reimagine-subtle ✗gen-run-render |
| lyrics | 2/2 | ✓lyr-start-sheet ✓lyr-first-line |
| repair | 2/3 | ✓rep-clipping-808 ✗rep-move-comp ✓rep-rogue-tempo |
| ambiguous | 4/4 | ✓amb-make-better ✓amb-delete-bad ✓amb-fix-timing ✓amb-upload |

Failures:
- **arr-split-dup** (1 steps): deferred — Δclips 0 ≠ 2; split_clip ×0 < 1; duplicate_clip ×0 < 1
- **drums-boombap** (1 steps): set_tempo,create_track,add_drum_pattern — Δtracks 2 ≠ 1; 0 notes < 8
- **drums-new-hats** (1 steps): add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **drums-trap-sketch** (1 steps): set_tempo,create_track,add_drum_pattern — add_drum_pattern ×0 < 1; 0 notes < 16
- **mix-vocal-space** (1 steps): create_bus,add_send,set_track_volume — "Vocal" has no sends
- **mix-submix** (1 steps): create_track,set_track_output,set_track_output — set_track_output ×0 < 2
- **master-glue** (1 steps): load_master_builtin — master ~"comp" missing (chain: empty)
- **master-eq-before-comp** (1 steps): load_master_builtin — master ~"eq" missing (chain: Compressor); master chain missing "eq"
- **gen-run-render** (1 steps): deferred — render_layer ×0 < 1
- **rep-move-comp** (1 steps): remove_plugin,load_builtin — plugin ~"comp" unexpectedly present
