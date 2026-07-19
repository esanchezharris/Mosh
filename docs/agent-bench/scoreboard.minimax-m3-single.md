# MoshAgentBench — minimax-m3-single

model `minimax/minimax-m3` @ `https://openrouter.ai/api/v1` · runner **single** · 19/34 = **55.9%** · 2026-07-19

step-eff 100.0% · cmd-err 3.9% · invalid 0.0% · wrong-defers 6 · defer-correct 75.0% · tokens 141172+7066 (34 calls)

| category | pass | tasks |
|---|---|---|
| arrange | 4/6 | ✗arr-clear-middle ✓arr-close-gap ✓arr-loop-first-second ✗arr-split-dup ✓arr-map-sections ✓arr-move-trim |
| compose-drums | 1/4 | ✗drums-boombap ✗drums-new-hats ✗drums-trap-sketch ✓drums-mute-hat-lane |
| compose-melody | 3/4 | ✓mel-bass-in-key ✓mel-keys-in-key ✗mel-quantize ✓mel-set-key |
| mix | 3/5 | ✗mix-balance ✓mix-vocal-space ✗mix-submix ✓mix-clip-not-fader ✓mix-cleanup |
| master | 1/3 | ✓master-glue ✗master-eq-before-comp ✗master-trim |
| generative | 2/3 | ✓gen-lofi ✓gen-reimagine-subtle ✗gen-run-render |
| lyrics | 1/2 | ✓lyr-start-sheet ✗lyr-first-line |
| repair | 1/3 | ✓rep-clipping-808 ✗rep-move-comp ✗rep-rogue-tempo |
| ambiguous | 3/4 | ✓amb-make-better ✓amb-delete-bad ✗amb-fix-timing ✓amb-upload |

Failures:
- **arr-clear-middle** (1 steps): deferred — clip [5.00,9.00] on "Vocal" overlaps [4,8]; delete_time_range ×0 < 1
- **arr-split-dup** (1 steps): deferred — Δclips 0 ≠ 2; split_clip ×0 < 1; duplicate_clip ×0 < 1
- **drums-boombap** (1 steps): set_tempo,create_track — add_drum_pattern ×0 < 1; 0 notes < 8
- **drums-new-hats** (1 steps): add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **drums-trap-sketch** (1 steps): set_tempo,create_track — add_drum_pattern ×0 < 1; 0 notes < 16
- **mel-quantize** (1 steps): deferred — quantize_notes ×0 < 1
- **mix-balance** (1 steps): set_track_volume,move_clip — pan=0 < 0.05
- **mix-submix** (1 steps): create_track — set_track_output ×0 < 2
- **master-eq-before-comp** (1 steps): list_builtins — master ~"eq" missing (chain: Compressor); master chain missing "eq"
- **master-trim** (1 steps): set_master_volume — master volumeDb Δ1.0 not down within [1,6]
- **gen-run-render** (1 steps): deferred — render_layer ×0 < 1
- **lyr-first-line** (1 steps): deferred — set_lyric_line ×0 < 1
- **rep-move-comp** (1 steps): remove_plugin,load_builtin — plugin ~"comp" unexpectedly present
- **rep-rogue-tempo** (1 steps): deferred — tempo point at 4s unexpectedly present; remove_tempo_change ×0 < 1
- **amb-fix-timing** (1 steps): stretch_clip,stretch_clip,stretch_clip — emitted 3 command(s) on a defer case
