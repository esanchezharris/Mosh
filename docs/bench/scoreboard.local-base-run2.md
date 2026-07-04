# Moshi-Bench v0 — local-base-run2

model `mlx-community/Qwen3-4B-Instruct-2507-4bit` · 19/35 = **54.3%** · 2026-07-02 · tokens 84380+2275

| area | pass | cases |
|---|---|---|
| session | 5/5 | ✓tempo-plain ✓tempo-slang ✓tempo-relative ✓timesig ✓undo-tempo |
| tracks | 1/4 | ✗track-create ✗track-create-drum ✓track-rename ✗track-remove |
| mixer | 5/8 | ✗vol-down-relative ✗vol-up-relative ✓vol-absolute ✓pan-hard-left ✓pan-recenter ✓mute ✗solo ✓unmute-all |
| clips | 2/4 | ✓clip-add-midi ✓clip-add-tone ✗clip-move ✗clip-split |
| notes | 1/1 | ✓notes-populate |
| transport | 1/4 | ✓transport-play ✗transport-stop ✗transport-seek ✗transport-loop-on |
| sections | 1/2 | ✓section-create ✗section-rename |
| fx | 0/2 | ✗fx-ott ✗fx-autotune |
| defer | 3/3 | ✓defer-ambiguous ✓defer-vague ✓defer-impossible |
| corrective | 0/2 | ✗corr-drums-drowning ✗corr-808-lost |

Failures:
- **track-create**: create_track — "Guitar" missing; Δtracks 0 ≠ 1
- **track-create-drum**: set_track_type,load_drum_kit — Δtracks 0 ≠ 1
- **track-remove**: deferred — "Vocal" unexpectedly exists; Δtracks 0 ≠ -1
- **vol-down-relative**: deferred — volumeDb Δ0.0 not down within [1,15]
- **vol-up-relative**: deferred — volumeDb Δ0.0 not up within [1,18]
- **solo**: deferred — solo=false ≠ true
- **clip-move**: set_tempo,set_time_signature,move_clip — start 180s ∉ [3.5,4.5]
- **clip-split**: deferred — Δclips 0 ≠ 1
- **transport-stop**: deferred — 
- **transport-seek**: set_transport — pos 5s ∉ [7.5,8.5]
- **transport-loop-on**: deferred — looping=false ≠ true
- **section-rename**: rename_section — section "Cold Open" missing (have: Intro); section "Intro" unexpectedly exists
- **fx-ott**: deferred — plugin ~"ott" missing
- **fx-autotune**: deferred — plugin ~"tune" missing
- **corr-drums-drowning**: set_track_mute — volumeDb Δ0.0 not down within [3,20]
- **corr-808-lost**: set_track_mute — volumeDb Δ0.0 not up within [3,24]
