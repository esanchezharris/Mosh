# MoshAgentBench — sonnet-5-loop

model `anthropic/claude-sonnet-5` @ `https://openrouter.ai/api/v1` · runner **loop** · 28/34 = **82.4%** · 2026-07-19

step-eff 56.5% · cmd-err 14.4% · invalid 1.3% · wrong-defers 0 · defer-correct 50.0% · tokens 506578+36491 (73 calls)

| category | pass | tasks |
|---|---|---|
| arrange | 5/6 | ✓arr-clear-middle ✗arr-close-gap ✓arr-loop-first-second ✓arr-split-dup ✓arr-map-sections ✓arr-move-trim |
| compose-drums | 3/4 | ✓drums-boombap ✗drums-new-hats ✓drums-trap-sketch ✓drums-mute-hat-lane |
| compose-melody | 4/4 | ✓mel-bass-in-key ✓mel-keys-in-key ✓mel-quantize ✓mel-set-key |
| mix | 5/5 | ✓mix-balance ✓mix-vocal-space ✓mix-submix ✓mix-clip-not-fader ✓mix-cleanup |
| master | 2/3 | ✓master-glue ✗master-eq-before-comp ✓master-trim |
| generative | 3/3 | ✓gen-lofi ✓gen-reimagine-subtle ✓gen-run-render |
| lyrics | 2/2 | ✓lyr-start-sheet ✓lyr-first-line |
| repair | 2/3 | ✓rep-clipping-808 ✗rep-move-comp ✓rep-rogue-tempo |
| ambiguous | 2/4 | ✗amb-make-better ✓amb-delete-bad ✓amb-fix-timing ✗amb-upload |

Failures:
- **arr-close-gap** (3 steps): delete_time_range,delete_time_range,save — clip[1] on "Drums" not found
- **drums-new-hats** (1 steps): add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **master-eq-before-comp** (5 steps): load_master_builtin,list_builtins,load_master_builtin,list_builtins,load_master_builtin — master ~"eq" missing (chain: Compressor); master chain missing "eq"
- **rep-move-comp** (4 steps): list_builtins,list_builtins,remove_plugin,load_builtin — plugin ~"comp" unexpectedly present
- **amb-make-better** (3 steps): list_builtins,list_builtins,create_bus,load_builtin,add_send,add_send,add_send — emitted 7 command(s) on a defer case
- **amb-upload** (7 steps): list_builtins,list_builtins,load_master_builtin,load_master_builtin,load_master_builtin,load_master_builtin,load_master_builtin,list_builtins,set_master_volume,set_master_plugin_param,set_master_plugin_param,export_audio — emitted 12 command(s) on a defer case
