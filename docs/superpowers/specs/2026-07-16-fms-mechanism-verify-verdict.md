# FMS Mechanism Verify — verdicts (companion to the registered design)

**Design (registered before measurement):** [2026-07-16-fms-mechanism-verify-design.md](2026-07-16-fms-mechanism-verify-design.md)
**Branch:** `claude/fms-mechanism-verify` · **Artifacts:** `~/mosh-fms-ksb/used2/asserted-proof/mechanism/`

| Experiment | Status | Verdict |
|---|---|---|
| V0 vowel landmarks | RUN (2026-07-16) | **INCONCLUSIVE per registered gates** — cluster-trend prediction NOT supported; squeeze real but cluster-independent; strong secondary findings below |
| V4a shipped-example stats | RUN (2026-07-16) | Directional support for H (voicing at/before the note boundary) |
| V4b melisma probe | RUN (2026-07-16) | **PASS 6/6** (owner ear-confirm pending) — melisma available to B2 |
| V1 gold sing | **OWNER CHECKPOINT** | kit ready: `mechanism/v1/record.html` |
| V2 oracle durations | harness built + golden-tested | **gated on V1's gold.wav** |
| V3 assembly ablation | conditional (V2-fail branch) | not run — but see V0 finding S3 |

---

## V0 — vowel landmarks (278 word instances × 4 lanes)

**Registered gates:** SUPPORTED needed clean-median onset Δ ≥ +20ms WITH a cluster trend
(ρ ≥ 0.3, slope ≥ +15ms/consonant) OR 2+-bucket dur_ratio ≤ 0.85. DEMOTED needed
median < 20ms AND dur_ratio ≥ 0.9 everywhere. **Neither fired → INCONCLUSIVE.**

Raw chunk lanes (primary): clean-subset median onset Δ **+20.0ms** (IQR 120), trend
**absent** (ρ −0.017, slope −3.5ms/consonant; buckets 0/1/2+ = +60/+10/+10ms — the
vowel-initial CONTROL bucket is the latest, the opposite of the P-center prediction).
Squeeze: clean median dur_ratio **0.815**, squeeze_frac **0.47** — but 2+ bucket 0.919, so
the cluster-scaled squeeze gate missed too. Instruments: FCPE sweep stable (50/40/40ms at
t=0.006/0.02/0.05, range ≤ 10ms) but pyin (primary) sits 20–30ms below FCPE — direction
agrees (late), magnitude is instrument-dependent. Section provenance passed (take voiced
frac 0.79/0.72 > 0.6). Exclusions: u2 24%, **t1 35% (above the 25% reliability line —
treat t1 as weaker)**.

**The registered prediction (lateness/squeeze ∝ onset-cluster length) is NOT supported.**
The cluster-specific P-center mechanism should carry less weight going forward. P-center is
NOT formally demoted either (the demotion rule required *no* squeeze, and squeeze is real).

### Secondary findings (exploratory — not registered gates, but measured)

- **S1 — SoulX re-times word boundaries freely.** Signed word-start delta vs the commanded
  slot start: median **+4…+7ms** (grid-centred — this REPRODUCES the shipped ~9ms claim)
  but per-word spread **±45ms** (median |Δ|). Verbatim slot boundaries are not faithfully
  realized per word even by the raw model; they're realized *on average*. The positive
  control as registered used |Δ| and initially read as failed — the signed statistic is the
  correct analogue of the shipped metric. Recorded as a spec correction, not a gate change.
- **S2 — commanded-vs-realized vowel onset: +28…30ms** (raw lanes). The model starts the
  word on the boundary and the vowel lands ~30ms inside, while the take's own vowel sits
  ~10–20ms in — net +10ms vs take. Small.
- **S3 — the stage-5 snap/assembly makes vowel timing WORSE, a lot.** Snapped lanes vs raw:
  onset Δ vs take **+40…+60ms** (vs +10 raw), dur_ratio **0.73–0.80** (vs 0.82–0.92 raw),
  squeeze_frac 0.5–0.6, signed word-start +11…+32ms. The final product output is
  systematically late-and-squeezed relative to BOTH the take and the raw renders. This is
  the strongest single number of the run and it points at the per-word snap/crossfade
  machinery — the V3 territory. **Recommendation: run V3 regardless of V2's outcome** (a
  registered-plan amendment, recorded here rather than silently applied).
- **S4 — Whisper barely recognizes the renders** (bag coverage median 0.39–0.5, min 0.0 per
  chunk). Weak evidence (whisper-base on singing is poor), but consistent with residual
  intelligibility issues; MMS_FA alignment scores were acceptable where used.

**Where this leaves H:** the *joint-distribution* form (mumble-slot durations are
out-of-distribution for the model, which re-times and compresses vowels globally) fits the
data better than the *boundary-P-center* form (consonant-cluster-proportional lateness).
V2 tests the whole duration vector at once and remains decisive and unchanged.

Outputs: `mechanism/v0/{u2,t1}-{chunks,snapped}-words.{csv,json}`, `summary.json`,
`vowel-landmark.html`.

## V4a — shipped-example statistics

On SoulX's own shipped English examples (50fps embedded f0): voiceless-onset notes show the
unvoiced→voiced transition **at or BEFORE the note boundary** — lags −120/−80/−60/−40/+20/
+40ms, median **−50ms**, no-gap fraction 0. Direction: the annotation convention budgets
onset consonants into the PRIOR tail (vowel on the boundary) — supporting H at the model
level. **n = 6 (Who/says ×3) — directional only, as registered; never gates alone.**

Joint coverage: shipped-EN median type-2 note duration 0.25s vs ours 0.31s (similar
centre), but **15.8% of our sung notes sit below the shipped 5th percentile (0.15s)** — a
3× excess of super-short notes. Format observations: shipped examples put whole
multi-syllable words on ONE note ("beautiful" = 8 phonemes/note; ours: syllable-per-note,
36% of notes ≥4 phonemes at the word level vs their 29% — but theirs via whole words),
2-decimal durations with up to 40ms uncorrected drift over 51s (the format's native
precision is coarse; our 4dp error-diffusion is *finer than the training data's own
annotations*).

Outputs: `mechanism/v4/example-stats.{json,html}`.

## V4b — melisma probe

**PASS 6/6 registered checks** (`mechanism/v4/melisma/`): M1 (+3st slur) and M2 (−4st slur)
render with continuous voicing across the note boundary (gap ≤ 30ms) and pitch steps within
±1st of commanded; the M0 re-attack control shows its boundary gap (≥30ms); all lengths
within 10%. **Melisma (note_type=3) is usable** → B2 may flex tol-±1 via melisma; V2's k>m
drop-branch is a fallback, not a necessity. Owner ear-confirmation on `melisma.html`
still wanted (registered: never ear alone — and never measurement alone either).

## Decision-rule state after V0/V4

| Registered rule | State |
|---|---|
| V0 median <20ms AND no squeeze → demote P-center | did not fire (squeeze present); cluster-trend form of P-center unsupported anyway |
| V4b slurs broken → no melisma in Phase B | **inverted: melisma AVAILABLE** |
| V1 natural → cap B2 at cram-kill + soft terms | pending owner |
| V2 oracle ≈ human → build B1 / fails → V3 + park | pending gold.wav |
| (amendment, from S3) | run V3 regardless of V2's outcome |

## Owner checkpoints (in order)

1. **V1 (~10 min):** open `mechanism/v1/record.html`, sing ONE nominated line naturally
   over the beat slice (headphones!), drop `mechanism/v1/gold.wav`. Note anything that felt
   awkward in the mouth.
2. **V4b ear check (~1 min):** `mechanism/v4/melisma/melisma.html` — do M1/M2 glide with no
   re-attack (vs M0)?
3. Then V2 runs (`oracle_duration.py --gold … --chunk … --line 37.925:41.285`), and the
   **blind 3-way listen** on `mechanism/v2/oracle-listen.html` decides the build.
