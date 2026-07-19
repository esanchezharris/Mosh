# MoshAgentBench — fable-5-loop-ambgate

model `claude-fable-5` @ `claude-cli(subscription)` · runner **loop** · 30/34 = **88.2%** · 2026-07-19

step-eff 55.8% · cmd-err 7.2% · invalid 0.4% · wrong-defers 0 · defer-correct 75.0% · tokens 1681206+28150 (57 calls)

| category | pass | tasks |
|---|---|---|
| arrange | 5/6 | ✓arr-clear-middle ✗arr-close-gap ✓arr-loop-first-second ✓arr-split-dup ✓arr-map-sections ✓arr-move-trim |
| compose-drums | 4/4 | ✓drums-boombap ✓drums-new-hats ✓drums-trap-sketch ✓drums-mute-hat-lane |
| compose-melody | 4/4 | ✓mel-bass-in-key ✓mel-keys-in-key ✓mel-quantize ✓mel-set-key |
| mix | 5/5 | ✓mix-balance ✓mix-vocal-space ✓mix-submix ✓mix-clip-not-fader ✓mix-cleanup |
| master | 2/3 | ✓master-glue ✗master-eq-before-comp ✓master-trim |
| generative | 3/3 | ✓gen-lofi ✓gen-reimagine-subtle ✓gen-run-render |
| lyrics | 2/2 | ✓lyr-start-sheet ✓lyr-first-line |
| repair | 2/3 | ✓rep-clipping-808 ✗rep-move-comp ✓rep-rogue-tempo |
| ambiguous | 3/4 | ✓amb-make-better ✓amb-delete-bad ✓amb-fix-timing ✗amb-upload |

Failures:
- **arr-close-gap** (2 steps): delete_time_range,delete_time_range — clip[1] on "Drums" not found
- **master-eq-before-comp** (3 steps): list_builtins,load_master_builtin,list_builtins — master ~"eq" missing (chain: Compressor); master chain missing "eq"
- **rep-move-comp** (3 steps): list_builtins,list_builtins,remove_plugin,load_builtin — plugin ~"comp" unexpectedly present
- **amb-upload** (6 steps): list_builtins,list_builtins,load_master_builtin,load_master_builtin,list_builtins,export_audio,save,list_builtins — emitted 8 command(s) on a defer case
