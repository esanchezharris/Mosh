# x-ai/grok-4.5

# Panel response: Moshi taste loop

**Premise pushback first.** The missing piece is not “a Magenta model you haven’t plugged in.” Past failure was training on likes with no *ranked comparative* signal and no *intent-alignment* target. Abstract aesthetic scorers saturate and then drift from one producer’s ear. Build the judge against *your* labels; don’t hunt a universal oracle.

## 1. Architecture

**Measure three stacked signals, never one:**
- **L0 structural** — existing MoshAgentBench goal-checks (keep; it’s the regression gate).
- **L1 intent alignment** — text↔audio similarity of final mix (or stem) vs the task brief / agent plan goal sentence.
- **L2 owner-relative taste** — pairwise preference vs a fixed baseline render for that brief, plus accept/reject on generative leaves.

**Judge ensemble (automatic, cheap):** CLAP score (L1) + Audiobox-Aesthetics CE/CU/PC (you already run PQ) + a tiny reward head trained on *your* +/− and arena verdicts (L2). Flag low-agreement items for the by-ear owner gate.

**Loop (one owner, Mac + CUDA box):**
1. Agent runs task → snapshot + render fingerprint.
2. Ensemble scores → pass/fail + critique text (nearest rejected neighbor, which axis failed).
3. Owner arena only on ensemble–owner disagreements and on “bench pass / ear fail” cases (high leverage, few comparisons).
4. Improvement stack, in order of cost:
   - **Prompt/tool memory:** store winning trajectories and “don’t do X when Y” as few-shot repair notes in the agent loop (days).
   - **Preference optimization:** DPO/ORPO on *trajectory pairs* (command sequences + render) where the same brief produced win vs lose — use your SFT lane, LoRA on the local seat.
   - **Bench growth:** auto-mint new MoshAgentBench tasks from failed repairs and from ear-disagreement snapshots (goal-checks written from the diff).
   - **Generate LorA only after** the reward head’s Spearman vs owner stabilizes; freeze the judge while the policy moves.

No user base required: the producer *is* the labeler; volume comes from every accept/reject you already log and from synthetic pairs (same seed/brief, different agent runs).

## 2. Judge models (real checkpoints)

| Checkpoint | Measures | Failure modes | Validate before trust |
|---|---|---|---|
| **LAION `larger_clap_music_and_speech`** | Text–audio & audio–audio cosine; intent match, “same vibe” | Lyrics/language bias; weak on mix roughness; absolute score meaningless across domains | Rank correlation of CLAP(brief, render) vs owner accept/+; audio–audio distances on same-brief pairs vs arena Elo |
| **Meta `audiobox-aesthetics` (CE, CU, PC, PQ)** | Production quality, complexity, content enjoyment; PQ already in pipeline | Trained on general audio aesthetics ≠ genre-producer taste; games the clean/loud | Per-axis Spearman vs +/− labels; ablate axes — keep only those that track owner |
| **`m-a-p/MERT-v1-330M`** | Frame-level music representation (harmony/rhythm structure) | Not preference; needs a probe; tempo/key sensitive | Freeze MERT → linear probe on your +/−; if probe <~0.6 AUC, don’t use raw distance |
| **`Qwen2-Audio-7B-Instruct`** | Open-ended critique, rubric scores, “in key / muddy / loop fatigue” | Hallucinated technical claims; sycophancy; slow | Blind rubric vs owner on 50 renders; measure precision on “reject” class only |
| **FAD with CLAP or VGGish stats** (no new net) | Distributional distance set-to-set (agent batch vs owner-accepted set) | Set-level only; useless per-clip gating | Track FAD(accepted_ref, candidate_batch) across LoRA/policy versions — version trend, not clip score |

**Do not start with** closed Magenta/MuLan APIs or image LAION-Aesthetics. MuLan-class signal is roughly what CLAP music already gives you open-weight.

**Validation protocol (expensive ears, once):** 100–150 same-brief pairs from the taste log + arena → owner verdicts → Spearman/Kendall of each automatic score vs those verdicts. Keep a judge only if it beats “always pick higher PQ” and beats random. Ensemble via learned logistic on the small labeled set (CUDA PC, hours).

## 3. One-week foothold

**Ship the owner audio arena on existing taste labels + a CLAP/Audiobox baseline report.**

Concrete build:
1. From the taste log, mine pairs that share source hash / brief / model family but differ seed or params (and agent-run pairs once dual runs exist).
2. Reuse the proven UI-arena pattern: pairwise A/B in the WebView, keyboard verdict, Elo-ish wall.
3. Offline job: score every fingerprinted render with CLAP(brief, audio) + full Audiobox vector; compute rank correlation vs accumulated owner verdicts and vs historical +/−.
4. Emit one artifact the agent can already consume: `taste_proxy` on each generative leaf + “nearest rejected fingerprint” for repair prompts.
5. Gate: freeze this as v0 judge; run 20 agentic tasks twice (with/without proxy in the observe→repair prompt); measure accept rate and ear-disagreement rate.

That starts the flywheel: labels → judge calibration → agent observe signal → better trajectories → more labels. Uses assets you have; no new training required week one.

## 4. Contrarian card

**Optimize trajectories, not sounds.** Everyone else will propose music embeddings as the reward. I’d DPO the *agent command sequences* conditioned on render accept/reject, with audio judges only as auxiliary filters — because Moshi’s failure mode at 82% is mostly *aesthetic decision policy* (which clip, how hard to regenerate, when to stop), not inability to emit valid MIDI. The loop-transcript archive is a preference dataset in disguise; the render ± is the outcome label. A 7B local policy LoRA’d on win/lose trajectories will move the product faster than a prettier FAD number.

Second half of the same card: **formalize the by-ear “bench pass / feels wrong” queue as the *primary* hard-negative set** — not MERT. Those disagreements are exactly the musicality gap command-correctness cannot see. One week of arena on that queue beats three months of embedding tourism.

---

**Ignore the Magenta hunch as a starting move.** Calibrate CLAP + Audiobox to *your* arena this week; DPO trajectories next; grow FMS-Bench only when you need a speech-naturalness axis the owner can’t pairwise fast enough.
