# FMS r11 — the floor becomes a hard invariant; sibilance gets a ruler; pineapple control (2026-07-18)

## What the owner's "piñata still broken + missing S's" round found

The owner's ear on the piñata-fix round: the fix didn't come through, sibilants are
missing, and "there should be some way to easily check for that kind of thing." Two deep
traces + a byte-exact re-derivation of the r9b author chain settled the causes — and
CORRECTED the previous increment's diagnosis:

1. **SoulX conditioning verified**: only `phoneme/duration/note_pitch/note_type` are
   consumed (`data_processor.py:44-58,131`); `text` is cosmetic; all our tokens are in
   the vocab; a miss would crash, not degrade. The phoneme fix WAS in r9b's score.
2. **Piñata's real duration defect = STRESS INVERSION, not a floor leak**: emitted
   0.282/0.150/0.268 — `word_segments` cut a 40 ms sliver at an F0 passing glide, dealt
   syllables 1:1, and the STRESSED `N-AA1` landed on the sliver (floored only to the bare
   minimum while unstressed "pi"/"ta" got ~0.28). **Registered r12 lever**: fold sub-floor
   F0-glide segments into their longer neighbor BEFORE syllables are dealt — contingent
   on the pineapple verdict.
3. **A GENUINE floor leak shipped on stage10**: "and" = 0.1233 s < 0.15 — the old
   `apply_note_floor` borrowed from i±1 only and gave up SILENTLY while "see" two tokens
   away held 0.27 s of spare; a rest drained to a 0.0000 token also survived.

## Landed

- **`apply_note_floor` is now a HARD INVARIANT** (service/soulx/score.py): phrase-scoped
  borrow (donors = the whole rest-bounded run; rests drain first, then by
  distance/spare; never across a rest) + a MERGE fallback when the run has no spare
  (continuations merge into their word; single-note words fold into a neighbor, text
  joined '+', phones re-joined dash-wise — SoulX's own whole-word convention). Drained
  rests dropped. `noteFloorMerged`/`noteFloorLeaks` surfaced; leaks must be 0.
  Goldens 69 ×3-det incl. the EXACT stage10 fixture (RED-proven: old code keeps 0.1233).
- **`bench_consonants.py`** — the owner's "check for that kind of thing": per commanded
  sibilant-class phone (S Z SH ZH CH JH headline; F TH reported), band-energy ratio
  (S/Z 4-10 kHz, SH/CH/JH 2-8 kHz) in a window leaning 0.12 s before the note start
  (V4a), graded TAKE-REFERENCED: a finding needs the take to demonstrably contain the
  sound AND the render to lack it. Goldens 14 ×3 (synthetic hiss/sine, both directions).
  **Validated retroactively**: flags "busy"(Z) on LookinBack in r3/r9b/r11a — take ratio
  0.74 vs render 0.08-0.16, a stark real miss exactly in the class the owner heard.
- **`--swap-word` pineapple control**: payload-only substitution (words.json untouched,
  recorded in the run row); r11b renders stage9orsum singing `P-AY1 / N-AE2 / P-AH0-L`
  over the identical slot geometry.

## r11a numbers (seeded; means across 3 songs, vs r9b)

missing 26.4→**23.3%** · spurious 16.0→16.1% · within-1st 0.803→**0.823** · rhythm
53.2→**51.5 ms** · drop 0.254→0.266 (takes' own level 0.37). stage9orsum (the owner's
problem song): missing 28.8→22.9, drop 0.40→0.28. `noteFloorLeaks == 0` on all three
scores (the mechanical gate).

**Pre-registration miss (honest)**: the plan predicted only stage10 would change; ALL
three re-rolled — the new donor ORDER redistributes durations even where the old floor
had succeeded via its adjacent-only rule, and any score delta re-rolls the seeded
diffusion. Timelines verified sum-exact on all three.

## Served (`ear-consonants`, :8199, cache-tag r11)

Top: **the piñata microscope** (labeled, not blind) — take / r9b piñata / r11a piñata /
r11b **pineapple**, all cropped to "smashing the piñata my whole life" (3.7–6.4 s window
clock). The owner's decision tree: pineapple articulates while piñata garbles ⇒ the word
itself (rare phones) ⇒ lyric-side workarounds; both garble ⇒ duration/melisma mechanics ⇒
fire the registered r12 stress-inversion fold.
Below: full-song blind A/B round-3 vs r11a (catch = stage9orsum this time; LookinBack
was last round's), per-song take-vs-render panels. All served clips provenance-verified
sample-exact against their round sources (incl. the pineapple crop at the 3.7 s offset).
