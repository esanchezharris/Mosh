# FMS-Bench — is our SYNTHETIC mumble a fair stand-in for a REAL one? (2026-07-18)

Every scaled bench lane (NUS) manufactures its mumble by degrading a clean vocal. Nothing
had ever checked that substitution, because there was no real mumble to check against. The
owner's 3 real (mumble → finished) pairs allow it: degrade his **finished** take with
`bench_mumble` and compare the result against his **actual** mumble of the same song, using
the same probes.

## Headline: the shipped synthesizer was ~6× too aggressive

Measured on **word recovery** — the axis the benchmark actually scores, via the
forced-alignment ruler, read against the ~0.36 human ceiling established in the
human-baseline verdict:

| song | REAL mumble | shipped (phase 1.0 / lp 1750) | calibrated (phase 0.0 / lp 2500) |
|---|---|---|---|
| LookinBack | 0.261 | 0.043 | 0.247 |
| stage10 | 0.140 | 0.047 | 0.174 |
| stage9orsum | 0.071 | 0.033 | 0.227 |
| **mean** | **0.157** | **0.041** | **0.216** |
| **abs err vs real** | — | **0.116** | **0.059** |

The shipped setting destroyed words that a real mumble *keeps*. A real mumble is half-formed
speech, not noise — it retains 0.157/0.36 ≈ **43% of ceiling word recovery**; the old setting
left ~11%. Recalibration halves the error.

**Why it was wrong:** the original degradation was tuned to *maximize an ASR confidence drop*
— a proxy chosen because no real mumble existed to compare with. That is not the same goal as
*resembling a real mumble*, and optimizing it hard drove the synthesizer past reality. Only
real pairs could expose the difference.

**Sweep shape (worth keeping):** `phase_rand` is a **cliff, not a gradient** — recovery holds
at ~0.16–0.25 for 0.0–0.3 then collapses to ~0.04 by 0.6 and stays there. Full phase
randomization is an on/off switch for intelligibility, not a difficulty dial.

## Two things NO degradation strength can fix

**1. Real difficulty varies per performance; synthetic difficulty is fixed.**
Real mumbles span 0.071–0.261 (a 3.7× range — how the person happened to mumble that day).
The calibrated synthesizer returns ~0.17–0.25 for every song. A fixed transform cannot
reproduce that variance, so synthetic mumbles are a **fixed-difficulty proxy**; only the
own-pairs lane exhibits the true difficulty distribution.

**2. A synthetic mumble is the same performance; a real one is a different performance.**
Energy-envelope correlation to the reference: **synthetic 0.998, real 0.559.** The synthetic
lane hands the pipeline an input whose timing and dynamics already match the answer, so only
the words need fixing. In reality the finished take is a *re-performance* with its own
micro-timing. This is structural — no strength setting closes it.

Together these mean the NUS lane is **harder than reality on words** (now corrected) and
**easier than reality on performance** (uncorrectable). It is a useful scale lane, not a
substitute for real pairs.

## Changes landed

- `bench_mumble`: `LP_HZ` 1750 → **2500**, new `PHASE_RAND` = **0.0** (was 1.0), both named
  constants with the evidence inline. `mumble_wav`/`degrade`/CLI expose `phase_rand`/`lp_hz`
  so strength stays calibratable.
- **NUS runs before this date used the old setting and are not comparable to later ones.**
- New `bench_mumble_realism.py` (the real-vs-synthetic harness).

## Method caveat

`mumble_probe`'s ASR numbers are **not perfectly deterministic** — Whisper's decoding varies
run to run (the real arm read 0.605 then 0.540 mean `degraded_conf` across two runs with
identical inputs). Worse, `degraded_conf` scores Whisper's confidence in *whatever it heard*,
including confidently-wrong words, so it cannot distinguish "recovered the right words" from
"hallucinated fluently." Calibration therefore used the **forced-alignment word ruler**, which
is deterministic given the known words and measures the axis the benchmark scores. The ASR
signature is retained as a secondary, directional read only.
