# openai/gpt-5.6-sol

The premise is partly wrong: there is no pretrained model that reliably outputs “musically good.” Google’s MuLan/MusicLM work is relevant, but not a deployable oracle for owner taste. The practical solution is a calibrated, project-relative preference model built on frozen music representations.

## 1. Architecture: a multi-axis eval loop

Do not collapse everything into one score. Evaluate each completed task on five axes:

1. **Command correctness** — existing MoshAgentBench checks.
2. **Intent adherence** — does the audio match the request/reference?
   - CLAP text↔audio similarity.
   - For transformations, compare requested attribute deltas: “more aggressive,” “half-time,” “warmer.”
3. **Musical integrity** — objective regressions:
   - Beat/downbeat stability, clipping, silence, key/chord violations, vocal intelligibility, unintended loudness jumps.
4. **Generic production quality** — existing Audiobox `pq`, plus loudness/dynamics/artifact detectors.
5. **Owner preference** — a learned pairwise model, conditioned on the source/project and requested edit.

The critical unit should be **the edit delta**, not the resulting track in isolation:

> Given source S, request R, and candidates A/B, which edit improved S more?

For every consequential task, snapshot the source and optionally render 2–4 candidate outcomes. Store short aligned before/after excerpts, commands, intent, embeddings, objective metrics, and owner verdict. Use uncertainty sampling so the owner hears only informative pairs.

Train a small Bradley–Terry/logistic preference head over:

- source, candidate, and candidate-minus-source embeddings;
- CLAP intent scores;
- objective musical metrics;
- command/parameter metadata.

Split evaluation by **source hash/project**, never random renders, or seed variants will leak. Track pairwise accuracy, calibration, owner test–retest ceiling, and performance by task type.

Then close distinct loops:

- **At inference:** generate several plans/seeds and rerank them with hard constraints + preference score.
- **Prompt/knowledge:** mine recurrent failure clusters into explicit policies and retrieval examples.
- **SFT:** train on successful/repaired traces, not merely all passed traces.
- **Preference optimization:** only after enough blind comparisons, DPO/ORPO the agent’s plan/command policy. For a closed or expensive audio generator, keep preference learning as reranking rather than pretending end-to-end RL is practical.
- **Bench expansion:** every owner/automatic-judge disagreement becomes a minimized regression task.
- **Renderer LoRAs:** gate them on held-out pairwise win rate against the previous LoRA, not training loss or accepted-track similarity.

For FMS-Bench, score separate dimensions: Whisper word/phoneme correctness, speaker similarity, and naturalness. Similarity to the exact human take should not be the sole target because valid reconstructions can differ expressively.

## 2. Specific judge models

- **`laion/clap-htsat-fused`**
  - Measures audio↔text and audio↔audio semantic similarity.
  - Useful for intent, style, instrumentation, and rough reference matching.
  - Weak on exact harmony, long-form structure, groove quality, and mastering; can reward obvious semantic cues.
  - Validate on owner pairs grouped by request type; test whether CLAP-score *delta* predicts preference better than absolute score.

- **`m-a-p/MERT-v1-330M`**
  - Strong frozen musical representations containing timbre, pitch, harmony, and rhythm information.
  - Not an aesthetic scorer. Mean pooling can erase arrangement and timing defects.
  - Train only a small preference probe across several MERT layers and pooling schemes; evaluate held-out-project pairwise accuracy.

- **Essentia `discogs-effnet-bs64-1` and MTG-Jamendo tagger models**
  - Produce robust style, genre, mood, instrumentation, danceability-like descriptors.
  - Useful for measuring whether an edit moved in the requested direction.
  - Taxonomy-biased, weak on novelty and production nuance, and may mistake genre conformity for quality.
  - Validate per attribute using deliberately controlled transformations, not only historical likes.

- **CPJKU Beat This!**
  - Beat/downbeat tracking for groove continuity, tempo drift, and edit-boundary disruption.
  - Fails on rubato, ambient music, unusual meters, and intentional syncopation.
  - Validate against known Mosh tempo maps and hand-marked short excerpts.

- **Spotify Basic Pitch**
  - Polyphonic note transcription for melody preservation, pitch range, note density, and key checks.
  - Unreliable on dense mixes, percussion, bends, and heavily processed vocals.
  - Use only stem-wise or on exposed melodic passages.

- **`Qwen/Qwen2-Audio-7B-Instruct`**
  - Can provide rubric-based descriptions: audible artifacts, instrumentation, structural observations.
  - Prompt-sensitive, inconsistent, and liable to produce plausible criticism unsupported by audio.
  - Treat outputs as features or failure tags, never ground-truth rewards; require blind owner agreement testing.

- **`openai/whisper-large-v3`, SpeechBrain ECAPA-TDNN, UTMOS/DNSMOS**
  - Respectively: lyric correctness, speaker identity, speech naturalness/degradation.
  - Appropriate for FMS/vocal stems, not whole-song musical quality. DNSMOS especially can dislike desirable vocal effects.

Also use **FAD via `fadtk`** with MERT/CLAP embeddings for release-level distribution regressions. FAD cannot rank individual renders reliably.

## 3. One-week foothold

Build the **project-relative taste arena and frozen-embedding probe**.

1. Sample 100–200 historical accepted/rejected or same-source render pairs.
2. Add 50 fresh blind pairs, including close calls and automatic-judge disagreements.
3. Cache CLAP, MERT, Discogs-EffNet, `pq`, loudness, and basic rhythm features.
4. Fit regularized Bradley–Terry/logistic models.
5. Produce a held-out leaderboard, calibration plot, and uncertainty queue.
6. Integrate the best model as a non-blocking candidate reranker for 2–4 generated seeds.

This yields an immediate measurable question: “Does reranking beat random seed selection in blind owner trials?” It starts the flywheel without touching the generator.

## 4. Contrarian card

Turn Mosh’s command seam into a **randomized controlled micro-edit laboratory**.

Have Moshi create two minimal, reversible variants of the same project—e.g. timing ±8 ms, drum density ±10%, saturation before/after compression, alternate voicing—while changing exactly one causal factor. Present blind, loudness-matched excerpts and learn a **contextual preference gradient**, not a global “good music” score.

Most taste datasets confound song, composition, mix, model, and prompt. Mosh can uniquely generate controlled counterfactuals. That causal dataset may become more valuable than any pretrained Magenta embedding.
