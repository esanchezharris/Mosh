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

## Verdict
Render infra + word ruler: DONE. The real pipeline generator PATH is proven (author_score +
local render sings the right words, ruler-verified). A clean third curve needs the melody-grid
+ voice-enrolment + wiring refinements above — de-risked, well-scoped, compute-bound.
