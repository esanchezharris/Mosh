# FMS-Bench — human-baseline calibration: REGISTERED PREDICTION (2026-07-18)

Written **before** any Stage-2 number is measured. The verdict section is appended after.

## Why this measurement exists

Every FMS score so far has been relative — better/worse than another render. Nobody has ever
measured what a **human** scores, so "good" had no absolute scale. The oracle (a clean vocal
against itself) is a trivial 1.0 and teaches nothing. The owner's 3 real (mumble → finished)
pairs finally allow the absolute question: *what do the metrics read when both sides are a
real human singing the same song?*

Corpus: `own-pairs`, 3 songs, in-voice, both takes on the same session clock.

## Predictions

**P1 — direction sanity.** The mumble scores worse than the finished take on every
correctness axis. A necessary wiring check; a failure means the harness is mis-plumbed, not
that the finding is interesting.

**P2 — the forced-align ruler holds in-voice.** Scoring both takes against the finished
take's own ground-truth words, `bench_align.word_align_score` reads **finished ≥ 0.35**,
**mumble ≤ 0.25**, gap **≥ 0.10**. The ruler was only ever validated cross-voice on NUS
(JLEE clean 0.377 vs mumbled 0.163); this is its first in-voice test, on the owner's actual
mumble rather than a synthetic one.

**P3 — the naturalness axis is valid (THE ONE WITH TEETH).**
`pq(real human finished vocal) > 6.83` — the pq the SoulX pipeline render scored in the
third-curve run.

- **TRUE** ⇒ pq has some claim to tracking human-ness; keep it as the naturalness axis.
- **FALSE** ⇒ pq is Audiobox *Production Quality*: it rewards mixing polish, and a raw naked
  vocal has none. It would then be measuring the wrong thing entirely — unable to detect the
  exact complaint driving this project ("doesn't sound human") — and must be replaced by
  SingMOS-Pro (singing-MOS specific, CC-BY, already scoped in `bench_naturalness`).

I genuinely do not know which way this falls. The metric-validity smoke already caught pq
ranking a clean-but-wrong-pitch sample above a correct-but-noised one, so the failure mode is
live. **This prediction is the reason to run Stage 2 at all.**

**P4 — the human band is a stable constant, not a per-song accident.** Across the 3 songs the
mumble→finished envelope correlation spread is **< 0.20**. If TRUE the band is usable as one
calibration constant; if FALSE, calibration must be per-song and no single "human number"
exists.

## What the numbers will mean

The mumble→finished score is simultaneously two things, and conflating them would be an error:

1. **The floor** — what you get with no pipeline at all (hand the draft back unchanged).
   The pipeline's entire claim is that it beats this.
2. **The human-to-human distance** — how far apart two genuine performances of the same song
   sit. This is what a *correct* system's residual disagreement should look like.

A pipeline is only interesting if it scores **above the floor**. But a pipeline scoring near
1.0 while also correlating >0.9 with its own *input* is echoing, not performing — the trap
that killed the ACE cover lane (cns 0.7 read 0.78 correlated to the raw take and looked like
a breakthrough). So Stage 4 must report **generated-vs-reference AND generated-vs-input**
together; either alone is fakeable.

## Method

`bench_human_baseline.py` over `own_pairs_items()`, reusing `bench_score.score_vocal`
(correctness + naturalness apart), `bench_align.word_align_score` (the singing-capable ruler
— Whisper cannot read sung content), and `bench_naturalness.pq_score`. Arms per song:
`mumble` (the floor) and `finished` (identity/ceiling reference). Deterministic; artifacts
outside git.

---

## VERDICT (measured 2026-07-18)

`bench_human_baseline.py` over all 3 pairs. Each arm scored against the **finished** take.

| song | arm | energyCorr | onsetF1 | wordAlign | hit | pq | f0 Δ (st) |
|---|---|---|---|---|---|---|---|
| LookinBack | mumble | 0.518 | 0.557 | 0.261 | 0.42 | 7.09 | 0.1 |
| LookinBack | finished | 1.000 | 1.000 | 0.407 | 0.68 | 7.25 | 0.0 |
| stage10 | mumble | 0.476 | 0.345 | 0.140 | 0.09 | 6.88 | 0.0 |
| stage10 | finished | 1.000 | 1.000 | 0.312 | 0.46 | 6.89 | 0.0 |
| stage9orsum | mumble | 0.347 | 0.286 | 0.071 | 0.03 | 6.72 | 0.0 |
| stage9orsum | finished | 1.000 | 1.000 | 0.356 | 0.63 | 7.04 | 0.0 |

**The human band (mumble → finished):** energyCorr 0.347–0.518 · onsetF1 0.286–0.557 ·
wordAlign 0.071–0.261 · pq 6.72–7.09.

### Prediction results

**P1 — direction sanity: TRUE.** The mumble is worse on every axis in all 3 songs. The
identity arm reads exactly 1.000 for energyCorr and onsetF1, so the harness is wired right.

**P2 — the ruler holds in-voice: PARTIAL (load-bearing claim TRUE, thresholds wrong).**
The separation holds in all 3 songs, gap **0.146 / 0.172 / 0.285**, comfortably over the
predicted ≥0.10. But my exact bounds were miscalibrated: finished ≥0.35 misses on stage10
(0.312) and mumble ≤0.25 misses on LookinBack (0.261). `hit_frac` turns out to be the far
sharper discriminator than `mean_score` — finished 0.46–0.68 vs mumble 0.03–0.42.

**P3 — the naturalness axis is valid: TRUE, but weakly, and the comparison is not clean.**
pq(finished) = 6.89 / 7.04 / 7.25, all above 6.83. However: the *mumble* also averages 6.90,
i.e. **the SoulX render scores below even a degraded human draft**; the human-vs-machine gap
(0.23) is barely wider than the polished-vs-mumbled-human gap (0.16); the total dynamic range
across everything measured is 0.53; and 6.83 came from NUS content (different singers, songs)
so that leg is cross-corpus, not apples-to-apples. **Read: pq orders correctly but has almost
no discriminative power for this task. Do not lean on it alone — bring SingMOS-Pro online.**

**P4 — the human band is one stable constant: MOSTLY FALSE.** Spreads: energyCorr 0.171 ✓,
wordAlign 0.190 ✓, onsetF1 **0.271** ✗, pq **0.370** ✗. There is no single universal "human
number": timing agreement between two takes is strongly song-dependent (LookinBack 0.557 vs
stage9orsum 0.286). Calibration must be reported **per song, or as a range** — never as one
scalar.

### The two findings that outrank the predictions

**1. The word-align ruler saturates near 0.36 on real human singing — not 1.0.** A finished,
fully intelligible human vocal scores only **0.312–0.407** against its own ground-truth words,
because the metric is MMS forced-alignment acoustic confidence, not similarity to a reference.
This retroactively reinterprets the third-curve run: its "oracle 0.348" was not a weak ceiling,
it *was* the human ceiling, so the pipeline's **0.238 is ~66% of achievable**, not 24% of 1.0.
Every future word-recovery number must be read against ≈0.36.

**2. Pitch is already solved by the input.** The mumble and finished takes differ by
**0.0–0.1 semitones** of median F0 on all three songs. The draft already carries the melody in
the correct register; what it lacks is words (bag coverage 0.28–0.44, seq ratio 0.15–0.31) and
some timing. The pipeline's job is **articulation and intelligibility, not pitch** — which
supports the existing "perform at the take's own F0" design and argues against spending
further effort on pitch correction.

### Process note (a bug this found in the harness, not the pipeline)

The first run reported `energy_corr` as null: `overlap.analyze`'s `energy` block is silence
**leakage** (percentages), and has no envelope-correlation key to read. Fixed by computing it
through the canonical `soulx.perform.env_corr` (Pearson over reference-active frames) — the
same convention every prior FMS audit used. Recorded because a metric silently reading `None`
is exactly how an unanchored loop stays unanchored.
