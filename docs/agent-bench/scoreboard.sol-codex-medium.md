# MoshAgentBench — sol-codex-medium

model `gpt-5.6-sol` @ `codex-cli(subscription)` · runner **single** · 21/34 = **61.8%** · 2026-07-28

step-eff 100.0% · cmd-err 8.8% · invalid 2.9% · wrong-defers 5 · defer-correct 100.0% · tokens 767849+5911 (34 calls)

| category | pass | tasks |
|---|---|---|
| arrange | 5/6 | ✓arr-clear-middle ✓arr-close-gap ✓arr-loop-first-second ✗arr-split-dup ✓arr-map-sections ✓arr-move-trim |
| compose-drums | 2/4 | ✗drums-boombap ✗drums-new-hats ✓drums-trap-sketch ✓drums-mute-hat-lane |
| compose-melody | 2/4 | ✓mel-bass-in-key ✗mel-keys-in-key ✗mel-quantize ✓mel-set-key |
| mix | 3/5 | ✓mix-balance ✗mix-vocal-space ✗mix-submix ✓mix-clip-not-fader ✓mix-cleanup |
| master | 0/3 | ✗master-glue ✗master-eq-before-comp ✗master-trim |
| generative | 2/3 | ✓gen-lofi ✗gen-reimagine-subtle ✓gen-run-render |
| lyrics | 2/2 | ✓lyr-start-sheet ✓lyr-first-line |
| repair | 1/3 | ✓rep-clipping-808 ✗rep-move-comp ✗rep-rogue-tempo |
| ambiguous | 4/4 | ✓amb-make-better ✓amb-delete-bad ✓amb-fix-timing ✓amb-upload |

Failures:
- **arr-split-dup** (1 steps): deferred — Δclips 0 ≠ 2; split_clip ×0 < 1; duplicate_clip ×0 < 1
- **drums-boombap** (1 steps): set_tempo,add_drum_pattern — Δtracks 0 ≠ 1; add_drum_pattern ×0 < 1; 0 notes < 8
- **drums-new-hats** (1 steps): add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **mel-keys-in-key** (1 steps): deferred — add_note ×0 < 4; 0 in-key notes < 4
- **mel-quantize** (1 steps): quantize_notes — quantize_notes ×0 < 1
- **mix-vocal-space** (1 steps): create_bus,set_track_volume — "Vocal" has no sends
- **mix-submix** (1 steps): create_track — set_track_output ×0 < 2
- **master-glue** (1 steps): list_builtins — master ~"comp" missing (chain: empty)
- **master-eq-before-comp** (1 steps): deferred — master ~"eq" missing (chain: Compressor); master chain missing "eq"
- **master-trim** (1 steps): set_master_volume — master volumeDb Δ1.0 not down within [1,6]
- **gen-reimagine-subtle** (1 steps): compile_render — hasRenderLayer=false ≠ true
- **rep-move-comp** (1 steps): deferred — plugin ~"comp" unexpectedly present; plugin ~"comp" missing
- **rep-rogue-tempo** (1 steps): deferred — tempo point at 4s unexpectedly present; remove_tempo_change ×0 < 1
