# minimax/minimax-m3



**Premise correction first.** You're framing this as "judge the audio." That's the wrong target. `pq` already gates render quality, and your previous LoRA attempt proved training audio generators from taste labels dies without a mid-loop signal. The actual bottleneck is the **agent's choices** — what tempo, what key, what instrumentation, when to lay back, when to commit. That's where producer taste lives, and it's exactly where your label coverage is thinnest. Reframe: you're not building an audio aesthetic eval — you're building an **agent-decision eval** that consumes audio as evidence.

**1. Architecture (the loop)**

Three judges, layered:

- **MIR judges (deterministic).** Tempo, key, chord, structural segmentation, vocal-onset-to-beat alignment. Cross-check each against the agent's declared intent. Mature, free, fast.
- **Producer-head (learned, small).** A LoRA on top of a music-text encoder, trained on accumulating taste labels: (intent, render-fingerprint) → scalar "producer score." Validated on held-out labels *and* on the by-ear "felt wrong" disagreements.
- **Trajectory arena (repurposed).** Pairwise comparisons of full agentic traces — plans, command sequences, render choices — on identical intents. You already proved this works on UI; apply it to plans, not audio.

Improvement mechanism order, by cheapness: (a) inject a curated "producer playbook" into the agent prompt; (b) DPO on trajectories once you have ~500 paired plan-comparisons; (c) SFT on command sequences *only if* both plateau. **Skip LoRA fine-tunes of the generator until (b) lands.**

Bench-task generation: synthesize intents, not commands. Sample (intent, producer's own past edits on similar intents) as gold trajectories.

**2. Real judge models (named, not categories)**

- **MusicFM** (ByteDance, 2024) — music-specific SSL backbone, beats MERT and HuBERT-Music on MARBLE. Strong general-purpose music encoder.
- **MuLan** (Google, 2022) — 128-d music-text joint embedding. Use for "does this render match vibe keywords." Failure mode: weak on production craft, strong on genre/mood.
- **CLaMP / CLaMP-S** (2024) — music-text contrastive with retrieval. Good for "find renders like accepted ones." Same genre bias as MuLan.
- **MuQ** (ByteDance, 2024) — music QA model, currently top of MARBLE benchmark. Use as an LLM-style judge ("describe + score"). Failure mode: hallucinates detail.
- **Audiobox-aesthetics** — keep as a *floor*, not a target. Don't optimize against it.
- **MIR classifiers** for deterministic gates: **BeatNet** (tempo/beat), **BTC-ISMIR2019** or **Chord-CNN** (chord), **SF-NMF** for structure, **CREMA** for multi-pitch. 95%+ accurate in-genre, give a free per-render fingerprint.
- **LP-MusicCaps** (Samsung, 2023) — auto-captioning, useful for "describe the render" diffs against intent.

Validation gate against the owner: hold out 20% of labels, require producer-head AUC ≥ 0.75, AND require it to rank producer-flagged "felt wrong" renders below bench-passed renders on ≥ 70% of the by-ear disagreement set. If it doesn't, the head is overfitting genre.

**3. One-week foothold**

Build the **producer-head + MIR gate** and surface it in the WebView. Concretely:

- Day 1–2: extract MusicFM + MuLan embeddings from your existing render archive. Fingerprints already exist; this is feature extraction only.
- Day 3: train a 2-layer MLP head on whatever taste labels have accumulated, 5-fold CV.
- Day 4: wire BeatNet + Chord-CNN as deterministic render checks.
- Day 5: ship a "Producer Score" panel showing (a) producer-head, (b) MIR fingerprint, (c) `pq` floor.
- Day 6–7: log producer agree/disagree verdicts against the producer-head — that's your next training set.

This is the flywheel starter: zero automatic taste signal → one, calibrated to *your* labels.

**4. The contrarian card**

**Stop training on outputs. Train on the trajectory gap.**

This is what other panelists won't say. The highest-leverage training signal in your system is sitting unused: the producer's own edit history on real projects. Every time the producer manually adjusts an agent-made render, the diff between agent-final and producer-final is a labeled (state, action) preference pair. It's already in your command archives; you're treating it as logs, not supervision.

For each `(intent, agent_trajectory, producer_corrections)`, the corrections are **preferred actions** in the agent's context. Train DPO on agent-actions with producer-actions as preferred. This is:

- Deterministic — no embedding or aesthetic model required.
- Already aligned with the producer by construction.
- Captures the exact thing the bench can't see — the micro-taste: "this kick is 1 dB too hot, that vocal sits a half-beat late, that fill doesn't earn its place at bar 17."

You're sitting on a preference dataset. You just haven't been labeling it as one.

And the FMS-Bench seed? Park it. It's a clean isolated mic for one dimension (lyric intelligibility), but it's not the flywheel — the trajectory gap is. You have the data; you don't need a phonology validator to crack this open. You need DPO on your own diffs.

One last pushback on the owner's hunch: it's not Magenta. Magenta is a research surface, not a judge. The model you're "not utilizing" is the producer — their corrections, already logged, waiting to be re-read as supervision.
