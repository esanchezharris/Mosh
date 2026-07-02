# Moshi-Bench v0 — local-base-examples

model `mlx-community/Qwen3-4B-Instruct-2507-4bit` · 29/35 = **82.9%** · 2026-07-02 · tokens 108318+1310

| area | pass | cases |
|---|---|---|
| session | 5/5 | ✓tempo-plain ✓tempo-slang ✓tempo-relative ✓timesig ✓undo-tempo |
| tracks | 3/4 | ✓track-create ✗track-create-drum ✓track-rename ✓track-remove |
| mixer | 8/8 | ✓vol-down-relative ✓vol-up-relative ✓vol-absolute ✓pan-hard-left ✓pan-recenter ✓mute ✓solo ✓unmute-all |
| clips | 2/4 | ✓clip-add-midi ✓clip-add-tone ✗clip-move ✗clip-split |
| notes | 1/1 | ✓notes-populate |
| transport | 4/4 | ✓transport-play ✓transport-stop ✓transport-seek ✓transport-loop-on |
| sections | 1/2 | ✓section-create ✗section-rename |
| fx | 2/2 | ✓fx-ott ✓fx-autotune |
| defer | 2/3 | ✗defer-ambiguous ✓defer-vague ✓defer-impossible |
| corrective | 1/2 | ✓corr-drums-drowning ✗corr-808-lost |

Failures:
- **track-create-drum**: set_track_type — Δtracks 0 ≠ 1
- **clip-move**: move_clip — start 8s ∉ [3.5,4.5]
- **clip-split**: split_clip — Δclips 0 ≠ 1
- **section-rename**: rename_section — section "Cold Open" missing (have: Intro); section "Intro" unexpectedly exists
- **defer-ambiguous**: set_master_volume — emitted 1 command(s) on a defer case
- **corr-808-lost**: set_track_mute — volumeDb Δ0.0 not up within [3,24]
