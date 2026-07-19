# MoshAgentBench — fable-5-loop

model `claude-fable-5` @ `claude-cli(subscription)` · runner **loop** · 25/34 = **73.5%** · 2026-07-19

step-eff 51.7% · cmd-err 14.8% · invalid 0.5% · wrong-defers 1 · defer-correct 25.0% · tokens 2220383+42451 (72 calls)

| category | pass | tasks |
|---|---|---|
| arrange | 4/6 | ✓arr-clear-middle ✗arr-close-gap ✗arr-loop-first-second ✓arr-split-dup ✓arr-map-sections ✓arr-move-trim |
| compose-drums | 4/4 | ✓drums-boombap ✓drums-new-hats ✓drums-trap-sketch ✓drums-mute-hat-lane |
| compose-melody | 4/4 | ✓mel-bass-in-key ✓mel-keys-in-key ✓mel-quantize ✓mel-set-key |
| mix | 4/5 | ✗mix-balance ✓mix-vocal-space ✓mix-submix ✓mix-clip-not-fader ✓mix-cleanup |
| master | 1/3 | ✗master-glue ✗master-eq-before-comp ✓master-trim |
| generative | 3/3 | ✓gen-lofi ✓gen-reimagine-subtle ✓gen-run-render |
| lyrics | 2/2 | ✓lyr-start-sheet ✓lyr-first-line |
| repair | 2/3 | ✓rep-clipping-808 ✗rep-move-comp ✓rep-rogue-tempo |
| ambiguous | 1/4 | ✗amb-make-better ✓amb-delete-bad ✗amb-fix-timing ✗amb-upload |

Failures:
- **arr-close-gap** (2 steps): delete_time_range,delete_time_range — start 8s ∉ [3.9,4.1]
- **arr-loop-first-second** (3 steps): set_clip_loop,trim_clip,set_clip_loop — loopEnabled=undefined ≠ true; set_clip_loop ×0 < 1
- **mix-balance** (0 steps): deferred — volumeDb Δ0.0 not down within [1.5,6]; pan=0 < 0.05
- **master-glue** (2 steps): list_builtins,load_master_builtin — master ~"comp" missing (chain: empty)
- **master-eq-before-comp** (4 steps): list_builtins,list_builtins,load_master_builtin,load_master_builtin,list_plugins — master ~"eq" missing (chain: empty); master chain missing "eq"
- **rep-move-comp** (3 steps): list_builtins,list_builtins,remove_plugin,load_builtin — plugin ~"comp" unexpectedly present
- **amb-make-better** (7 steps): set_clip_warp,set_clip_warp,normalize_clip,normalize_clip,set_clip_gain,set_clip_gain,set_clip_warp,set_clip_warp,normalize_clip,normalize_clip,create_bus,list_builtins,create_bus,remove_bus,load_builtin,add_send,set_track_pan,set_track_volume,save — emitted 19 command(s) on a defer case
- **amb-fix-timing** (4 steps): quantize_notes,quantize_notes,set_clip_warp,set_clip_warp,save — emitted 5 command(s) on a defer case
- **amb-upload** (5 steps): list_builtins,list_builtins,load_master_builtin,load_master_builtin,list_plugins,export_audio — emitted 6 command(s) on a defer case
