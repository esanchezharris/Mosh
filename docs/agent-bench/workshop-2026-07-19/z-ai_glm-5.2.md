# z-ai/glm-5.2

## 1. Architecture

Don't build one loop — build two and keep them separate.

**Loop A — disagreement mining (command-level, the real engine).** Producer plays a build, hits a "felt wrong" hotkey. The agent (a) snapshots the current project, (b) diffs against the last "felt right" commit, (c) asks the producer to tag the reason in two words, (d) writes the pair into the loop-transcript archive with the command sequence that produced it. Then, offline, you run deterministic music-theory/rhythm checks (madmom, chordino, librosa — see §2) over the *good* and *bad* snapshots and look for a check that separates them. When you find one, you add it as a new goal-check to **MoshAgentBench** and mint 3–5 new tasks that exercise it. Top-model score drops from 82.4 → (some lower number). That gap is your SFT lane's new training signal. Repeat weekly.

**Loop B — pairwise taste arena (render-level only).** This is the only place where a learned judge makes sense, because generative renders sit in continuous timbre/space and don't have a command diff to mine. Use the existing arena pattern, run **AudioBox `pq`** as a coarse floor (auto-reject degraded), then within the "pq-acceptable" pool, show producer pairs, log verdicts → Elo. SFT lane ingests ranked renders as DPO pairs. But do **not** expect this to explain "felt wrong" on edits — it won't.

## 2. Judge models (real, with honest failure modes)

- **AudioBox-Aesthetics `pq`** (Meta, in pipeline): mean Q/predicted aesthetic on audio segments. Failure: trained on broad human ratings, blind to genre-specific taste; it'll happily pass a clean but musically wrong render. Validate: Spearman on the existing accept/reject label set. If <0.3, demote to floor-only, which is what you're doing.
- **MERT-330M** (Microsoft) / **MusicFM** ( MusicFM, ICASSP '24): transformer embeddings of waveform. Use as **KNN similarity to owner's accepted renders** — "does this embedding land near my liked cluster?" Failure: coarse — it'll tell you it's plausibly dark trap, not whether the kick is on 3. Validate: leave-one-out recall@5 on the like-set; below 50% discard.
- **CLAP-Music-LAION**: audio-text contrastive embedding. Useful only for one check: "does the render match the producer's one-line prompt" (e.g., "rainy lofi piano"). Failure: prompt-grounded only; useless for edits. Validate: label→audio retrieval on your prompts.
- **madmom** (downbeat/tempo/onset CNNs): the unglamorous workhorse. Convert MIDI/audio to downbeat grid; check kick placement, snare on 2/4 vs 3, swing consistency, vocal onset alignment. This is where 80% of "felt wrong" will actually be caught. No "taste" framing needed.
- **Chordino / Chordino-Qt** and **all-in-one music structure analyzer** (SlipperX on GitHub): chord + bar extraction. Lets you verify bass-in-key, chord progression logic, vocal harmonic fit.
- **Whisper-large-v3 + pyannote diarization/forced alignment**: only for **FMS-Bench** — aligns generated vocals to known transcript, scores WER + onset timing against the human take. This is the cleanest, highest-signal eval you already sketched; prioritize it for renders, not for general edits.
- **Magenta NSynth** / **MusicVAE**: skip. Embeddings are stale (2018), coarse, and no longer competitive with MERT/MusicFM. Don't burn a week here.

Validation rule for every judge: rank-correlate its scores with the existing taste-label archive on a held-out slice. **Kendall τ < 0.4 → do not train against it**, ever. The AudioBox-`pq` failure mode is exactly the trap you hit last time — a confidently-wrong judge is worse than no judge.

## 3. The one-week foothold

Ship the disagreement tag. Specifically:

1. Hotkey in the WebView ("⌘-Shift-F"): "this feels wrong."
2. On press: commit current project to a `felt_wrong` git lane, write the diff (command log since last pass) to the transcript archive, and surface a free-text field prefilled with the most recent 5 commands.
3. Cron job, nightly, over all `felt_wrong` snapshots vs the preceding `felt_right`: run **madmom** downbeat + **chordino** chord grid + a half-dozen theory checks you write by hand (kick on 1&3, snare on 2&4 for the relevant genres, bass root matches chord root, vocal onset within ±1/16 grid, no notes outside key signature, no consecutive identical drum hits across a bar unless flagged, etc.). Print the checks that fired on *wrong* but not on *right*.
4. Take the top 3 separating checks → add to MoshAgentBench as goal checks; generate 4 new tasks each; re-bench.

One week. Zero training. The top-model score will fall, and that drop is the cleanest training signal you've ever had.

## 4. The contrarian card

**Stop trying to build a taste judge.** The premise that you need an automatic musical-quality model is probably wrong, and the earlier failure ("trained audio LoRAs from liked tracks, no eval in the middle") is misdiagnosed as "missing judge." The real diagnosis: **at this stage of one producer's practice, "taste" is ~70% unwritten music-theory rules and ~30% genuine aesthetic residual**, and you've been treating the 70% as if it were the 30%.

Test this empirically before you train anything. After the one-week foothold, measure: of the first 30 "felt wrong" cases, what fraction has a discoverable, codable rule violation under madmom+chordino+handwritten theory? If it's ≥70% — which I strongly expect — then your "musicality eval" is actually a **rule-correctness eval** in disguise, and you should grow MoshAgentBench deterministically for months before ever touching a preference model. Only when the residual <30% gets frustrating do you spend a single GPU-hour on DPO.

Every other panelist will tell you to wire MERT or CLAP as a judge and start DPO on the taste labels. That's the failure path you already walked, just with a fresher model. The unpopular move is to bet that your producer's "taste" is mostly law, not lightning — and that the law is faster to write down than to learn.
