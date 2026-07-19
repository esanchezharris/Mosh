# moonshotai/kimi-k3

**Premise correction first:** the owner's hunch is wrong. There is no Magenta/MuLan-style model that encodes *his* taste — MuLan is closed, Magenta never shipped a quality scorer, and every open embedding measures *typicality* (distance to population-average music), which past a hygiene floor is anti-correlated with a signature sound. The model you're not utilizing is a ~200-line head trained on your own accept/reject archive. Off-the-shelf models are floors and features, not judges.

## 1. Architecture: layered judges, selection before training

**L0 — Deterministic auditors (free, incorruptible).** Extend your goal-checks with signal-domain hygiene: pyloudnorm LUFS/true-peak, clipping, phase correlation, spectral centroid/rolloff (librosa), Demucs stem balance for mix sanity; for MIDI, pretty_midi/MusPy metrics (in-key %, velocity variance, empty-beat rate, voice-leading jumps). Most "bench said pass but felt wrong" cases are probably measurable here — machine-gun velocities, crushed crest factor, washy low end.

**L1 — Population judges.** Audiobox-aesthetics (all four axes — see below), MuQ-MuLan/CLAP prompt-alignment, FAD-CLAP distance to a reference set of the owner's canon tracks.

**L2 — Personal taste probe.** Logistic regression / small MLP on frozen embeddings of every labeled render. This is the taste model.

**L3 — Owner arena, actively routed.** Owner minutes go only to pairs where L0/L1/L2 disagree or the probe's margin is smallest. This systematizes your by-ear gate: disagreement cases *are* the arena queue, and every verdict becomes a new bench task (disagreement → missing check → MoshAgentBench grows).

**Improvement mechanisms, in order:** (a) **Best-of-N selection** — re-imagine renders N=4 candidates, probe picks, agent ships one. A reward model pays off first as a *selector*, zero training risk. (b) **Taste-memory retrieval** — embedding nearest-neighbors of past liked renders injected into Moshi's context as style anchors. (c) Knowledge/prompt rules distilled from judge-vs-owner disagreement audits. (d) Only later: DPO via your SFT lane on probe-validated pairs, gated on both benches. Primary KPI: accept-rate of probe-selected vs. single-shot renders.

## 2. Judge models (real checkpoints)

- **`facebook/audiobox-aesthetics`** — You're discarding 3/4 of it. **CE (content enjoyment)** is literally the "musicality" axis; **PC** (production complexity) catches lazy renders. Failure: trained on broad audio, biased toward clean-and-boring; penalizes intentional lo-fi/distortion. Validate: does CE separate your existing accept/reject labels with AUC ≥ 0.7 before trusting it?
- **MuQ-MuLan (`OpenMuQ/MuQ-MuLan-large`)** — best open music↔text embedding right now; measures prompt-alignment and similarity-to-anchor. Failure: tag-level semantics, blind to mixing detail, coarse on structure. Validate: rank liked-vs-rejected by similarity to the owner's canon tracks; beat chance or it's a feature extractor only.
- **LAION-CLAP (music checkpoint)** — older, more tooling; AudioCaps/Audio
