# anthropic/claude-sonnet-5

## 1. Architecture

Keep MoshAgentBench exactly as-is — it's a correctness gate, not a taste gate, don't conflate them. Add a second, separate rail:

**Gate 2 — Musical Fit, via pairwise arena.** Reuse the UI-design arena mechanism verbatim: for every generative task (re-imagine render, drum pattern completion, mix move), generate 2 candidates (different seed/LoRA/params), show the pair to the owner in normal workflow, log the verdict against the render fingerprint schema you already have. This produces a Bradley-Terry preference wall, not a single scalar score — scalars are the wrong data structure for taste, relative judgments are the right one, and you already proved this pattern works.

**Automatic judges sit *underneath* the arena, not above it.** Every render also gets scored in parallel by 2-3 candidate automatic judges (Q2). You do NOT trust these yet. You compute their agreement with the growing BT wall and the existing accept/reject log. Only a judge that correlates gets promoted to "auto-score at scale" — used to pre-filter candidates before they even reach the owner, multiplying the arena's throughput.

**Improvement mechanism:** once a judge is trusted, use it to construct chosen/rejected pairs at volume, feed the existing SFT lane as DPO-style preference optimization on the local model seat (LoRA r-series), gated by before/after reads exactly like your current r1–r5 protocol. Separately: every "bench passed but felt wrong" disagreement becomes a *new MoshAgentBench task* — that's how you un-saturate the correctness bench, by mining the by-ear gate for failure modes correctness-checking missed (e.g., technically-correct-key notes that are rhythmically dead).

FMS-Bench is not one more bench — it's the **calibration instrument** for everything else, see Q4.

## 2. The judge models (real, available now)

- **LAION-CLAP** (`laion/clap-htsat-unfused` or music checkpoint) — text/audio and audio/audio embedding similarity. Measures broad timbral/semantic match. Fails on fine rhythmic/harmonic precision, biased toward what's in its training text captions. Validate: cosine similarity vs. owner's existing +/- labels, check AUC — if it can't separate accepted from rejected on your own back-catalog, kill it immediately, don't iterate on it.
- **MERT** (`m-a-p/MERT-v1-330M`) — self-supervised music representation, stronger on pitch/rhythm/structure than CLAP. Use for "how similar is this take to the reference stem" rather than absolute quality. Failure mode: trained on broad pop-heavy corpora, may not track the owner's specific genre pocket. Same AUC validation against taste labels before trusting.
- **Audiobox-aesthetics** — you're only using `pq` as a floor. It has CE/CU/PC/PQ subscales; run all four against the taste-label archive via a simple logistic regression to see which subscale(s) actually predict accept/reject. You may find `pq` is the *wrong* subscale for this producer.
- **Magenta / Magenta RT / MusicVAE** — I'd steer this away from being an audio-quality judge (that's not its strength) and toward **symbolic-level similarity** for drum patterns and MIDI note choices, where Mosh already has deterministic goal-checks. Latent distance between generated pattern and "patterns the owner has historically kept" is cheap, interpretable, and matches Mosh's existing pattern-string representation.
- **Gemini 2.5 / GPT-4o with native audio input as an LLM-judge with a rubric** — zero training, stand up in a day, gives textual critique you can diff against the owner's actual by-ear notes. Validate by agreement-rate against held-out taste labels before it touches any reward signal.

## 3. The one-week foothold

Wire the arena to render pairs, retroactively and forward. Retroactively: mine the taste-label archive for near-matched prompt/seed pairs and backfill a BT wall for free. Forward: every new generative task auto-produces 2 candidates instead of 1, shown to the owner as a pair during normal sessions — no new UI paradigm, you already built this exact interaction once. Simultaneously log CLAP + MERT + all four Audiobox subscales as passive, non-gating scores on every render fingerprint. By day 7 you have real correlation numbers between each automatic judge and actual owner verdicts — the thing that's been missing isn't a judge, it's *proof any judge is worth trusting*. That proof is the flywheel-starter, and it's a week of plumbing, zero training.

## 4. The contrarian card

Two things I doubt the panel will say:

**Stop hunting for the magic pretrained model — you're sitting on a denser taste signal than any embedding net will give you, unused.** The agentic loop logs one undo per task and every re-prompt-after-render. Every undo, every "no, redo that," every abandoned render is an implicit preference label, and it's an order of magnitude denser than the explicit +/- log because it fires on every session, not just accepted finals. Build the first reward model off loop-transcript undo/redo patterns before you touch a single pretrained audio model. It requires zero new instrumentation — it's a query over data you already have.

**FMS-Bench is misfiled as a "seed idea" — it should be the top priority, above judge-shopping.** It's the only place in this entire stack where you have actual ground truth (a real human take) rather than a proxy. Its real job isn't to score mumble-reconstruction — it's to be the thing every candidate CLAP/MERT/Audiobox judge gets checked against before you're allowed to trust it on unlabeled data. I'd build FMS-Bench in week one, not month three, and treat every other judge as provisional until it passes through FMS-Bench's ground truth.

Where I think the premise is off: the missing piece isn't "the eval," it's the *validation protocol for a judge*. Any of the above models can be wired in an afternoon. Nobody has checked whether any of them agree with this specific producer's ears. That check is cheaper than everything else on this list — do it first.
