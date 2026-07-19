# MoshAgentBench — kimi-k3-loop

model `moonshotai/kimi-k3` @ `https://openrouter.ai/api/v1` · runner **loop** · 24/34 = **70.6%** · 2026-07-19

step-eff 47.2% · cmd-err 12.7% · invalid 2.7% · wrong-defers 1 · defer-correct 25.0% · tokens 292265+48214 (64 calls)

| category | pass | tasks |
|---|---|---|
| arrange | 4/6 | ✓arr-clear-middle ✗arr-close-gap ✓arr-loop-first-second ✗arr-split-dup ✓arr-map-sections ✓arr-move-trim |
| compose-drums | 2/4 | ✓drums-boombap ✗drums-new-hats ✗drums-trap-sketch ✓drums-mute-hat-lane |
| compose-melody | 4/4 | ✓mel-bass-in-key ✓mel-keys-in-key ✓mel-quantize ✓mel-set-key |
| mix | 4/5 | ✓mix-balance ✗mix-vocal-space ✓mix-submix ✓mix-clip-not-fader ✓mix-cleanup |
| master | 2/3 | ✓master-glue ✗master-eq-before-comp ✓master-trim |
| generative | 3/3 | ✓gen-lofi ✓gen-reimagine-subtle ✓gen-run-render |
| lyrics | 2/2 | ✓lyr-start-sheet ✓lyr-first-line |
| repair | 2/3 | ✓rep-clipping-808 ✗rep-move-comp ✓rep-rogue-tempo |
| ambiguous | 1/4 | ✗amb-make-better ✓amb-delete-bad ✗amb-fix-timing ✗amb-upload |

Failures:
- **arr-close-gap** (2 steps): delete_time_range,delete_time_range — clip[1] on "Drums" not found
- **arr-split-dup** (0 steps): deferred — Δclips 0 ≠ 2; split_clip ×0 < 1; duplicate_clip ×0 < 1
- **drums-new-hats** (1 steps): add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **drums-trap-sketch** (2 steps): set_tempo,create_track,add_drum_pattern — 0 notes < 16
- **mix-vocal-space** (4 steps): create_bus,set_track_volume,create_bus,set_track_volume,add_send,list_builtins,load_builtin — Δbuses 2 ≠ 1
- **master-eq-before-comp** (4 steps): list_builtins,list_builtins,load_master_builtin,list_builtins — master ~"eq" missing (chain: Compressor); master chain missing "eq"
- **rep-move-comp** (4 steps): list_builtins,remove_plugin,list_builtins,remove_plugin,load_builtin — plugin ~"comp" unexpectedly present
- **amb-make-better** (5 steps): quantize_notes,normalize_clip,normalize_clip,set_clip_fade,set_clip_fade,list_builtins,quantize_notes,normalize_clip,normalize_clip,set_clip_fade,set_clip_fade,list_builtins,create_bus,load_builtin,add_send,add_send,set_track_volume,set_track_volume,set_track_pan,list_builtins — emitted 20 command(s) on a defer case
- **amb-fix-timing** (4 steps): quantize_notes,quantize_notes,set_clip_warp,set_clip_warp — emitted 4 command(s) on a defer case
- **amb-upload** (4 steps): list_builtins,load_master_builtin,load_master_builtin,load_master_builtin,list_builtins,list_plugins,load_master_builtin — emitted 7 command(s) on a defer case
