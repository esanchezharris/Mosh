# MoshAgentBench — gpt-5.6-sol-codex3-loop

model `gpt-5.6-sol` @ `codex-cli(subscription)` · runner **loop** · 21/34 = **61.8%** · 2026-07-19

step-eff 82.5% · cmd-err 21.1% · invalid 2.9% · wrong-defers 1 · defer-correct 50.0% · tokens 1151361+20549 (58 calls)

| category | pass | tasks |
|---|---|---|
| arrange | 3/6 | ✓arr-clear-middle ✗arr-close-gap ✗arr-loop-first-second ✗arr-split-dup ✓arr-map-sections ✓arr-move-trim |
| compose-drums | 2/4 | ✗drums-boombap ✗drums-new-hats ✓drums-trap-sketch ✓drums-mute-hat-lane |
| compose-melody | 3/4 | ✓mel-bass-in-key ✓mel-keys-in-key ✗mel-quantize ✓mel-set-key |
| mix | 5/5 | ✓mix-balance ✓mix-vocal-space ✓mix-submix ✓mix-clip-not-fader ✓mix-cleanup |
| master | 1/3 | ✗master-glue ✗master-eq-before-comp ✓master-trim |
| generative | 2/3 | ✓gen-lofi ✓gen-reimagine-subtle ✗gen-run-render |
| lyrics | 1/2 | ✓lyr-start-sheet ✗lyr-first-line |
| repair | 2/3 | ✓rep-clipping-808 ✗rep-move-comp ✓rep-rogue-tempo |
| ambiguous | 2/4 | ✗amb-make-better ✓amb-delete-bad ✓amb-fix-timing ✗amb-upload |

Failures:
- **arr-close-gap** (1 steps): delete_time_range — start 8s ∉ [3.9,4.1]
- **arr-loop-first-second** (1 steps): set_clip_loop — loopEnabled=undefined ≠ true; set_clip_loop ×0 < 1
- **arr-split-dup** (0 steps): deferred — Δclips 0 ≠ 2; split_clip ×0 < 1; duplicate_clip ×0 < 1
- **drums-boombap** (3 steps): set_tempo,create_track,add_drum_pattern — add_drum_pattern ×0 < 1; 0 notes < 8
- **drums-new-hats** (1 steps): add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **mel-quantize** (1 steps): quantize_notes — quantize_notes ×0 < 1
- **master-glue** (1 steps): list_builtins — master ~"comp" missing (chain: empty)
- **master-eq-before-comp** (2 steps): list_builtins,load_master_builtin,load_master_builtin — master ~"eq" missing (chain: empty); master chain missing "eq"
- **gen-run-render** (1 steps): create_render_layer — render_layer ×0 < 1
- **lyr-first-line** (1 steps): create_lyric_sheet — set_lyric_line ×0 < 1
- **rep-move-comp** (4 steps): list_builtins,list_plugins,remove_plugin,load_builtin,list_track_outputs,save — plugin ~"comp" unexpectedly present
- **amb-make-better** (4 steps): normalize_clip,normalize_clip,set_track_volume,set_track_volume,set_track_volume,set_track_pan,set_track_volume,set_track_volume,set_track_volume,set_track_pan,list_builtins — emitted 11 command(s) on a defer case
- **amb-upload** (1 steps): list_builtins,list_plugins — emitted 2 command(s) on a defer case
