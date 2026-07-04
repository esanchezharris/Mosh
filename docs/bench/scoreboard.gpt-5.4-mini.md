# Moshi-Bench v0 — gpt-5.4-mini

model `gpt-5.4-mini` · 31/35 = **88.6%** · 2026-07-02 · tokens 83432+1499

| area | pass | cases |
|---|---|---|
| session | 5/5 | ✓tempo-plain ✓tempo-slang ✓tempo-relative ✓timesig ✓undo-tempo |
| tracks | 4/4 | ✓track-create ✓track-create-drum ✓track-rename ✓track-remove |
| mixer | 8/8 | ✓vol-down-relative ✓vol-up-relative ✓vol-absolute ✓pan-hard-left ✓pan-recenter ✓mute ✓solo ✓unmute-all |
| clips | 4/4 | ✓clip-add-midi ✓clip-add-tone ✓clip-move ✓clip-split |
| notes | 1/1 | ✓notes-populate |
| transport | 3/4 | ✗transport-play ✓transport-stop ✓transport-seek ✓transport-loop-on |
| sections | 1/2 | ✓section-create ✗section-rename |
| fx | 0/2 | ✗fx-ott ✗fx-autotune |
| defer | 3/3 | ✓defer-ambiguous ✓defer-vague ✓defer-impossible |
| corrective | 2/2 | ✓corr-drums-drowning ✓corr-808-lost |

Failures:
- **transport-play**: set_transport — playing=false ≠ true
- **section-rename**: rename_section — section "Cold Open" missing (have: Intro); section "Intro" unexpectedly exists
- **fx-ott**: deferred — plugin ~"ott" missing
- **fx-autotune**: deferred — plugin ~"tune" missing
