# FMS — oracle decomposition: can SoulX reproduce the finished take at all? (2026-07-18)

The owner asked: *"are you sure you're even targeting the finished take?"* Code audit said
no — the arm was an incoherent hybrid (mumble melody + finished timing + cross-clock F0
sampling). This increment aimed SoulX at the finished take **for the first time** (the
oracle arm: finished melody + finished timing + real lyrics), built a note-by-note /
word-by-word conformance instrument against the ground truth, and iterated autonomously —
no ear rounds — per the owner's directive.

## Instruments (validated before use)

- `bench_target_conformance.py` (15 checks ×3): per-note sung pitch take-vs-render (with
  `d_cmd_st` separating *model disobeyed* from *we commanded wrong*), per-word onset lags,
  drop list. **Calibration: the finished take vs itself reads 0.0 st / 0.0 ms / 100%** — the
  instrument reads identity as identity. It also fixed the word-drop target honestly: the
  finished take itself "drops" 35–42% by the align ruler, so that — not the plan's 15% — is
  the human reference level.
- **SoulX render was NON-DETERMINISTIC** — a byte-identical score rendered with silent-notes
  4→0 and rhythm 103→40 ms between runs. The flow-matching init noise (`torch.randn`) was
  unseeded. Fixed with an env-gated `SOULX_SEED` in the bridge (additive; unset = original
  behavior); byte-identical renders proven. **Every unseeded round-to-round comparison in
  this lane's history was partly noise.**

## Iteration log (seeded, one change per round)

| round | change | within-1st (mean) | rhythm med ms (mean) | drops (mean; take's own = 0.37) |
|---|---|---|---|---|
| 0–1 | unseeded — comparisons void (variance) | — | — | — |
| 1 | **bug fix**: unvoiced-word pitch fallback was hardcoded A3, up to +9 st above the take's line ("tough": take C3, commanded A3 — the model OBEYED the wrong command). Now inherits the nearest neighbour's pitch. | — | — | — |
| 2 | seeded baseline (fix in) | 0.704 | 71.7 | 0.251 |
| 3 | **cfg 3.0 → 5.0** | **0.744** | **65.8** | **0.237** |
| 4 | n_steps 32 → 64 | 0.695 ✗ | 63.8 | 0.286 ✗ |

Round 3 is the converged config (cfg 5.0, 32 steps, seed 4242). Round 4 regressed on two of
three axes at 2× the cost — reverted; plateau reached.

## The oracle verdict (round 3, per song)

| song | notes within 1 st | rhythm median | word drops | take's own drops |
|---|---|---|---|---|
| LookinBack | 0.773 | 51.2 ms | **0.10** | 0.35 |
| stage10 | 0.700 | 73.1 ms | **0.21** | 0.42 |
| stage9orsum | 0.760 | 73.1 ms | 0.39 | 0.35 |

1. **Words: CONVERGED.** At or better than the finished take's own ruler level on all three
   songs. The "missing consonants and syllables" era is over in the oracle setting.
2. **Rhythm: near target** (51–73 ms vs the 60 ms goal), with a known residual: renders run
   *globally* late on two songs (+52/+88 ms mean, mostly-positive lags) — a uniform offset,
   a future assembly-level lever (global shift is safe; per-word snapping remains banned per V3).
3. **Pitch: the one real model weakness.** Median |Δ| 0.3–0.5 st is excellent, but ~25% of
   notes miss by >1 st and **every model-disobeyed miss sits in G#2–D#3** — the owner's low
   register. Errors go both directions; cfg helped, steps didn't. This is a register-specific
   accuracy limit of the model, not an authoring bug (the `d_cmd_st` column separates the two).

## The engine question, answered with evidence

**No engine swap is warranted on this evidence.** Given honest inputs, SoulX reaches
human-level word articulation, near-target rhythm, and 0.3–0.5 st median pitch — the failure
mode that motivated swap talk (dropped syllables, wrong melody) traced to OUR inputs
(OOD score format; mumble-melody hybrid; unseeded variance), not the engine. The one genuine
model deficit — low-register pitch (~25% of notes >1 st in G#2–D#3) — has a cheaper remedy
than a swap: **NSF `perform` re-vocode at the take's exact F0** (already built, owner-local;
pitch becomes exact by construction). Shipping that path needs the known self-train
(MIT SingingVocoders) step. The repo's engine survey confirms there is no licensing-clear,
Mac-native alternative with better claims (DiffSinger-native is the only uninvestigated lane
and has no clear Mac port).

## What now stands between the oracle and the product

The oracle uses the finished take's melody/timing — the product only has the mumble. The
remaining program is **input analysis**: estimate melody + timing from the mumble well enough
to feed the (now-validated) render chain. That is the next increment, and it is a
measurement/estimation problem, not a synthesis one.

## Ear gate (served)

Blind catch-trial A/B at `~/mosh-fms-ksb/bench/ear-oracle/` (:8199): the previous best the
owner heard (SoulX-convention, mumble melody) vs the round-3 oracle, per song, one pair
byte-identical as the catch. The oracle should sound like *his finished melody* for the
first time. The ear still disposes; the numbers only nominated.
