# anthropic/claude-fable-5

# Panel answer

**Premise check first:** the owner's hunch is half-wrong. There is no Magenta silver bullet — MuLan was never released, MusicLM's evaluator isn't public, and Magenta's open artifacts (MT3, DDSP) are transcription/synthesis tools, not judges. The model you're "not utilizing" is boring: **MERT plus a linear probe trained on the taste labels you've been accumulating since day one and barely using.** You don't need a universal musicality judge. You need a *personal* one, and you already have the training data.

## 1. Architecture: two loops, not one

**Loop A — agent competence (symbolic).** MoshAgentBench is saturating because it tests "did the command land," not "was it a musical choice." Extend it with **deterministic symbolic musicality checks** on the project snapshot: voice-leading violations, out-of-scale non-chord tones, drum-pattern density/syncopation stats, gain-staging sanity, clip overlap/collision. music21 + ~30 heuristics. Every by-ear-gate disagreement ("bench passed, felt wrong") gets converted into a new bench task with a symbolic check encoding *why* it felt wrong — that's your bench generator, and it un-saturates the bench with exactly the failures that matter. Improvement mechanism: mined failing transcripts → prompt/knowledge updates first (cheap, fast), then SFT on winning trajectories via the existing lane.

**Loop B — taste (audio).** Judge cascade, cheapest first:

- **Tier 0:** symbolic checks (free).
- **Tier 1:** Audiobox-aesthetics — you're only reading `pq`. Read **CE (content enjoyment) and PC (production complexity)** too; they're already computed.
- **Tier 2:** the personalized probe (below).
- **Tier 3:** the owner, via the arena pattern, budgeted ~15–20 pairs/session — ground truth, spent only on pairs where tiers 1–2 disagree or are uncertain (maximally informative pairs).

Improvement mechanism for Loop B: **best-of-N rerank at inference** (immediate value, zero training), and arena verdicts accumulate as preference pairs → **DPO on the LoRA seat** through the existing SFT lane. Rejection sampling gets you 80% of RLHF's benefit at this scale.

## 2. The judges — real checkpoints

- **MERT-v1-330M (m-a-p, HuggingFace).** Music SSL embeddings; mid layers encode harmony/timbre/rhythm. It measures *musical content similarity*, not quality — you make it a quality judge by training a logistic head on your +/− taste labels. Failure mode: 24kHz mono, weak on production polish and stereo image. Validate: chronological holdout on the taste archive; trust at AUC > 0.75.
- **Audiobox-aesthetics CE/CU/PC axes (Meta, already in your pipeline).** Population-average enjoyment. Failure mode: genre-normative, punishes intentional lo-fi/weirdness — exactly the taste dimension a producer cares about. Validate: correlation of CE with owner labels *per genre bucket*; expect it to fail on the interesting cases, use it only as a floor.
- **LAION-CLAP** (`music_audioset_epoch_15_esc_90.14.pt`) — text↔audio similarity. Use for prompt adherence ("did the re-imagine stay a dark garage beat?"), never for quality. Failure mode: tag-level understanding, deaf to arrangement.
- **MuQ / MuQ-MuLan (Tencent, open weights, 2025).** Stronger than MERT on several MARBLE tasks; the closest open thing to Google's MuLan. Run it head-to-head with MERT as probe backbone — one afternoon.
- **FAD via `fadtk` with MERT embeddings.** Distributional distance from a render *set* to the owner's liked set. Good for "did LoRA r4 drift from the owner's sound vs r3" — the exact iteration-N-vs-N+1 signal that was missing. Failure mode: needs dozens of samples, meaningless on one render.
- **Whisper-large-v3** for FMS-Bench: WER against known lyrics = the correctness axis, fully automatic. Naturalness axis = the MERT probe. This makes FMS-Bench your one benchmark with *human ground truth* — use it to sanity-check every other judge.
- **Qwen2-Audio-7B-Instruct** as an LLM critic producing *textual* critiques ("kick and bass masking") fed back into the agent's repair step. Failure mode: fluent hallucination; validate by whether its critiques, when acted on, flip owner verdicts.

## 3. The one-week foothold

**The reranker.** (1) Embed every archived render fingerprint with MERT-330M — seeds mean everything is reproducible. (2) Train a logistic probe on the taste labels, chronological 80/20 split. (3) If AUC clears ~0.7, wire best-of-4 into the render pipeline: generate four seeds, PQ-floor filter, probe reranks, top one surfaces, runner-up behind a "show alternate" button. (4) Every accept/reject is a new label; alternate-clicks are free preference pairs. The producer feels improvement *this week* with zero model training, and the flywheel (labels → better probe → better rerank → more labels) starts spinning by itself.

## 4. The contrarian card

**Stop trying to judge audio at all for the agent loop — judge intentions, symbolically.** Most panelists will architect audio-embedding judge stacks (I did too, above, for the generative renders — fine). But Moshi's failures are mostly *decisions*: wrong voicing, boring drum pattern, muddy arrangement — all visible in the session state *before rendering*, at 1000x lower cost. The contrarian bet: a "taste" model that never hears audio — a small LLM fine-tuned on (session-state-diff → owner arena verdict) pairs from the transcript archive, predicting "will the owner like this edit" from symbolic state alone. If it works even weakly, Moshi gets taste-guided *search over plans* — proposing five arrangements and pruning four before a single sample renders. Everyone else will point their judge at the speakers. Point yours at the score. The DAW's whole advantage over end-to-end music generators is that it *has* a score — use it.
