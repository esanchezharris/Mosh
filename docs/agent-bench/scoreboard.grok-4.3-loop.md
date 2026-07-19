# MoshAgentBench — grok-4.3-loop

model `x-ai/grok-4.3` @ `https://openrouter.ai/api/v1` · runner **loop** · 26/34 = **76.5%** · 2026-07-19

step-eff 75.0% · cmd-err 9.1% · invalid 0.0% · wrong-defers 2 · defer-correct 25.0% · tokens 262912+35742 (58 calls)

| category | pass | tasks |
|---|---|---|
| arrange | 5/6 | ✓arr-clear-middle ✓arr-close-gap ✓arr-loop-first-second ✗arr-split-dup ✓arr-map-sections ✓arr-move-trim |
| compose-drums | 2/4 | ✗drums-boombap ✗drums-new-hats ✓drums-trap-sketch ✓drums-mute-hat-lane |
| compose-melody | 4/4 | ✓mel-bass-in-key ✓mel-keys-in-key ✓mel-quantize ✓mel-set-key |
| mix | 5/5 | ✓mix-balance ✓mix-vocal-space ✓mix-submix ✓mix-clip-not-fader ✓mix-cleanup |
| master | 2/3 | ✓master-glue ✗master-eq-before-comp ✓master-trim |
| generative | 3/3 | ✓gen-lofi ✓gen-reimagine-subtle ✓gen-run-render |
| lyrics | 2/2 | ✓lyr-start-sheet ✓lyr-first-line |
| repair | 2/3 | ✓rep-clipping-808 ✗rep-move-comp ✓rep-rogue-tempo |
| ambiguous | 1/4 | ✗amb-make-better ✓amb-delete-bad ✗amb-fix-timing ✗amb-upload |

Failures:
- **arr-split-dup** (0 steps): deferred — Δclips 0 ≠ 2; split_clip ×0 < 1; duplicate_clip ×0 < 1
- **drums-boombap** (5 steps): set_tempo,create_track,add_drum_pattern,add_drum_pattern,add_drum_pattern — add_drum_pattern ×0 < 1; 0 notes < 8
- **drums-new-hats** (2 steps): add_drum_pattern,set_track_type,add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **master-eq-before-comp** (3 steps): list_builtins,load_master_builtin,list_builtins — master ~"eq" missing (chain: Compressor); master chain missing "eq"
- **rep-move-comp** (0 steps): deferred — plugin ~"comp" unexpectedly present; plugin ~"comp" missing
- **amb-make-better** (8 steps): create_section,create_section,create_section,add_drum_pattern,add_midi_clip,add_note,add_note,add_note,add_note,add_note,add_note,add_midi_clip,add_note,add_note,create_bus,add_send,set_master_volume,set_tempo — emitted 18 command(s) on a defer case
- **amb-fix-timing** (2 steps): detect_clip_bpm,detect_clip_bpm,quantize_notes — emitted 3 command(s) on a defer case
- **amb-upload** (4 steps): load_master_builtin,load_master_builtin,export_audio,list_builtins,export_audio — emitted 5 command(s) on a defer case
