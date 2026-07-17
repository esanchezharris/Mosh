# FMS-Bench — the third curve (real SoulX pipeline): investigation + proven path (2026-07-17)

Arming the `pipeline` generator (the real FMS sing chain) so it becomes the third scoreboard
curve. This records what was proven, the two hard obstacles, and the working path.

## Proven
1. **Local SoulX renders.** `~/AI/soulx-mac/SoulX-Singer-MLX` (bf16 2.6 GB weights, MLX
   Device(gpu,0), the MLX bridge, phoneset) + the owner's enrolled voice (`own-30s`) all
   live; a prior owner render transcribes as clean English. Render ≈44 s / 12 s chunk, serial.
2. **A singing-capable word ruler** (`bench_align.py`, golden ×3). Whisper CANNOT read slow
   sustained singing (1 word in a clean edelweiss slice) — its `word_match` is a broken ruler
   on sung content. MMS forced alignment (`align_probe`, skeleton venv) of the KNOWN words →
   per-word acoustic score. Validated: JLEE clean **0.377** (62% words >0.3) vs mumbled@0.6
   **0.163** (15%). This is the ruler for evaluating SoulX renders (and should replace/augment
   `word_match` across the benchmark).

## The two obstacles (and the resolution)
- **Whisper is a broken ruler on singing** → use forced alignment. (Solved above.)
- **Score authoring is the hard core.** Hand-rolling NUS phones → syllables → phonemes sings
  the WRONG words: the JLEE hand-authored render aligns **0.042** (0% hit) vs clean 0.377 —
  worse than the mumbled floor. The SoulX phone_set tokens are valid (compound `en_T-AY1-M`
  are split by the bridge; u2full uses them and renders clean), so the fault is the phonetic
  sequence, not the format.

## Working path — the PRODUCT `author_score`
Feeding NUS words (real text via the phonology venv's reverse-CMUdict) through the product
`soulx.score.author_score` (which derives correct ARPAbet + spreads phones over note_type
2/3 notes) and rendering locally: the JLEE render aligns **0.167 (25% hit)** — **4× the
hand-authored 0.042**, at the mumbled floor. SoulX is singing "late in the evening" in the
owner's voice. `bench_soulx_author.py` runs author_score under the phonology venv;
`bench_pipeline_render.py::render_chunk` drives the bridge.

**So the real pipeline generator is viable.** The remaining lift to a clean, high third curve:
1. **Better melody grid** — build slots from the real skeleton (`build_skeleton_spec`) instead
   of one-slot-per-word equal-duration segments, so SoulX gets true per-syllable pitch/timing.
2. **Voice** — enrol each NUS singer's voice (not the owner's) so f0/register comparison is
   in-voice; today it's cross-voice (word/timing/naturalness stay valid).
3. **Word source** — NUS reverse-CMUdict is ~65% (phone-labels for the rest); a fuzzy pass or
   the NUS phones-direct-to-author_score would lift it.
4. **Wire** `gen_pipeline` in `bench_run.py` to this path (author_score + render, multi-venv
   orchestration) + run the sweep (serial MLX, ~44 s/chunk → an overnight run for a full slice).

## Files
- `bench_align.py` (+test) — the forced-alignment word ruler.
- `bench_soulx_author.py` — NUS words + F0 → product `author_score` → SoulX score (phonology venv).
- `bench_pipeline_render.py` — score authoring (hand path, superseded) + the bridge driver.

## Third-curve RUN (wired + executed, 2026-07-17)
`gen_pipeline` is wired (`bench_pipeline_render.pipeline_generate`: NUS true words + clean F0 →
product `author_score` under the phonology venv → local SoulX render). `bench_third_curve.py`
runs the windowed 3-way (oracle / passthrough / pipeline) scored on the SAME 12 s window with
the forced-align word ruler + onset F1 + pq. First run — ADIZ/JLEE/ZHIY:

| generator | word recovery | onset F1 (timing) | pq |
|---|---|---|---|
| oracle (clean) | 0.348 | 1.00 | 7.47 |
| **pipeline (real SoulX)** | **0.238** | 0.414 | 6.83 |
| passthrough (mumble) | 0.180 | 0.889 | 6.87 |

**Headline: the pipeline beats the mumble floor on word recovery** — it recovers words the
mumble lost. Per item (excluding ADIZ/edelweiss, which is ruler-degenerate — even the clean
vocal aligns 0.11): JLEE floor 0.13 → pipeline **0.253** → ceiling 0.478 (halfway up); ZHIY
floor 0.316 → pipeline **0.40** → ceiling 0.455 (~¾ up). This is the measurement the framework
exists for, on real vocals, with a singing-capable ruler.

**Honest costs shown:** (1) timing — pipeline onset F1 0.414 vs the mumble's 0.889: SoulX
re-times and my crude equal-duration slots drift onsets → the melody-grid refinement is the
lever. (2) Cross-voice (owner's ref) → f0-register not comparable (word/timing/naturalness are).
(3) Some NUS content (edelweiss) is unalignable — flag/exclude items whose oracle align is at
the ruler's noise floor.

## Verdict
Render infra + word ruler + wired pipeline generator + a real third curve: DONE. The real
SoulX pipeline measurably recovers words above the mumble floor (JLEE 0.13→0.25, ZHIY
0.32→0.40). Refinements to push it toward the ceiling — real skeleton melody grid (timing),
per-singer voice enrolment (register), NUS reverse-CMUdict coverage — are well-scoped and
compute-bound; the full overnight sweep just scales this run.
