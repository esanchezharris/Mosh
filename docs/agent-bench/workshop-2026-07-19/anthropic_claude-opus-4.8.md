# anthropic/claude-opus-4.8

## 1. Architecture

Stop trying to build "a musicality judge." You can't validate a general taste oracle with one producer's labels — you don't have the sample size, and taste isn't a scalar. Build instead a **taste-agreement calibrator**: a cheap judge whose only job is to predict *this specific owner's* accept/reject, measured by how often it agrees with him on held-out labels.

The loop:

- **Measure**: For every render, compute a feature vector (embeddings + `pq` + params). The taste labels you already have (accept/reject + fingerprint) are your dataset. Train a *tiny* classifier on top of frozen embeddings to predict owner-accept.
- **Judge**: That calibrated classifier becomes the automatic gate. It doesn't judge "good music" — it judges "would he keep it," which is the only signal you can actually validate.
- **Improve**: Two mechanisms, ranked by cheapness. (a) **Prompt/param-space search**: the classifier scores candidate render params before you burn GPU generating them all — you're doing rejection sampling against predicted-taste. (b) Only once the classifier clears an agreement bar (say >80% on held-out), promote it to a reward for the SFT/preference lane.

Key architectural claim: **the eval and the improvement are the same artifact**. The classifier is both the bench and the reward model. Don't build them separately.

## 2. Judge models (real, available)

- **MERT** (`m-a-p/MERT-v1-330M`, HF): self-supervised music representation, per-layer features. Measures acoustic/musical structure. Failure mode: it's a *description* model, correlates with genre/timbre, not "good." Validate by frozen-feature logistic probe on taste labels; report held-out AUC.
- **CLAP** (`laion/clap-htsat`): audio-text joint embedding. Use it for *similarity/intent-match* ("does this render match 'warm analog pad'?"), not quality. Failure: text-audio alignment is coarse; hates anything unusual. Validate against the subset of taste labels where the owner had a stated intent.
- **Audiobox-aesthetics** — you already run `pq`. It also outputs **CE (content enjoyment), CU (content usefulness), PC (production complexity)**. You're throwing away three of four axes. `pq` is a floor; **CE is the closest off-the-shelf thing to "taste"** and you already have it computed. Validate CE against accept/reject *first* — it may already be 70% of the answer, free.
- **Mule** (Harmonix/`music-audio-representations`) or **MusicFM**: alternative embeddings; try if MERT probes weakly.
- The owner's Magenta hunch: **skip it.** Magenta's live checkpoints (MusicVLM aside) are symbolic/aging; not a quality judge. Don't chase it.

Validation protocol for all: freeze embeddings → logistic/GBM probe on taste labels → **temporal split** (train on early labels, test on recent — taste drifts, and you must catch that). Trust a judge only above a pre-committed agreement threshold. Below it, it stays advisory.

## 3. One-week foothold

**Retire the "barely used" taste labels into a working accept-predictor, and expose its disagreements.**

Concretely, in a week:
- Batch-run MERT + CLAP + the full 4-axis Audiobox on every logged render (you have the fingerprints/source hashes).
- Fit a probe to predict accept/reject. Report temporal-split AUC per feature family. This tells you *which judge is real* — the entire panel is guessing without this number, and you can have it in two days.
- Wire the best probe as a **pre-generation filter**: agent proposes N seed/param candidates, probe ranks, top-k get rendered. This immediately improves perceived output quality with zero training.
- Ship the **disagreement queue**: cases where probe says accept but owner rejects (and vice versa) go into a review lane. This is the systematized version of the by-ear gate — and it's your active-learning signal for round 2.

That's the flywheel's first tooth: labels → probe → filter → new labels → better probe. No SFT yet. No LoRA yet. Just make the graveyard of taste labels *predict*.

## 4. The contrarian card

Everyone else will tell you to build the audio-taste judge. Here's what they won't say:

**Your best musical-quality judge is your own command-correctness bench, run differently — and your best "new model" is a diffusion likelihood, not an embedding.**

Two contrarian moves:

**(a) Score renders by how surprised your own generator is.** Stable Audio 3 is a diffusion model; you can compute an **approximate denoising loss / ELBO** on any candidate audio conditioned on the prompt. Renders the model finds "typical for this intent" (low reconstruction error) vs. off-manifold garbage separate cleanly — and it needs *zero new models and zero labels*. This is the free, in-house quality signal nobody proposes because it's not a shiny external checkpoint. Validate it against taste labels the same way; I'd bet it beats CLAP.

**(b) The real bottleneck isn't the judge — it's that one producer can't generate enough preference bits.** So invert FMS-Bench. Don't wait for him to record vocals. Use the **loop-transcript archive as a self-play preference source**: for tasks where the agentic loop *repaired itself*, the pre-repair and post-repair snapshots are a free preference pair (the agent already decided post-repair was better). That's hundreds of automatic pairwise labels on *command-level musicality decisions* — DPO fuel — sitting unused in your versioned lane. The audio-taste problem is data-starved; the command-taste problem is data-rich and you're ignoring it.

Feed (a) into render selection, (b) into agent preference optimization. The panel will build one judge for audio. You should build two cheaper signals from assets you already own — and only buy an external judge if CE and diffusion-likelihood both fail their agreement bar.
