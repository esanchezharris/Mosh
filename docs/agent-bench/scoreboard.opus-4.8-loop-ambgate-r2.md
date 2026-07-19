# MoshAgentBench — opus-4.8-loop-ambgate-r2

model `claude-opus-4-8` @ `claude-cli(subscription)` · runner **loop** · 26/34 = **76.5%** · 2026-07-19

step-eff 44.9% · cmd-err 7.9% · invalid 0.4% · wrong-defers 1 · defer-correct 75.0% · tokens 2847025+34356 (53 calls)

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
| ambiguous | 3/4 | ✓amb-make-better ✓amb-delete-bad ✓amb-fix-timing ✗amb-upload |

Failures:
- **arr-close-gap** (2 steps): delete_time_range,delete_time_range — clip[1] on "Drums" not found
- **arr-split-dup** (0 steps): deferred — Δclips 0 ≠ 2; split_clip ×0 < 1; duplicate_clip ×0 < 1
- **drums-new-hats** (3 steps): create_track,create_track,add_drum_pattern — Δtracks 2 ≠ 1
- **drums-trap-sketch** (2 steps): set_tempo,create_track,add_drum_pattern — 0 notes < 16
- **mix-vocal-space** (3 steps): create_bus,set_track_volume,create_bus,set_track_volume,load_builtin,add_send — Δbuses 2 ≠ 1
- **master-eq-before-comp** (3 steps): list_builtins,load_master_builtin,list_builtins — master ~"eq" missing (chain: Compressor); master chain missing "eq"
- **rep-move-comp** (4 steps): list_builtins,list_builtins,remove_plugin,load_builtin,list_builtins — plugin ~"comp" unexpectedly present; plugin ~"comp" missing
- **amb-upload** (4 steps): list_builtins,load_master_builtin,load_master_builtin,load_master_builtin,list_builtins,export_audio — emitted 6 command(s) on a defer case
