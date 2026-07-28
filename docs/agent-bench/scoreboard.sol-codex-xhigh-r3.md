# MoshAgentBench — sol-codex-xhigh-r3

model `gpt-5.6-sol` @ `codex-cli(subscription)` · runner **single** · 31/46 = **67.4%** · 2026-07-28

step-eff 100.0% · cmd-err 6.6% · invalid 2.2% · wrong-defers 6 · defer-correct 100.0% · tokens 1425667+13503 (63 calls)

| category | pass | tasks |
|---|---|---|
| arrange | 5/6 | ✓arr-clear-middle ✓arr-close-gap ✓arr-loop-first-second ✗arr-split-dup ✓arr-map-sections ✓arr-move-trim |
| compose-drums | 2/4 | ✗drums-boombap ✗drums-new-hats ✓drums-trap-sketch ✓drums-mute-hat-lane |
| compose-melody | 2/4 | ✓mel-bass-in-key ✗mel-keys-in-key ✗mel-quantize ✓mel-set-key |
| mix | 4/5 | ✓mix-balance ✓mix-vocal-space ✗mix-submix ✓mix-clip-not-fader ✓mix-cleanup |
| master | 1/3 | ✓master-glue ✗master-eq-before-comp ✗master-trim |
| generative | 2/3 | ✓gen-lofi ✗gen-reimagine-subtle ✓gen-run-render |
| lyrics | 2/2 | ✓lyr-start-sheet ✓lyr-first-line |
| repair | 1/3 | ✓rep-clipping-808 ✗rep-move-comp ✗rep-rogue-tempo |
| ambiguous | 4/4 | ✓amb-make-better ✓amb-delete-bad ✓amb-fix-timing ✓amb-upload |
| converse-clarify | 1/3 | ✗conv-clarify-louder ✓conv-clarify-trim ✗conv-clarify-two-step |
| converse-correct | 3/3 | ✓conv-correct-too-much ✓conv-correct-wrong-track ✓conv-correct-undo |
| converse-session | 2/3 | ✗conv-session-beat ✓conv-session-arrange ✓conv-session-mix |
| converse-recover | 2/3 | ✗conv-recover-clipping ✓conv-recover-solo ✓conv-recover-tempo |

Failures:
- **arr-split-dup** (1 steps): deferred — Δclips 0 ≠ 2; split_clip ×0 < 1; duplicate_clip ×0 < 1
- **drums-boombap** (1 steps): set_tempo,create_track,add_drum_pattern — Δtracks 2 ≠ 1
- **drums-new-hats** (1 steps): add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **mel-keys-in-key** (1 steps): deferred — add_note ×0 < 4; 0 in-key notes < 4
- **mel-quantize** (1 steps): quantize_notes — quantize_notes ×0 < 1
- **mix-submix** (1 steps): deferred — "Rhythm" missing; set_track_output ×0 < 2
- **master-eq-before-comp** (1 steps): deferred — master ~"eq" missing (chain: Compressor); master chain missing "eq"
- **master-trim** (1 steps): set_master_volume — master volumeDb Δ1.0 not down within [1,6]
- **gen-reimagine-subtle** (1 steps): compile_render — hasRenderLayer=false ≠ true
- **rep-move-comp** (1 steps): deferred — plugin ~"comp" unexpectedly present; plugin ~"comp" missing
- **rep-rogue-tempo** (1 steps): deferred — tempo point at 4s unexpectedly present; remove_tempo_change ×0 < 1
- **conv-clarify-louder** (2 steps): set_master_volume,set_track_volume — turn 0 acted (1 command(s)) instead of asking
- **conv-clarify-two-step** (3 steps): set_track_volume,set_track_volume,set_track_volume,set_track_volume,set_master_volume,set_track_volume — 5 command(s) emitted before turn 2; volumeDb Δ-12.0 not down within [2,6]
- **conv-session-beat** (4 steps): set_tempo,add_drum_pattern,create_track,add_drum_pattern,set_key,create_track — track "Bass" not found
- **conv-recover-clipping** (2 steps): set_track_volume,set_track_volume — net level Δ6.0 dB not down ≥ 5
