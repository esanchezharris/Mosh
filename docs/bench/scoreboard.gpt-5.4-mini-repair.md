# Moshi-Bench v0 — gpt-5.4-mini-repair

model `gpt-5.4-mini` · 30/35 = **85.7%** · 2026-07-02 · tokens 88495+1714

| area | pass | cases |
|---|---|---|
| session | 5/5 | ✓tempo-plain ✓tempo-slang ✓tempo-relative ✓timesig ✓undo-tempo |
| tracks | 4/4 | ✓track-create ✓track-create-drum ✓track-rename ✓track-remove |
| mixer | 8/8 | ✓vol-down-relative ✓vol-up-relative ✓vol-absolute ✓pan-hard-left ✓pan-recenter ✓mute ✓solo ✓unmute-all |
| clips | 3/4 | ✓clip-add-midi ✓clip-add-tone ✓clip-move ✗clip-split |
| notes | 1/1 | ✓notes-populate |
| transport | 4/4 | ✓transport-play ✓transport-stop ✓transport-seek ✓transport-loop-on |
| sections | 1/2 | ✓section-create ✗section-rename |
| fx | 0/2 | ✗fx-ott ✗fx-autotune |
| defer | 3/3 | ✓defer-ambiguous ✓defer-vague ✓defer-impossible |
| corrective | 1/2 | ✗corr-drums-drowning ✓corr-808-lost |

Failures:
- **clip-split**: deferred — Δclips 0 ≠ 1
- **section-rename**: rename_section — section "Cold Open" missing (have: Intro); section "Intro" unexpectedly exists
- **fx-ott**: load_builtin — plugin ~"ott" missing
- **fx-autotune**: deferred — plugin ~"tune" missing
- **corr-drums-drowning**: deferred — volumeDb Δ0.0 not down within [3,20]
