# FMS-Bench metric-validity — registered prediction (2026-07-17)

House registered-prediction discipline: **written before the measurement.** The metric
spine (`score_vocal` + `bench_metrics.ranks`) only earns the right to gate real pipeline
changes if it demonstrably ranks a known-GOOD render above a known-BAD one. This records the
prediction; the **Verdict** section below is appended after the smoke runs, unchanged above.

## Setup (synthetic sanity triple — NOT in git)

Under `~/mosh-fms-ksb/bench/sanity/` (built by `scripts/fms-killshot/bench_sanity_make.py`):
- `reference.wav` — a clean 3-note sung-ish tone (A3 220 / B3 247 / C4 262 Hz), soft
  attack/decay, with rests between notes. This is the ground-truth "human vocal".
- `good.wav` — `reference` + low-level (−40 dB) white noise. Same pitch, same timing.
- `bad.wav` — `reference` transposed **+3 semitones** and shifted **+150 ms**. Wrong
  register, wrong placement.

## Prediction (registered)

Running `bench_validity.py --reference reference.wav --good good.wav --bad bad.wav`:

1. **`pass: true`.** `good` beats `bad` on a strict majority of the *correctness* keys that
   are comparable — specifically lower `f0.abs_median_st` (≈0 vs ≈3 st), smaller
   `|global_lag_ms|`, and lower `energy.render_in_take_silence_pct`.
2. **Naturalness is NOT evaluated** here (no `judges`/`singmos` venvs locally) — the verdict
   flags `naturalness_evaluated: false`, and the gate stands on correctness alone. It does
   **not** fail for the missing naturalness venvs.
3. **Determinism:** the verdict JSON (`pass` + `ranks.detail`) is identical across 3 runs
   (pyin F0 is deterministic given the same audio).

## Falsifier

If `pass` is `false`, or `good` does **not** beat `bad` on `f0.abs_median_st`, the ruler is
not trustworthy — **stop and fix `score_vocal` before any dataset work.**

## Owner-gated remainder

Axis (b) of the full metric-validity gate — agreement with the owner's ear on the real
self-recorded (mumble→finished) pairs — is deferred until those pairs exist. The harness
accepts them later through the same `ranks()`.

---

## Verdict (2026-07-17)

**Correctness ruler: VALIDATED. Naturalness plumbing: validated after a fixture fix. Gate PASS.**

The smoke ran the full arc — the registered prediction was *partly falsified on first run*,
which caught a real confound, and the fix confirmed the ruler.

### Run 1 (fixture as registered) — `pass: false`, prediction falsified on naturalness
- **Correctness held exactly as predicted.** `good` beat `bad` on every non-tie correctness
  key — `abs_median_st` (good), `global_lag_ms` (good), `median_dsemitones` (good),
  `render_in_take_silence_pct` / `take_in_render_silence_pct` (good), `spread_st` (good);
  onset f1/precision/recall + `octave_error_rate` tied. `correctness_ok: true`. The
  registered falsifier (`f0.abs_median_st`) held — the ruler is not the problem.
- **Naturalness inverted.** `pq(good)=5.52 < pq(bad)`. Diagnosis: the *registered fixture*
  added −44 dB noise to the GOOD sample, and `pq` (Audiobox **Production Quality**) correctly
  penalized that noise, while the clean-but-+3-st BAD tone scored higher. `pq` was doing its
  job; the fixture conflated "close to reference" (correctness) with "high production
  quality" (naturalness). This is precisely the confound the two-axis separation exists to
  expose — and it exposed it in our own test. (Also confirmed: the judges venv is live here,
  so `pq` is real; `singmos` was `null` — no singmos venv yet.)

### Fix — a proper known-bad must be worse on EVERY axis
`bench_sanity_make.py` updated: GOOD is now a faithful clean render (−60 dB dither,
pq-neutral); BAD is transposed **+3 st**, shifted **+150 ms**, AND carries **−22 dB noise**
so it is worse on correctness *and* production quality.

### Run 2 (corrected fixture) — `pass: true`
- `correctness_ok: true` (same 6 non-tie keys, all `good`).
- `naturalness_ok: true` — `pq(good)=6.13 > pq(bad)=4.83`.
- **Deterministic ×3** — decision hash `b17c9267bd56edc5` identical across 3 runs (pyin F0 +
  Audiobox pq both deterministic at inference).

### Conclusion
The metric spine is trustworthy on its **correctness** axis (the primary supervisor) and its
**naturalness plumbing** flows a real pq signal and orders a clean-vs-degraded pair
correctly. Two honest limits carried forward:
1. `pq`/naturalness on **synthetic tones** is a plumbing check, not a human-likeness check —
   real human-likeness validation needs real vocals.
2. Axis (b) of the full gate — **agreement with the owner's ear on real (mumble→finished)
   pairs** — remains owner-gated and deferred. The harness accepts them through the same
   `ranks()`.

The ruler has earned the right to proceed to increment 2 (mumble synthesizer + one dataset).
