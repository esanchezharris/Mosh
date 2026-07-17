# FMS Mechanism Verify — verdicts (companion to the registered design)

**Design (registered before measurement):** [2026-07-16-fms-mechanism-verify-design.md](2026-07-16-fms-mechanism-verify-design.md)
**Branch:** `claude/fms-mechanism-verify` · **Artifacts:** `~/mosh-fms-ksb/used2/asserted-proof/mechanism/`

| Experiment | Status | Verdict |
|---|---|---|
| V0 vowel landmarks | RUN (2026-07-16) | **INCONCLUSIVE per registered gates** — cluster-trend prediction NOT supported; squeeze real but cluster-independent; strong secondary findings below |
| V4a shipped-example stats | RUN (2026-07-16) | Directional support for H (voicing at/before the note boundary) |
| V4b melisma probe | RUN (2026-07-16) | **PASS 6/6** (owner ear-confirm pending) — melisma available to B2 |
| V1 gold sing | RUN (2026-07-16, line 2) | words natural in the mouth (owner sang both nominated lines without complaint); line-1 export was digitally silent — re-record pending |
| V2 oracle durations | RUN (2026-07-17, line 2) | **gold > oracle > baseline blind; "better, still synthetic"** — durations confirmed as a contributor, NOT sufficient. B1 not built |
| V3 assembly ablation | RUN (2026-07-17) | **per-word snap ranked WORST in both blind passages; no-snap best/tied-best** — the snap machinery is a confirmed naturalness cost |

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

## V1 + V2 — gold sing and the oracle listen (line 2)

**V1.** The owner recorded both nominated lines in one sitting with no singability
complaint (registered prediction P-V1 held: words are an amplifier, not the root — the
formal read stands on line 2; line 1's export bounced silent on both channels and awaits a
re-record for corroboration). Line-2 gold: clean vocal, no beat bleed, all six words
forced-aligned monotonically ("time" 1.42–1.85s … held "close" 3.61–4.55s). One word sat
under the registered CTC 0.2 gate ("time" 0.169) — span + voicing + Whisper all confirmed
the word, so the run used an EXPLICIT `--min-ctc 0.15` override (flag added; never silent).

**V2 (the decisive listen).** Same lyric, same `note_pitch`, same SoulX-MLX → NSF-perform
arm; ONLY durations swapped mumble-slot → gold (2 surplus "so" continuations dropped per
the k>m rule; 5 gap rests from gold; gold line 3.13s vs baseline 2.88s). Blind 3-way,
level-matched (RMS 0.08 peak-safe):

- **Owner ranking: gold > oracle > baseline** — and the owner identified their own take
  (calibration holds).
- **Gap read (owner, post-vote): oracle "better, still synthetic."**
- Instrument corroboration (`mechanism/v2-line2/oracle-metrics.json`): median vowel-onset
  delta vs the human reference collapsed **40ms → 10ms** (vs own spec 45 → 22.6ms) — the
  registered P-V2 collapse prediction held.

**Registered-gate application:** the oracle beat the baseline with the whole stack held
constant → the verbatim duration transfer is CONFIRMED as a real naturalness cost. But the
oracle did not reach the gold's tier → the stage-2/3 lyrics-and-timing thesis is
**insufficient on its own**; per the registered rule **B1 is NOT built** on this evidence,
and V3 (assembly ablation) — already motivated independently by V0-S3's snapped-worse-
than-raw numbers — is the next probe. The strict park-signal clause was written for an
oracle that showed NO improvement; the measured outcome (clear blind win + metric collapse,
residual gap) reads as "duration fix necessary, not sufficient" — the park decision is
deferred until V3 localizes the residual.

## V3 — assembly ablation (2026-07-17)

One plain sum of the u2 chunk renders through stage 5 three ways via the PRODUCT
`perform.py` (only variable = the snap stage; provenance corr 0.974 vs the lab assembly);
two judge passages, independently blind-shuffled, level-matched, no NSF.

**Owner rankings: line2 nosnap = phrase > word · line1 nosnap > phrase > word.**
The full per-word snap (±120ms, 10ms crossfades at every word event) ranked WORST in both
passages, while it RAISES take-envelope correlation (0.438 → 0.523 → 0.562 across
nosnap/phrase/word) — the snap optimizes the metric by damaging the sound, corroborating
V0-S3's instrument numbers (snapped output +30…50ms later vowels, dur_ratio 0.73–0.80).
Phrase-level alignment is at worst neutral (tied-best once, middle once).

**Consequence:** the per-word `snap_to_events` stage should be REMOVED from the product
chain (phrase-level alignment stays); the ~9ms word-snap gate it served is already
condemned by B3. Note V2's residual gap is INDEPENDENT of this finding — neither V2 arm
went through the per-word snap — so the remaining synthetic-ness after duration+snap fixes
sits in the render engine's articulation realism (SoulX phoneme-transition character),
which is the registered park territory.

## Phase V — closing synthesis

Two confirmed, independent naturalness costs, both ear-verified blind and both
instrument-corroborated:
1. **Stage 3's verbatim mumble-slot durations** (V2: oracle durations beat baseline blind;
   vowel-onset error vs human reference collapsed 40 → 10ms). Fix = derive durations from
   phrase-level anchors + a phrasing rule layer (B1-lite), knowing it improves but does not
   close the gap alone.
2. **Stage 5's per-word snap** (V3: worst in both blind passages). Fix = delete
   `snap_to_events` from the chain, keep phrase alignment — a subtraction.

Supporting: B2 capped at cram-kill + soft singability terms (V1: words sang fine), melisma
available for tol-±1 (V4b PASS), B3 metric fix (vowel-onset alignment; V0 proved the
word-start metric measures the wrong landmark and V3 proved optimizing it hurts).
**Residual (parked):** after both fixes the gap to a human take is expected to narrow but
not close — the remainder is SoulX articulation character, a render-engine question, parked
until after first-stranger per the runway rule.

## Decision-rule state after V0/V4

| Registered rule | State |
|---|---|
| V0 median <20ms AND no squeeze → demote P-center | did not fire (squeeze present); cluster-trend form of P-center unsupported anyway |
| V4b slurs broken → no melisma in Phase B | **inverted: melisma AVAILABLE** |
| V1 natural → cap B2 at cram-kill + soft terms | **fired: B2 capped** (owner sang both lines without complaint) |
| V2 oracle ≈ human → build B1 / fails → V3 + park | **middle outcome: "better, still synthetic"** — duration transfer confirmed as a cost, B1 deferred, V3 next, park deferred to post-V3 |
| (amendment, from S3) | run V3 regardless of V2's outcome — **now live** |

## Owner checkpoints (remaining)

1. **V3 blind listen** (page emitted by `v3_assembly.py` when run): same assembled section,
   three stage-5 variants — no-snap / phrase-snap-only / full per-word snap — which reads
   most natural?
2. **V4b ear check (~1 min):** `mechanism/v4/melisma/melisma.html` — do M1/M2 glide with no
   re-attack (vs M0)?
3. **Line-1 re-record** (the export was silent) → a corroborating V2 round on the
   heavy-cluster line.

## B1-lite BUILD record (2026-07-17 — post-Phase-V; ear round pending)

All three green-lit lanes are now landed on this branch; lane (b) B1-lite completed the set.
Build per `../plans/2026-07-17-fms-phase-b-build-plan.md` §Lane (b):

- **Core:** `service/soulx/duration.py` — anchored piecewise zero-sum derivation
  (stressed-content vowel onsets pinned to their take nuclei, onset consonants budgeted
  BEFORE the anchor, function-word compression / stressed-rime + phrase-final lengthening
  between anchors, articulability floors × cluster, phrase-initial rest-steal ≤120ms).
  62-check golden ×3-det; `strength=0` is an exact identity.
- **Params** (`service/soulx/duration_params.json`, fitted by `fit_duration_params.py`):
  consonant_ms 47.4 (n=71 V0 raw-chunk clean rows; snapped lanes excluded — that stage is
  deleted), floor 80.2ms (the owner's shortest gold word), stress 1.8 / function-compress
  0.5 / final-lengthen 1.6 — all three gold ratios CLAMPED at their registered bounds
  (n=6 monosyllabic gold words; the clamps are the honesty mechanism, provenance in the
  JSON).
- **Mode:** `author_score(durations="verbatim"|"derived")`, default byte-identical
  (RED-proven pin); adapter passes `params["durations"]` through and reports it in the
  manifest. Lab arms share the same `derive_clip` code path.
- **Arms:** both re-rendered LOCALLY (V2 backend-parity lesson), 5 chunks each,
  self-placement verified; plain-sum assembly; phrase-only snap with VERBATIM-clip
  windows for BOTH arms; NSF `perform` at the take's F0.

**Instrument readout (registered as informative, ear is the gate):** on the identical
pre-NSF snapped arms, the vowelGate clean subset (n=30 measured of 34 clean / 101 words)
reads **verbatim +45.0ms median vowel-onset delta → derived 0.0ms** — the V0/V2 lateness
figure reproduced on the verbatim arm and eliminated on the derived arm (the V2 oracle
had reached ~10ms). squeeze_frac 0.467 → 0.40; median vowel dur_ratio 0.833 → **0.905**
(the derived arm holds vowels closer to full length — the anti-squeeze direction).
Counterweight recorded: raw env_corr vs the take drops 0.425 → 0.332 (derivation
deliberately re-times inside phrases; V3 proved env_corr and ear can move oppositely —
neither direction is a verdict). Numbers are post-review-fix (the infeasible-revert,
strength=0, and rest-steal fixes; derived arm re-rendered).

**Owner checkpoint (the lane's exit gate):** blind A/B at
`mechanism/b1/b1-listen.html` (:8199) — the u2 back half two ways (full passage + the two
proven line windows, independently shuffled, level-matched). Unblinding in
`b1-labels.json` (not linked). Verdict decides whether `durations:"derived"` becomes the
sing default.
