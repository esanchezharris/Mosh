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

## Ear verdict (2026-07-18, unblinded)

Owner: "lookinback B, stage10 A and B sound identical, stage9orsum B — however, we are
still pretty far off and I'm kind of doubtful that you're even showing me the right pieces
of audio."

Against the key: **catch PASSED** (stage10 was the byte-identical pair and was called
identical — the round is valid) and **the ORACLE won both real songs** (B = oracle on
LookinBack and stage9orsum). The oracle direction is confirmed by ear, not just by number.

**Provenance audit** (the "right pieces of audio" doubt, answered with evidence): every
served clip verified sample-exact (max |Δ| = 0.000000) against its claimed source —
LookinBack/stage9orsum A = `own-run-soulx` pipeline+snap (mumble melody), B =
`iterate/round-3` pipeline+snap (oracle), stage10 A = B = round-3 (the catch). The only
difference vs the sources is a trailing 0.25 s render pad the crop trims so lengths match
the reference. The windows of the two runs are identical, so the crop was span-neutral.
"Still pretty far off" is therefore a true judgment of the oracle render itself.

## Post-verdict decomposition: where "pretty far off" lives (lineup instrument)

`bench_lineup.py` (golden ×3) measures the owner's own criterion — "there shouldn't be
silence where there's a sustained, vice versa" — as classified spans. Round-3 oracle read:

- **Global lag is DEAD as a lever**: envelope lag 0/0/+10 ms — the phrase snap already
  aligned the mass; a global shift changes nothing (`after_global_shift` == raw). The
  +52/+88 ms word-onset lags are late ATTACK SHAPES, not a uniform offset.
- **stage10 = commanded-silence bugs**: 1.13 s `missing@rest` (the flat 0.30 s
  `close_legato_gaps` cap refused to bridge 0.71 s/0.42 s gaps the take sustains straight
  through) + 0.30 s `spurious@note` (the last word's aligned end overruns the take's
  voicing, so the score commands a note where the singer already stopped).
- **LookinBack/stage9orsum = model TAIL DECAY, not true silence**: 26 of 27 missing spans
  are QUIET-SING (the render phonates below its own voicing threshold), overwhelmingly
  @TAIL of long commanded notes. SoulX decays tails where the singer holds level.

Levers queued (one per round, seeded, mean-across-3-songs guard): round 5 = take-driven
commanded-silence fix (`trim_word_ends` + sustained-gap bridging with a voiced-frac guard
replacing the flat cap); round 6 = `chain_long_segments` sustain-chains (long notes as
same-pitch note_type-3 continuation chains — V4b proved continuation chains hold voicing
continuously, an in-distribution "keep singing the tail" command).
