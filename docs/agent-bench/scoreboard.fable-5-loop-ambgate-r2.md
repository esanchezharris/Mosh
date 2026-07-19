# MoshAgentBench — fable-5-loop-ambgate-r2

model `claude-fable-5` @ `claude-cli(subscription)` · runner **loop** · 29/34 = **85.3%** · 2026-07-19

step-eff 54.7% · cmd-err 9.7% · invalid 0.0% · wrong-defers 0 · defer-correct 75.0% · tokens 1740130+32262 (59 calls)

| category | pass | tasks |
|---|---|---|
| arrange | 5/6 | ✓arr-clear-middle ✓arr-close-gap ✓arr-loop-first-second ✗arr-split-dup ✓arr-map-sections ✓arr-move-trim |
| compose-drums | 3/4 | ✓drums-boombap ✗drums-new-hats ✓drums-trap-sketch ✓drums-mute-hat-lane |
| compose-melody | 4/4 | ✓mel-bass-in-key ✓mel-keys-in-key ✓mel-quantize ✓mel-set-key |
| mix | 5/5 | ✓mix-balance ✓mix-vocal-space ✓mix-submix ✓mix-clip-not-fader ✓mix-cleanup |
| master | 2/3 | ✓master-glue ✗master-eq-before-comp ✓master-trim |
| generative | 3/3 | ✓gen-lofi ✓gen-reimagine-subtle ✓gen-run-render |
| lyrics | 2/2 | ✓lyr-start-sheet ✓lyr-first-line |
| repair | 2/3 | ✓rep-clipping-808 ✗rep-move-comp ✓rep-rogue-tempo |
| ambiguous | 3/4 | ✓amb-make-better ✓amb-delete-bad ✓amb-fix-timing ✗amb-upload |

Failures:
- **arr-split-dup** (3 steps): list_takes,list_takes,detect_clip_bpm,split_clip — Δclips 0 ≠ 2; split_clip ×0 < 1; duplicate_clip ×0 < 1
- **drums-new-hats** (4 steps): set_track_type,set_track_type,add_drum_pattern,create_track — add_drum_pattern ×0 < 1
- **master-eq-before-comp** (2 steps): list_builtins,load_master_builtin — master ~"eq" missing (chain: Compressor); master chain missing "eq"
- **rep-move-comp** (4 steps): list_builtins,list_builtins,remove_plugin,load_builtin — plugin ~"comp" unexpectedly present
- **amb-upload** (6 steps): list_builtins,list_builtins,load_master_builtin,load_master_builtin,load_master_builtin,load_master_builtin,load_master_builtin,list_builtins,list_plugins,export_audio,save — emitted 11 command(s) on a defer case
