# MoshAgentBench — fable-5-cli-single

model `claude-fable-5` @ `claude-cli(subscription)` · runner **single** · 20/34 = **58.8%** · 2026-07-19

step-eff 100.0% · cmd-err 17.2% · invalid 0.0% · wrong-defers 1 · defer-correct 50.0% · tokens 959083+16035 (34 calls)

| category | pass | tasks |
|---|---|---|
| arrange | 3/6 | ✓arr-clear-middle ✗arr-close-gap ✗arr-loop-first-second ✗arr-split-dup ✓arr-map-sections ✓arr-move-trim |
| compose-drums | 2/4 | ✗drums-boombap ✗drums-new-hats ✓drums-trap-sketch ✓drums-mute-hat-lane |
| compose-melody | 3/4 | ✗mel-bass-in-key ✓mel-keys-in-key ✓mel-quantize ✓mel-set-key |
| mix | 3/5 | ✓mix-balance ✗mix-vocal-space ✗mix-submix ✓mix-clip-not-fader ✓mix-cleanup |
| master | 0/3 | ✗master-glue ✗master-eq-before-comp ✗master-trim |
| generative | 3/3 | ✓gen-lofi ✓gen-reimagine-subtle ✓gen-run-render |
| lyrics | 2/2 | ✓lyr-start-sheet ✓lyr-first-line |
| repair | 2/3 | ✓rep-clipping-808 ✗rep-move-comp ✓rep-rogue-tempo |
| ambiguous | 2/4 | ✓amb-make-better ✓amb-delete-bad ✗amb-fix-timing ✗amb-upload |

Failures:
- **arr-close-gap** (1 steps): delete_time_range — start 8s ∉ [3.9,4.1]
- **arr-loop-first-second** (1 steps): set_clip_loop — loopEnabled=undefined ≠ true; set_clip_loop ×0 < 1
- **arr-split-dup** (1 steps): deferred — Δclips 0 ≠ 2; split_clip ×0 < 1; duplicate_clip ×0 < 1
- **drums-boombap** (1 steps): set_tempo,create_track,add_drum_pattern — Δtracks 2 ≠ 1
- **drums-new-hats** (1 steps): set_track_type,add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **mel-bass-in-key** (1 steps): add_note,add_note,add_note,add_note — 2 in-key notes < 3
- **mix-vocal-space** (1 steps): create_bus,add_send,set_track_volume — "Vocal" has no sends
- **mix-submix** (1 steps): create_track — set_track_output ×0 < 2
- **master-glue** (1 steps): load_master_builtin — master ~"comp" missing (chain: empty)
- **master-eq-before-comp** (1 steps): load_master_builtin — master ~"eq" missing (chain: empty); master chain missing "eq"
- **master-trim** (1 steps): set_master_volume — master volumeDb Δ1.0 not down within [1,6]
- **rep-move-comp** (1 steps): remove_plugin,load_builtin — plugin ~"comp" unexpectedly present
- **amb-fix-timing** (1 steps): quantize_notes,set_clip_warp,set_clip_warp — emitted 3 command(s) on a defer case
- **amb-upload** (1 steps): export_audio — emitted 1 command(s) on a defer case
