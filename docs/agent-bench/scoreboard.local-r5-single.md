# MoshAgentBench — local-r5-single

model `/Users/emiliosanchez-harris/AI/models/fused/a3b-r5-4bit-hd` @ `http://127.0.0.1:8080/v1` · runner **single** · 17/34 = **50.0%** · 2026-07-28

step-eff 100.0% · cmd-err 22.1% · invalid 7.4% · wrong-defers 1 · defer-correct 25.0% · tokens 137319+2563 (34 calls)

| category | pass | tasks |
|---|---|---|
| arrange | 4/6 | ✗arr-clear-middle ✓arr-close-gap ✓arr-loop-first-second ✓arr-split-dup ✓arr-map-sections ✗arr-move-trim |
| compose-drums | 1/4 | ✗drums-boombap ✗drums-new-hats ✗drums-trap-sketch ✓drums-mute-hat-lane |
| compose-melody | 3/4 | ✓mel-bass-in-key ✓mel-keys-in-key ✗mel-quantize ✓mel-set-key |
| mix | 3/5 | ✓mix-balance ✗mix-vocal-space ✗mix-submix ✓mix-clip-not-fader ✓mix-cleanup |
| master | 0/3 | ✗master-glue ✗master-eq-before-comp ✗master-trim |
| generative | 3/3 | ✓gen-lofi ✓gen-reimagine-subtle ✓gen-run-render |
| lyrics | 1/2 | ✗lyr-start-sheet ✓lyr-first-line |
| repair | 1/3 | ✓rep-clipping-808 ✗rep-move-comp ✗rep-rogue-tempo |
| ambiguous | 1/4 | ✓amb-make-better ✗amb-delete-bad ✗amb-fix-timing ✗amb-upload |

Failures:
- **arr-clear-middle** (1 steps): delete_time_range — clip [4.00,5.00] on "Vocal" overlaps [4,8]
- **arr-move-trim** (1 steps): move_clip — start 1s ∉ [1.9,2.1]; length=4 ≠ 2
- **drums-boombap** (1 steps): create_track,create_section,add_drum_pattern — tempo 120 ≠ 90; add_drum_pattern ×0 < 1; 0 notes < 8
- **drums-new-hats** (1 steps): add_drum_pattern — add_drum_pattern ×0 < 1; Δtracks 0 ≠ 1
- **drums-trap-sketch** (1 steps): deferred — tempo 120 ≠ 140; add_drum_pattern ×0 < 1; 0 notes < 16
- **mel-quantize** (1 steps): quantize_notes — quantize_notes ×0 < 1
- **mix-vocal-space** (1 steps): add_send,add_send,create_bus — "Vocal" has no sends; volumeDb Δ0.0 not down within [1,4]
- **mix-submix** (1 steps): create_track — set_track_output ×0 < 2
- **master-glue** (1 steps): load_master_builtin — master ~"comp" missing (chain: empty)
- **master-eq-before-comp** (1 steps): load_master_builtin,load_master_builtin — master ~"eq" missing (chain: Compressor); master chain missing "eq"
- **master-trim** (1 steps): set_master_volume — master volumeDb Δ1.0 not down within [1,6]
- **lyr-start-sheet** (1 steps): create_lyric_sheet — create_lyric_sheet ×0 < 1
- **rep-move-comp** (1 steps): set_track_type — plugin ~"comp" unexpectedly present; plugin ~"comp" missing
- **rep-rogue-tempo** (1 steps): delete_time_range — tempo point at 4s unexpectedly present; remove_tempo_change ×0 < 1
- **amb-delete-bad** (1 steps): remove_clip — emitted 1 command(s) on a defer case
- **amb-fix-timing** (1 steps): create_section — emitted 1 command(s) on a defer case
- **amb-upload** (1 steps): export_audio — emitted 1 command(s) on a defer case
