# MoshAgentBench — sol-http-full-a

model `gpt-5.6-sol` @ `https://api.openai.com/v1` · runner **single** · 27/34 = **79.4%** · 2026-07-28

step-eff 100.0% · cmd-err 5.4% · invalid 0.0% · wrong-defers 0 · defer-correct 100.0% · tokens 138016+4766 (34 calls)

| category | pass | tasks |
|---|---|---|
| arrange | 5/6 | ✓arr-clear-middle ✓arr-close-gap ✓arr-loop-first-second ✗arr-split-dup ✓arr-map-sections ✓arr-move-trim |
| compose-drums | 2/4 | ✗drums-boombap ✗drums-new-hats ✓drums-trap-sketch ✓drums-mute-hat-lane |
| compose-melody | 4/4 | ✓mel-bass-in-key ✓mel-keys-in-key ✓mel-quantize ✓mel-set-key |
| mix | 4/5 | ✓mix-balance ✓mix-vocal-space ✗mix-submix ✓mix-clip-not-fader ✓mix-cleanup |
| master | 1/3 | ✗master-glue ✗master-eq-before-comp ✓master-trim |
| generative | 3/3 | ✓gen-lofi ✓gen-reimagine-subtle ✓gen-run-render |
| lyrics | 2/2 | ✓lyr-start-sheet ✓lyr-first-line |
| repair | 2/3 | ✓rep-clipping-808 ✗rep-move-comp ✓rep-rogue-tempo |
| ambiguous | 4/4 | ✓amb-make-better ✓amb-delete-bad ✓amb-fix-timing ✓amb-upload |

Failures:
- **arr-split-dup** (1 steps): split_clip — Δclips 1 ≠ 2; duplicate_clip ×0 < 1
- **drums-boombap** (1 steps): set_tempo,create_track,add_drum_pattern — add_drum_pattern ×0 < 1; 0 notes < 8
- **drums-new-hats** (1 steps): set_track_type,add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **mix-submix** (1 steps): create_track — set_track_output ×0 < 2
- **master-glue** (1 steps): list_builtins — master ~"comp" missing (chain: empty)
- **master-eq-before-comp** (1 steps): list_builtins — master ~"eq" missing (chain: Compressor); master chain missing "eq"
- **rep-move-comp** (1 steps): remove_plugin,load_builtin — plugin ~"comp" unexpectedly present; plugin ~"comp" missing
