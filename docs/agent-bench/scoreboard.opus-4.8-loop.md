# MoshAgentBench — opus-4.8-loop

model `claude-opus-4-8` @ `claude-cli(subscription)` · runner **loop** · 21/34 = **61.8%** · 2026-07-19

step-eff 48.3% · cmd-err 15.8% · invalid 2.9% · wrong-defers 1 · defer-correct 25.0% · tokens 3194778+40248 (63 calls)

| category | pass | tasks |
|---|---|---|
| arrange | 3/6 | ✓arr-clear-middle ✗arr-close-gap ✗arr-loop-first-second ✗arr-split-dup ✓arr-map-sections ✓arr-move-trim |
| compose-drums | 1/4 | ✗drums-boombap ✗drums-new-hats ✗drums-trap-sketch ✓drums-mute-hat-lane |
| compose-melody | 4/4 | ✓mel-bass-in-key ✓mel-keys-in-key ✓mel-quantize ✓mel-set-key |
| mix | 4/5 | ✓mix-balance ✗mix-vocal-space ✓mix-submix ✓mix-clip-not-fader ✓mix-cleanup |
| master | 1/3 | ✗master-glue ✗master-eq-before-comp ✓master-trim |
| generative | 3/3 | ✓gen-lofi ✓gen-reimagine-subtle ✓gen-run-render |
| lyrics | 2/2 | ✓lyr-start-sheet ✓lyr-first-line |
| repair | 2/3 | ✓rep-clipping-808 ✗rep-move-comp ✓rep-rogue-tempo |
| ambiguous | 1/4 | ✗amb-make-better ✓amb-delete-bad ✗amb-fix-timing ✗amb-upload |

Failures:
- **arr-close-gap** (3 steps): delete_time_range,delete_time_range,save — start 8s ∉ [3.9,4.1]
- **arr-loop-first-second** (2 steps): set_clip_loop,set_clip_loop — loopEnabled=undefined ≠ true; set_clip_loop ×0 < 1
- **arr-split-dup** (1 steps): split_clip — Δclips 0 ≠ 2; split_clip ×0 < 1; duplicate_clip ×0 < 1
- **drums-boombap** (3 steps): set_tempo,create_track,set_tempo,create_track,add_drum_pattern — Δtracks 2 ≠ 1; 0 notes < 8
- **drums-new-hats** (3 steps): create_track,create_track,add_drum_pattern — Δtracks 3 ≠ 1
- **drums-trap-sketch** (3 steps): set_tempo,create_track,set_tempo,create_track,add_drum_pattern — 0 notes < 16
- **mix-vocal-space** (4 steps): create_bus,set_track_volume,create_bus,set_track_volume,add_send — Δbuses 2 ≠ 1
- **master-glue** (4 steps): list_builtins,list_builtins,load_master_builtin,list_plugins — master ~"comp" missing (chain: empty)
- **master-eq-before-comp** (0 steps): deferred — master ~"eq" missing (chain: empty); master chain missing "eq"
- **rep-move-comp** (5 steps): remove_plugin,load_builtin,list_builtins,remove_plugin,load_builtin,list_builtins — plugin ~"comp" missing
- **amb-make-better** (8 steps): list_builtins,list_builtins,create_section,create_section,create_section,load_master_builtin,load_master_builtin,create_bus,add_send,add_send,set_track_pan,set_track_pan,set_track_volume,set_track_volume,set_track_volume,save — emitted 16 command(s) on a defer case
- **amb-fix-timing** (4 steps): quantize_notes,set_clip_warp,set_clip_warp,quantize_notes,set_clip_warp,set_clip_warp — emitted 6 command(s) on a defer case
- **amb-upload** (3 steps): list_builtins,list_builtins,load_master_builtin,load_master_builtin,load_master_builtin — emitted 5 command(s) on a defer case
