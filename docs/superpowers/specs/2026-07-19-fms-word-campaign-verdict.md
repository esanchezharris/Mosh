# FMS Word Campaign — round ledger + milestone (2026-07-19)

*Companion to the registered spec `2026-07-18-fms-word-campaign-design.md`. All rounds
seeded (SOULX_SEED=4242, CFG=5.0, 32 steps), full VERIFIED spans (15.6/15.3/13.3 s),
oracle melody, product arm (pipeline+snap) judged by the take-calibrated ASR word gate.*

## Round ledger (word defects under the refined gate; guards = within-1st / rhythm ms)

| Round | Lever | Defects | Guards | Verdict |
|---|---|---|---|---|
| 0 | baseline (r3 words + floor invariant + sylBudget 0.22) | **9** | 0.787 / 87.9 | baseline |
| 1 | L1 stress re-deal (0.12) | 11* | 0.823 / 74.3 | **REVERT** — piñata got perfect geometry (0.214/0.255/0.214, stressed longest) and still collapsed: duration geometry FALSIFIED as sufficient |
| 2 | L2 whole-word notes (melismaStepSt 4.0) | **7** | 0.866 / 54.7 | **KEEP** — piñata articulates as one whole-word note; fumbling×2 fixed; guards improved |
| 3 | +L4 chains (0.6 s, gate .90) | 12* | 0.815 / 57.5 | **REVERT** — never fired on targets (voiced gate); wrecked stage10 where it fired; agrees with the old r8 ear loss |
| 4 | +L5 cluster floors (consonant_ms 47.4) | **5** | 0.829 / 51.7 | **KEEP** — bipolar + "and" articulate; LookinBack 20/20, stage10 19/19 demanded words |
| 5 | +L4b retuned chains (0.9 s, gate .75) | 5 | 0.803 / 52.4 | **REVERT** (not strictly down) — chains STILL never fired on helena/lacoste: the take's own voicing decays below 0.75 there |

*\*rounds 1/3 recorded under the original gate; the ledger above re-scored r0/r2/r4
under the registered gate refinement (demand = min(takeSyl, lyricSyl) — the word's
syllables, never the take's ornament count).*

**Stop: round 5, by residual exhaustion** (spec amendment, recorded before any round
6 — a byte-identical re-render to fire the 2-dry-rounds clause mechanically would
have added no information).

## What the campaign established

1. **The garble mechanism was note STRUCTURE, not duration.** Round 1 falsified the
   duration/stress-geometry theory on its own registered target; round 2's whole-word
   notes (SoulX's native convention) fixed piñata immediately. The two kept levers
   are both in-distribution moves: whole-word notes + articulation-budgeted floors.
2. **The gate earned trust**: it flagged exactly what the owner's ear had flagged
   (piñata, busy, lit/rarely), and its two false-positive classes found during the
   loop (take-ornament demand; anchor-word gap leakage) were fixed with registered
   amendments, ledger re-scored.
3. **Word defects 9 → 5 (44%) with BOTH guards better than baseline** (within-1st
   0.787→0.829, rhythm 87.9→51.7 ms, zero floor leaks every round).

## The named residual (what the milestone listen adjudicates)

- **Held-melisma words over decaying takes**: Helena/Bonham, lacoste — every
  commanded-structure lever tried (syllable split, whole-word, stress re-deal,
  cluster floor, chains-where-take-supports); the take's own voicing decays below
  0.75 through these words, so "command more voicing" contradicts the validated r6
  lesson. This is model articulation character on long held words.
- **Dense function words**: one swallowed "I"; "that" rendered as "the" (0.26 s note,
  duration not the lever).
- **Seed-lottery flicker**: borderline words (wandering/sheee class) flip between
  re-rolls; any score change re-rolls the whole song.

## Milestone (served)

`~/mosh-fms-ksb/bench/ear-milestone` on :8199 — LABELED, absolute judgment: per song
mumble / finished take / best render (wc-r4, pipeline+snap) + the honest word-gate
readout + take-vs-render waveform panels. All 9 served clips provenance-verified
sample-exact against wc-r4. **Owner rules guide-grade yes/no per song; if no, names
the residual that breaks it.**

## OWNER VERDICT on the full-song milestone (2026-07-19) — guide-grade NO

> "these sound kinda the same - ok not very good"

**The campaign's thesis is refuted by the ear.** Word recovery reached 89.0% with both
guards at their best of any round, and it did not buy guide-grade. Two readings of
"sound kinda the same", both damning in the same direction:

- *same as previous rounds* — the word fixes are inaudible against the residual;
- *the three songs sound like each other* — the render imposes one generic voice
  character over three different performances.

Either way the dominant term is **not** word placement. It is the thing the program
registered as parked: **SoulX's articulation/naturalness character**. Words-first was
run to exhaustion (every registered lever kept or refuted, two genuine data bugs found
and fixed, coverage taken from 15 s to whole songs) and the answer is that the words
were never the binding constraint.

**This is the fifth time an instrument win lost by ear** (four envelope-family metrics,
now the ASR word gate). The gate is not wrong — it measured exactly what it claimed,
and it found real bugs — it is simply not the axis that decides guide-grade. Recorded
so no future round re-litigates it.

**Implication for what comes next (owner decides; nothing started):** the queued
campaigns (mumble-melody, key-snap) are both refinements of *placement* and would
inherit the same ceiling. The honest options are (a) attack naturalness directly —
which is the NSF re-vocode lane, blocked on a licence-clean self-trained checkpoint,
or a different engine; (b) re-scope what a "guide vocal" has to be; or (c) stop here
and bank the instruments. No work is queued pending that call.

## Open items

- **Full lyrics (owner, non-blocking)**: verified lyrics cover only the first
  ~13–15 s per song; the same `--full-span` flag covers whole takes the moment full
  lyrics + realignment land.
- Next campaigns queued (in order, per the registered program): mumble-derived
  melody; key-snap/pitch round; naturalness (incl. NSF, license-gated).
- Product promotion of the two kept levers (melismaStepSt / cluster_ms defaults in
  the sing adapter) is a separate unit, gated on the milestone verdict.
