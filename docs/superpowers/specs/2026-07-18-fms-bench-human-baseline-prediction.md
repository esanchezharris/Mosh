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

## VERDICT

*(appended after measurement)*
