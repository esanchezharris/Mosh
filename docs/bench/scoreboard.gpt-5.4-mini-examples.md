# Moshi-Bench v0 — gpt-5.4-mini-examples

model `gpt-5.4-mini` · 32/35 = **91.4%** · 2026-07-02 · tokens 106288+1501

| area | pass | cases |
|---|---|---|
| session | 4/5 | ✓tempo-plain ✗tempo-slang ✓tempo-relative ✓timesig ✓undo-tempo |
| tracks | 4/4 | ✓track-create ✓track-create-drum ✓track-rename ✓track-remove |
| mixer | 8/8 | ✓vol-down-relative ✓vol-up-relative ✓vol-absolute ✓pan-hard-left ✓pan-recenter ✓mute ✓solo ✓unmute-all |
| clips | 4/4 | ✓clip-add-midi ✓clip-add-tone ✓clip-move ✓clip-split |
| notes | 1/1 | ✓notes-populate |
| transport | 3/4 | ✗transport-play ✓transport-stop ✓transport-seek ✓transport-loop-on |
| sections | 1/2 | ✓section-create ✗section-rename |
| fx | 2/2 | ✓fx-ott ✓fx-autotune |
| defer | 3/3 | ✓defer-ambiguous ✓defer-vague ✓defer-impossible |
| corrective | 2/2 | ✓corr-drums-drowning ✓corr-808-lost |

Failures:
- **tempo-slang**: deferred — tempo 120 ≠ 140
- **transport-play**: set_transport — playing=false ≠ true
- **section-rename**: rename_section — section "Cold Open" missing (have: Intro); section "Intro" unexpectedly exists
