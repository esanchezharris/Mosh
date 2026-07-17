# FMS Mechanism Verify — Phase V design (V0–V4, registered)

**Date:** 2026-07-16 · **Branch:** `claude/fms-mechanism-verify` (off spike tip `f8aa0778`) ·
**Status:** REGISTERED — predictions and exit gates below are committed BEFORE any measurement runs.

## 0. What this is

The Used2 renders still read synthetic after voice identity, word coherence, beat-grid timing,
pitch (NSF `perform`), and vocoder dynamics were each solved or exonerated
([FMS_HANDOFF_2026-07-16.md](../../FMS_HANDOFF_2026-07-16.md)). The external reassessment
(compass report) plus the owner's reframe converge on one precise mechanism, which this spec
verifies BEFORE any build:

> **The hypothesis (H).** Stage 3 transfers mumble-slot durations verbatim into the SoulX
> score. Real words re-attach consonant onsets that the mumble never had, so the model is fed
> (phoneme, duration) pairs that never co-occur in its training joint — regardless of whether
> its score input is "note-level" or not. Perceptually, the beat of a syllable is its VOWEL
> onset (the P-center), not its acoustic word start; stage 5 snaps word STARTS to the grid, so
> vowels land LATE by ~the onset-cluster duration, and/or vowel durations get SQUEEZED because
> the fixed slot is eaten by the consonants. The shipped ~9ms word-snap metric measures word
> starts — the wrong landmark — so this damage is invisible to it. Headline-ese lyrics
> (tol-0 count pressure) AMPLIFY the mismatch (more clusters crammed into vowel-shaped slots)
> but are not the root.

Phase V is ~2 days, near-zero new product code, all lab-script work under
`scripts/fms-killshot/`. Phase B (the build) is GATED on the verdicts and sketched in §8 only.

**Artifacts:** `~/mosh-fms-ksb/used2/asserted-proof/mechanism/`.
**Verdicts:** appended to the companion `2026-07-16-fms-mechanism-verify-verdict.md` as each
experiment lands (killshot convention).

---

## 1. V0 — measure the blind spot on existing renders (no new renders)

**Mechanism probed:** are rendered vowels late and/or squeezed, correlated with onset-cluster
length, in exactly the way H predicts and the word-snap metric cannot see?

**Method.**
- **Lanes** (take ↔ render ↔ score, chunk offsets from the fresh-render manifests):
  - PRIMARY `u2-chunks`: `asserted-proof/voice-soulx-u2full-c00..c04.wav` (raw model output,
    24k) vs `back-half/sing-handoff/scores/u2full-c0*.json` vs the take section
    (`fresh/u2-full-mumble.wav`), offsets from `fresh-render/u2-full-manifest.json`.
  - PRIMARY `t1-chunks`: `voice-soulx-t1full-c00..c11.wav` vs `scores_prev/t1full-c*.json` vs
    `fresh/t1-full-mumble.wav`, offsets from `t1-full-manifest.json`.
  - SECONDARY `*-snapped` (`fresh/u2-full-snapped.wav`, `fresh/t1-full-snapped.wav`): answers
    the registered sub-question "does the stage-5 envelope snap partially CORRECT vowel onsets
    (so the damage shows as squeeze instead of lateness)?"
  - NSF arms: EXPLORATORY only, never gate — `perform`'s F0 is take-shaped by construction, so
    FCPE voicing landmarks on it are not independent evidence.
  - Stereo beat-mix wavs excluded (bed contaminates FCPE).
- **Word events** from each score via `soulx.score.word_event_spans`-style chain walk
  (lab-local richer parser: word text, `en_` phoneme, pitches, n_notes per type-2 event +
  type-3 run; golden-tested for span agreement with `word_event_spans`).
- **Render word spans:** forced-align each render chunk against its score's word sequence
  (`skeleton.align.align_words`, MMS_FA, skeleton venv). CTC score < 0.3 excluded from stats
  (exclusion rate reported; lane unreliable > 25%). Whisper bag-coverage ≥ 0.8 per chunk as a
  garble check.
- **Vowel landmarks (FCPE, cached sidecars):** vowel onset = first voiced frame with 3-frame
  debounce in `[word_start − 0.03, word_end]`; vowel duration = contiguous voiced run (gap
  > 20ms ends it) capped at the next word. Take-side reference: the SAME estimators inside the
  score span on the take (valid because stage 3 transferred those spans verbatim).
- **Onset clusters** from the score's own `phoneme` field (what SoulX was actually told),
  cross-checked vs `phonology.core`. **Clean subset** = all-voiceless onsets
  {S,T,K,F,P,CH,SH,TH,HH}, cluster_len ≥ 1 — there FCPE voicing onset IS the vowel onset.
  Vowel-initial words (cluster_len 0) = control bucket.
- **Positive control:** median `word_snap_ms` (render word start − score start) on the snapped
  lanes must reproduce the known ~5–9ms figure, or the instrument itself is suspect and **no
  verdict is issued**.
- **Robustness:** FCPE confidence sweep 0.3/0.5/0.7 (verdict withheld if the clean-subset
  median moves > 10ms); per-chunk `overlap.global_lag` recorded (registered metric is
  UNcorrected — the product doesn't correct it either; a lag-corrected column reported
  alongside); section-provenance abort if take voicing fraction inside score spans < 0.6;
  n ≥ 8 per cluster bucket to interpret.

**Registered prediction (P-V0):** vowel-onset lateness and/or vowel squeeze, increasing with
onset-cluster length; the ~9ms word-snap number is measuring the wrong landmark either way.

**Exit gates.**
- **SUPPORTED** = clean-subset median `onset_delta` ≥ +20ms with a positive trend
  (Spearman ρ ≥ 0.3 AND slope ≥ +15ms/consonant), **OR** squeeze form: median
  `dur_ratio` ≤ 0.85 in the 2+ cluster bucket.
- **DEMOTED** = clean-subset median < 20ms AND median `dur_ratio` ≥ 0.9 in every bucket on the
  raw-chunk lanes → demote P-center; weight the joint-distribution and lyric fixes in Phase B.
- Raw-vs-snapped compared separately (does stage 5 shrink onset deltas?).

**Files:** `scripts/fms-killshot/vowel_landmark.py`, `vowel_landmark_test.py` (pure core,
3× deterministic), `fcpe_probe.py` (skeleton-venv CLI exposing `--conf`).
**Outputs:** `mechanism/v0/<lane>-words.{csv,json}`, `summary.json`, `vowel-landmark.html`
(house-style review page with audio players and bucket tables).

---

## 2. V1 — gold sing (owner, ~10 min)

**Mechanism probed:** are the Grok-written words themselves the root (awkward in a human
mouth), or an amplifier?

**Method.** 1–2 nominated lines from the Used2 back half with heavy voiceless onset clusters,
beat slice cut, recording page emitted. Owner sings ONE line naturally over the beat, once —
no coaching toward the render's timing. Drop path:
`mechanism/v1/gold.wav` (any sample rate; mono preferred).

**Registered prediction (P-V1):** mostly fine in the mouth — words are an amplifier, not the
root.

**Exit gates.** Natural → cap B2 investment at the cram-policy kill + soft terms. Awkward →
singability implicated as closer to root; B2 scope lifts.

---

## 3. V2 — oracle durations (the decisive experiment; gated on V1's WAV)

**Mechanism probed:** hold the ENTIRE stack constant — same lyric, same melody, same SoulX
arm, same NSF perform — and vary ONLY the duration vector (mumble-slot vs the owner's real
performance). This is sharper than the report's 2×2: one listen gives the ceiling of the
current architecture.

**Method.**
1. Extract per-syllable timings from gold: forced-align words → `align.slots_for_word` +
   FCPE; owner may hand-correct boundaries in the existing annotator (the 147-mark oracle
   precedent). Clock-register gold to the section via envelope lag (apply if > 30ms, log).
2. Author the ORACLE score: copy the baseline line's `note_pitch` sequence verbatim (= "same
   melody"); replace durations from gold slots. Note-count mapping (pure, golden-tested):
   k==m → 1:1; m>k → fold gold tail into the last note; k>m → surplus type-3 continuations
   get the gold word's tail, else are DROPPED (logged — a melisma the gold didn't perform is
   removed). Inter-word gaps/rests come from GOLD — natural P-center placement is the
   mechanism under test. Event strings rebuilt directly with `author_score`'s 4dp
   error-diffusion pattern; spliced into the baseline chunk; `time[1]` renormalized
   (`sum(durations) == time[1]` ± 5ms asserted).
3. Render BOTH the unmodified baseline chunk and the oracle chunk through the identical local
   arm: SoulX-MLX score-mode (`~/AI/soulx-mac`, own-30s ref) → NSF `perform`
   (`service/nsf/nsf_cli.py`, nsf venv). Baseline re-rendered locally so both arms share one
   backend (the archived chunk renders may be pod renders).
4. Blind 3-way listen page: current-slot / oracle-duration / gold human, line span ± 0.5s,
   labels randomized (seed = hash of inputs), unblinding map in a side JSON not linked from
   the page. The V0 estimator re-runs on both arms; its numbers go in the JSON only
   (post-vote) — oracle should collapse `onset_delta` toward 0 if H is real.

**Registered prediction (P-V2):** oracle ≈ human-ish; current-slot clearly synthetic.

**Exit gates.**
- **Oracle ≈ human** → durations are the root cause; architecture confirmed; build B1.
- **Oracle still synthetic** → the stage-2/3 lyrics-and-timing thesis is FALSIFIED as
  sufficient; do NOT build B1; run V3 (assembly ablation); this is the park signal for
  own-voice Phase 3 until after first-stranger.

**Files:** `scripts/fms-killshot/oracle_duration.py`, `oracle_duration_test.py`.
**Outputs:** `mechanism/v2/` (scores, renders, `oracle-listen.html`, `oracle-labels.json`).

---

## 4. V3 — assembly ablation (ONLY if V2's oracle fails, ~2h)

**Mechanism probed:** the stage-5 micro-editing machinery itself (per-word snap ± 120ms with
10ms crossfades at every word event) — the owner has proven ears for processing artifacts
(the envelope-transfer verdict).

**Method.** Same score three ways through stage 5: full per-word snap / phrase-snap only
(± 250ms) / single-chunk no-snap. Blind listen.

**Exit gates.** If de-snapped arms read more natural → the suspect moves to snap/crossfade
assembly; fix there before revisiting durations. If all three read equally synthetic → suspect
moves to the render/vocoder (SoulX timbre OOD or NSF), and own-voice Phase 3 parks.

---

## 5. V4 — SoulX probes (parallel with V0, ~1h)

### V4a — shipped-example score statistics

**Mechanism probed:** does SoulX's own training convention keep onset consonants INSIDE the
note (voicing lag ≈ cluster duration) or budget them into the prior tail (lag ≈ 0)? The
shipped example scores embed a 50fps `f0` string, so this is directly measurable.

**Method.** `~/AI/soulx-mac/SoulX-Singer-MLX/example/audio/*.json` (shipped) vs our authored
chunk scores. Per note: duration × note_type × onset-cluster (same classifier as V0). For
voiceless-onset notes: voicing lag = (first f0 > 0 frame ≥ note start) − note start. Plus:
fraction of OUR note durations below the shipped 5th percentile per note_type (a joint-coverage
proxy). `mainvox_score.json` provenance verified before bucketing (index suggests
Mosh-authored → "ours"). Caveat registered: ~4 shipped clips — directional only, never gates
alone.

**Registered prediction (P-V4a):** shipped voicing lag ≈ 0 on voiceless-onset notes
(consonants budgeted before the note) — strengthening H at the model level.

### V4b — melisma probe

**Mechanism probed:** does note_type=3 slur actually work (upstream issue #37 risk)? Gates
whether melisma is available to the B2 lyric fix at all.

**Method.** Three minimal clips authored as raw strings: M1 two-note slur (type 2→3, +3st,
held vowel per `_held_vowel`), M0 re-attack control (type 2/2, full phoneme both), M2 −4st
variant. Rendered via the identical MLX arm (own-30s ref).

**Pass (registered):** (1) continuous FCPE voicing across the note boundary (no gap > 30ms
within ± 100ms of it), (2) pitch step 3 ± 1st between note-half medians, (3) no
re-attack transient / > 6dB dip-and-rise in the boundary window (vs M0 which must show one),
(4) rendered length within ± 10% of commanded.

**Exit gates.** PASS → melisma usable for tol-±1 in B2. FAIL → no melisma anywhere in Phase B;
tol-±1 via slot-merge under-fill only; V2's k>m rule always takes the drop branch.

**Files:** `scripts/fms-killshot/soulx_example_stats.py`, `melisma_probe.py`.
**Outputs:** `mechanism/v4/example-stats.{json,html}`, `mechanism/v4/melisma/` + verdict JSON.

---

## 6. Decision rules (registered)

| Signal | Consequence |
|---|---|
| V0 clean-subset median < 20ms AND no squeeze | Demote P-center; weight joint-distribution + lyric fixes |
| V1 gold sounds natural | Cap B2 at cram-policy kill + soft terms |
| V2 oracle ≈ human | Build B1 (stage-3 rewrite); durations confirmed as root |
| V2 oracle still synthetic | NO B1; run V3; park own-voice Phase 3 until after first-stranger |
| V4b slurs broken | No melisma in Phase B; slot-merge under-fill for tol-±1 |

## 7. Threats to validity (registered)

- **T1** MMS_FA is a speech aligner; sung-word boundaries may bias toward transients →
  mitigated by the word-snap positive control + CTC-score filtering.
- **T2** FCPE voicing onset = vowel onset ONLY for voiceless onsets → the clean subset gates;
  voiced-onset rows reported but never gate.
- **T3** Take-side reference assumes score span == take syllable span; `clamp_slots_to_voicing`
  trimming can break it → the commanded-vs-realized column (`onset_delta_score`) is immune and
  reported alongside.
- **T4** Small n in the 2+ bucket → n ≥ 8 rule; u2+t1 pooled for the trend test.
- **T5** NSF `perform` F0 is take-shaped by construction → NSF lanes never gate.
- **T6** MLX bridge seeding unknown → check for a seed flag; render 2 samples per V2 arm if
  cheap.

## 8. Phase B sketch (gated — NOT built in this spike)

- **B1** stage-3 rewrite: durations DERIVED, not transferred. Hard anchors = phrase start/end
  + stressed/downbeat VOWEL onsets pinned to nuclei, onset consonants budgeted BEFORE the
  anchor (magnitudes from V0); between anchors a deterministic zero-sum rule layer
  (stressed-rime lengthening, function-word compression, phrase-final lengthening,
  articulability floor × cluster size) with parameters FITTED from the owner's own V1/V2 gold
  lines (enrollment-sings-one-line as a future product mechanic). Pure arithmetic, no model.
- **B2** stage-2 singability: kill the surplus-word cram outright; soft terms
  (open-vowel-on-longest-slot, cluster × local-tempo penalty, stress-length agreement);
  tol-±1 via the V4-validated mechanism only.
- **B3** metric fix: vowel-onset alignment + duration-plausibility replaces the 9ms word-start
  gate.

Each B item becomes its own plan after the V verdicts land.
