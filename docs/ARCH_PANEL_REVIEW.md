# Frontier-model architecture review — synthesis (2026-06-30)

We sent a self-contained design brief (goal + the audio-reward→recipe-verifier pivot + GEPA/GRPO/distillation)
to a diverse panel and asked for a critical, no-flattery review. **5/7 responded** (Kimi rejected our temperature
param; GPT-5.5-pro via OpenRouter timed out): **Claude Opus 4.8, GPT-5.4, Grok 4.3, DeepSeek-v4-pro, Gemini-2.5-pro.**
Raw responses: `/private/tmp/claude-501/arch-review/`.

## The verdict was UNANIMOUS — all 5 led with the same critique

> **We replaced a *measurably invalid* reward (audio, ρ≈0 vs owner taste) with an *unvalidated* one (the rule
> verifier), and are about to spend weeks distilling + RL-training against it — without re-running the one
> experiment (the blind listening probe) that already caught this exact mistake.**

Every model said, in its own words: the verifier checks **competence/correctness**, not **taste**. Red-teaming 24
Goodhart exploits only hardens the *floor*; it says nothing about whether `0.99 > 0.90` means "better music to the
owner." GEPA's `0.87→0.99` is **prompt search learning our rubric** (classic Goodhart), not evidence of better music.
GPT-5.4: "you are optimizing a rubric, not taste." Gemini: "a glorified linter for music… it will produce the most
rule-perfect, sterile music imaginable." Opus: "you ran the right experiment once and then stopped running it."

## Consensus recommendations (number = how many of the 5 said it)

1. **Validate the verifier vs owner ratings FIRST (5/5).** Score beats spanning 0.5–1.0, correlate with owner 1–7
   (or pairwise). Cheapest + most decisive experiment. ρ>~0.5 → optimize; ρ≈0 → we're repeating the audio mistake.
2. **Verifier = hard GATE for competence, not the scalar taste objective (5/5).** Separate "validity/anti-slop"
   (rule-shaped) from "appeal" (not). One scalar can't do both → confidently wrong exactly where it matters (ranking
   *good* beats against each other).
3. **Learn taste from owner PAIRWISE preferences (5/5).** A/B in the DAW → a small **Bradley-Terry ranker over
   symbolic features** (you control the engine — extract features, don't embed audio). ~100–500 pairs. This is the
   only thing that can encode the *owner's* taste — a hand-built rule reward by construction encodes the rule-writer's.
4. **Drop GRPO-against-verifier; prefer DPO / rejection-sampling (STaR/RFT) on preferences (5/5).** GRPO is premature
   (unvalidated reward) and fragile (the zero-variance wall we already hit). DPO is more stable on small models and
   uses pairwise data natively. Use the verifier as a rejection-sampling *gate* during data-gen, not the RL objective.
5. **Symbolic-MIDI is the RIGHT primary abstraction (5/5).** Controllable, editable, personalizable, local — the
   correct DAW-agent foundation. Generative audio (SA3) is uncontrollable → never the spine; use it only as a final
   render stage or a preference *feature*, never route reward/gradients through it. *(This validates our core pivot.)*
6. **distill + SFT is essential and correct (5/5); then SHIP it to the owner before any RL (Opus/Grok/DeepSeek).**
7. **Slot-filling is a fine bootstrap but caps the ceiling (5/5).** The harness, not the model, is the composer →
   it can't learn arrangement/structure (the real "taste" moves) and is brittle to the slot ontology. Make it a
   **curriculum stage**: progressively hand structure back (GPT-5.4: `propose_blueprint → instantiate_parts →
   cross_part_revise → arrange → humanize`). Train the eventual policy to emit the whole program.

### Other notable points
- **DeepSeek:** don't over-invest in a 4B — a 7–13B quantized local model follows the command format far more
  reliably; cheaper than the RL engineering we're spending. ("Forever-free" is a self-imposed constraint — price it.)
- **GPT-5.4: the verifier is weak on RELATIONAL/TEMPORAL structure**, which is where "good beat" mostly lives:
  kick–bass interlock, motivic development, phrase (2/4-bar) logic, tension/release into bar 4/8, section intent,
  call-and-response. Add these as features (for the ranker) and/or gate checks.

## What this means for our plan

**Keep (panel-validated):** symbolic-recipe core ✓ · deterministic verifier as a **gate** ✓ · multi-teacher
distill→SFT ✓ · the audio-reward abandonment ✓.

**Change:** stop treating the verifier *score* as the quality objective / success metric. Reframe it as a hard
competence gate + feature extractor. Add relational/temporal features.

**Drop / defer:** GRPO-against-the-verifier (the thing we were about to scale). Replace the RL endpoint with
**DPO / rejection-sampling on owner preferences**, gated by the verifier.

**Add (the missing half):** an owner **pairwise-preference collection** loop in the DAW → a small Bradley-Terry
**taste ranker** over symbolic features, **re-validated against held-out owner judgments every batch.** This is
what actually delivers the personalization goal.

## Revised pipeline

1. **Validate the verifier** vs the owner's existing ratings (score the rated probe beats that have recipes;
   gather a fresh 0.5–1.0 spread if needed). *Decides whether the verifier is a gate-only or has ranking signal.*
2. **Finish SFT-distill (multi-teacher)** → a local model that reliably emits competent beats. **Ship to owner.**
3. **Stand up pairwise preference collection** (A/B in the DAW) → Bradley-Terry ranker over symbolic features.
4. **DPO / rejection-sampling** the local model on owner preferences, verifier as the gate. Re-validate ρ each batch.
5. **Evolve the architecture** from slot-filling → hierarchical plan→parts→revise (remove the training wheels).
