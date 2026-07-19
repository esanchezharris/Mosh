# MoshAgentBench — gpt-5.4-mini-repair

model `gpt-5.4-mini` @ `https://api.openai.com/v1` · runner **single-repair** · 20/34 = **58.8%** · 2026-07-19

step-eff 94.1% · cmd-err 13.4% · invalid 4.5% · wrong-defers 3 · defer-correct 75.0% · tokens 176721+2863 (44 calls)

| category | pass | tasks |
|---|---|---|
| arrange | 5/6 | ✓arr-clear-middle ✓arr-close-gap ✓arr-loop-first-second ✗arr-split-dup ✓arr-map-sections ✓arr-move-trim |
| compose-drums | 1/4 | ✗drums-boombap ✗drums-new-hats ✗drums-trap-sketch ✓drums-mute-hat-lane |
| compose-melody | 2/4 | ✓mel-bass-in-key ✗mel-keys-in-key ✗mel-quantize ✓mel-set-key |
| mix | 4/5 | ✓mix-balance ✓mix-vocal-space ✗mix-submix ✓mix-clip-not-fader ✓mix-cleanup |
| master | 0/3 | ✗master-glue ✗master-eq-before-comp ✗master-trim |
| generative | 2/3 | ✓gen-lofi ✓gen-reimagine-subtle ✗gen-run-render |
| lyrics | 2/2 | ✓lyr-start-sheet ✓lyr-first-line |
| repair | 1/3 | ✓rep-clipping-808 ✗rep-move-comp ✗rep-rogue-tempo |
| ambiguous | 3/4 | ✓amb-make-better ✓amb-delete-bad ✓amb-fix-timing ✗amb-upload |

Failures:
- **arr-split-dup** (2 steps): split_clip,duplicate_clip,split_clip,duplicate_clip — Δclips 3 ≠ 2
- **drums-boombap** (2 steps): set_tempo,create_track,add_drum_pattern,set_tempo,create_track,add_drum_pattern — Δtracks 2 ≠ 1; add_drum_pattern ×0 < 1; 0 notes < 8
- **drums-new-hats** (2 steps): add_drum_pattern,add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **drums-trap-sketch** (2 steps): set_tempo,create_track,add_drum_pattern,set_tempo,create_track,add_drum_pattern — add_drum_pattern ×0 < 1; 0 notes < 16
- **mel-keys-in-key** (1 steps): deferred — add_note ×0 < 4; 0 in-key notes < 4
- **mel-quantize** (1 steps): deferred — quantize_notes ×0 < 1
- **mix-submix** (2 steps): create_track,set_track_output,set_track_output,create_track,set_track_output,set_track_output — set_track_output ×0 < 2
- **master-glue** (1 steps): list_builtins — master ~"comp" missing (chain: empty)
- **master-eq-before-comp** (1 steps): list_builtins — master ~"eq" missing (chain: Compressor); master chain missing "eq"
- **master-trim** (1 steps): set_master_volume — master volumeDb Δ1.0 not down within [1,6]
- **gen-run-render** (1 steps): deferred — render_layer ×0 < 1
- **rep-move-comp** (1 steps): load_builtin,remove_plugin — plugin ~"comp" unexpectedly present
- **rep-rogue-tempo** (2 steps): split_clip,delete_time_range,remove_clip — tempo point at 4s unexpectedly present; remove_tempo_change ×0 < 1
- **amb-upload** (2 steps): load_master_builtin,set_master_plugin_param,export_audio,list_builtins,export_audio — emitted 5 command(s) on a defer case
