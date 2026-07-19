# MoshAgentBench — gpt-5.4-mini-single

model `gpt-5.4-mini` @ `https://api.openai.com/v1` · runner **single** · 21/34 = **61.8%** · 2026-07-19

step-eff 100.0% · cmd-err 12.3% · invalid 7.8% · wrong-defers 3 · defer-correct 75.0% · tokens 135627+1935 (34 calls)

| category | pass | tasks |
|---|---|---|
| arrange | 5/6 | ✓arr-clear-middle ✓arr-close-gap ✓arr-loop-first-second ✗arr-split-dup ✓arr-map-sections ✓arr-move-trim |
| compose-drums | 1/4 | ✗drums-boombap ✗drums-new-hats ✗drums-trap-sketch ✓drums-mute-hat-lane |
| compose-melody | 2/4 | ✓mel-bass-in-key ✗mel-keys-in-key ✗mel-quantize ✓mel-set-key |
| mix | 5/5 | ✓mix-balance ✓mix-vocal-space ✓mix-submix ✓mix-clip-not-fader ✓mix-cleanup |
| master | 0/3 | ✗master-glue ✗master-eq-before-comp ✗master-trim |
| generative | 2/3 | ✓gen-lofi ✓gen-reimagine-subtle ✗gen-run-render |
| lyrics | 2/2 | ✓lyr-start-sheet ✓lyr-first-line |
| repair | 1/3 | ✓rep-clipping-808 ✗rep-move-comp ✗rep-rogue-tempo |
| ambiguous | 3/4 | ✓amb-make-better ✓amb-delete-bad ✓amb-fix-timing ✗amb-upload |

Failures:
- **arr-split-dup** (1 steps): split_clip,duplicate_clip — Δclips 1 ≠ 2; split_clip ×0 < 1
- **drums-boombap** (1 steps): set_tempo,create_track,add_drum_pattern — add_drum_pattern ×0 < 1; 0 notes < 8
- **drums-new-hats** (1 steps): add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **drums-trap-sketch** (1 steps): set_tempo,create_track,add_drum_pattern — add_drum_pattern ×0 < 1; 0 notes < 16
- **mel-keys-in-key** (1 steps): deferred — add_note ×0 < 4; 0 in-key notes < 4
- **mel-quantize** (1 steps): quantize_notes — quantize_notes ×0 < 1
- **master-glue** (1 steps): list_builtins,list_plugins — master ~"comp" missing (chain: empty)
- **master-eq-before-comp** (1 steps): deferred — master ~"eq" missing (chain: Compressor); master chain missing "eq"
- **master-trim** (1 steps): set_master_volume — master volumeDb Δ1.0 not down within [1,6]
- **gen-run-render** (1 steps): deferred — render_layer ×0 < 1
- **rep-move-comp** (1 steps): remove_plugin,load_builtin — plugin ~"comp" unexpectedly present
- **rep-rogue-tempo** (1 steps): delete_time_range — tempo point at 4s unexpectedly present; remove_tempo_change ×0 < 1
- **amb-upload** (1 steps): load_master_builtin,load_master_builtin — emitted 2 command(s) on a defer case
