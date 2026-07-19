# Workshop — the taste evaluation → improvement loop (2026-07-19)

*How this was produced: one brief (Mosh's real eval assets + the honest history of
what went wrong) was put to an 8-model panel — Sonnet 5, Fable 5, Opus 4.8, Kimi
K3, grok-4.5, GPT-5.6-sol, GLM-5.2, MiniMax M3 — each asked for the architecture,
named judge models, a one-week foothold, and a contrarian card. In parallel a
web-grounded research pass verified the July-2026 model landscape with sources.
Raw panel answers: [`workshop-2026-07-19/`](workshop-2026-07-19/). This doc is
the synthesis. Nothing here is built yet — it is the charter for the next pass.*

## The verdict on the hunch ("a Google Magenta thing? a music embedding thing?")

Right in spirit, wrong in letter — and the panel was unanimous about it.

- **Magenta ships no judge.** Magenta RealTime 2 (June 2026, open weights) is
  live *generation*; Lyria/Music AI Sandbox are generation; SynthID is
  watermark detection. Nothing in the Google music line is exposed for
  evaluation. Google's MuLan embeddings were never released.
- **The open MuLan-equivalents exist**: MuQ / MuQ-MuLan (Tencent, weights
  CC-BY-NC), MERT (330M is CC-BY-NC; only v0-public is commercially clean),
  LAION-CLAP `larger_clap_music` (Apache-2.0, runs anywhere). All are
  **features, not judges** — embedding spaces measure typicality/semantics, and
  ISMIR 2025 work shows they entangle genre with confounds. One is explicitly
  engineered to *discard* production quality (MERIT) — the ecosystem's clearest
  "sounds right for this but doesn't work" trap.
- **The actual crack-it-open find: TuneJury** (arXiv 2606.17006). Frozen
  CLAP+MERT embeddings → a 2.8M-param Bradley-Terry head trained on ~17.5k
  human music-preference pairs (incl. Music Arena, the LMArena-for-music).
  Open code + HF weights (CLAP-only variant is Apache-2.0 clean). It is the
  exact shape Mosh needs, pre-built, and a usable warm start.
- **Small-label personalization is proven, twice, independently**: MuQ-Eval
  reports a usable personalized quality judge from **~150 labeled clips**
  (LoRA on a frozen backbone); TuneJury's recipe is the same claim via a tiny
  head. Mosh's accept/reject archive is already in that range and growing.
- The plausible "Google thing" the owner half-remembered: **Gemini Embedding 2**
  (March 2026) natively ingests raw audio — API-only, genre-clusters well,
  never stress-tested for production-quality discrimination. One afternoon of
  experiment, not a foundation.

## Where all eight models agree (treat as settled)

1. **Don't hunt a universal musicality oracle — build a personal one.** A tiny
   probe (logistic / Bradley-Terry MLP) over frozen music embeddings, trained
   on the owner's own accept/reject archive, validated on a held-out
   **temporal** split (taste drifts; random splits leak seed variants).
   Pre-commit a trust bar (AUC ≳ 0.7–0.75); below it a judge stays advisory.
2. **The validation protocol IS the missing piece, not the judge.** Any of
   these models wires up in an afternoon; nobody has ever checked which one
   agrees with *this producer's* ears. That check is cheaper than everything
   else and comes first.
3. **Audiobox-aesthetics is 3/4 unread.** The pipeline computes CE / CU / PC /
   PQ and reads only `pq` as a floor. CE ("content enjoyment") is the closest
   off-the-shelf thing to a taste axis and it is already computed on every
   render. Regress all four against the label archive before buying anything.
   (Also: AESCA — the AudioMOS-2025-winning head — sits on the *same* Audiobox
   features; a near-free accuracy upgrade.)
4. **First improvement mechanism: best-of-N reranking, not training.** Render
   N=4 seeds, PQ-floor filter, probe reranks, owner hears the winner (runner-up
   behind a "show alternate" affordance → every click is a free preference
   pair). Perceived quality improves in week one with zero training risk.
5. **The arena pattern generalizes.** Pairwise verdicts → Elo-ish wall, exactly
   like the Designer Arena. Owner minutes are the scarcest resource — route
   them ONLY to pairs where the automatic judges disagree or are uncertain
   (active learning), ~15–20 pairs/session.
6. **Every "bench passed but felt wrong" moment becomes a bench task.** That is
   how MoshAgentBench un-saturates: the by-ear gate is the bench generator.
7. **Set-level drift needs a different tool than per-render ranking**: FAD (via
   `fadtk`, MERT/CLAP embeddings) answers "did LoRA r5 drift from the owner's
   sound vs r4" — meaningless on one render, right for version gates.

## The five contrarian bets (genuinely diverse — each testable, none exclusive)

| bet | claim | cheapest test |
|---|---|---|
| **Undo-mining** (Sonnet) | Loop-transcript undo/redo/redo-after-render patterns are an order of magnitude denser than explicit labels — build the first reward signal from them, zero new instrumentation | Query the existing transcript lane; count usable implicit pairs |
| **Judge the score, not the speakers** (Fable) | Most agent failures are *decisions* visible in session-state before rendering; a taste model over (state-diff → verdict) prunes bad plans at 1000× lower cost | Label 50 historical state-diffs by memory/arena; probe on snapshot features |
| **The generator is a judge** (Opus) | SA3's own diffusion loss on a candidate (conditioned on the prompt) separates on-manifold from garbage — zero new models, zero labels; plus: the loop's self-repair pairs (pre/post-repair) are free DPO fuel | One script: ELBO-score 50 archived renders, correlate with labels |
| **Causal micro-edit lab** (GPT-5.6-sol) | Mosh's command seam can generate one-variable counterfactuals (timing ±8ms, density ±10%) — blind loudness-matched pairs give a *causal* preference gradient no scraped dataset has | 10 controlled pairs on one project; does the owner's verdict replicate? |
| **Taste is mostly law** (GLM) | ~70% of "felt wrong" is codable theory/rhythm violation (madmom, chordino, LUFS/crest, velocity variance) — grow the deterministic bench for months before spending a GPU-hour on preference training | The 70/30 audit: of the first 30 felt-wrong cases, what fraction has a discoverable rule? |

Two panelists (MiniMax, grok) independently added: **the producer's manual
corrections after agent output are a labeled preference dataset already sitting
in the command archive** — agent-final vs producer-final diffs are (state →
preferred action) pairs, aligned with the owner by construction.

## The empirical questions that settle the design (answer BEFORE building big)

1. **Does anything already predict the labels?** Batch-score the whole render
   archive with CLAP, MERT(v0-public), MuQ, all four Audiobox axes; fit probes;
   report temporal-split AUC per feature family. (~2 days, the single most
   informative artifact — every architecture decision hangs on this table.)
2. **GLM's 70/30 audit** — is "felt wrong" mostly codable law? Changes the
   whole roadmap if yes.
3. **How many implicit labels exist?** Count undo-mined + self-repair +
   correction-diff pairs in the archives. If ≥ several hundred, the data-scarcity
   premise dies and trajectory-DPO becomes viable early.
4. **License posture**: MERT-330M and MuQ weights are CC-BY-NC. Fine for an
   internal eval harness; decide deliberately before anything ships in-product.
   (CLAP + Audiobox + AESCA + TuneJury's CLAP-only variant are clean.)

## The proposed one-week foothold (synthesis)

Day 1–2 — **the correlation table** (question 1 above), plus GLM's felt-wrong
hotkey (⌘⇧F: snapshot + diff + two-word tag into the transcript lane).
Day 3 — **TuneJury warm start**: run its pretrained head on the archive;
compare vs the from-scratch probes; keep whichever wins the AUC table.
Day 4 — **best-of-4 reranker** behind the winning judge (non-blocking,
"show alternate" logs preference pairs).
Day 5 — **disagreement queue**: probe-vs-owner disagreements become (a) arena
pairs for the next session and (b) candidate bench tasks.
Day 6–7 — run one real session; measure accept-rate of reranked vs single-shot
renders; run the 70/30 audit on whatever felt-wrong tags accumulated.

Exit criteria for week 1: the AUC table exists; one judge is promoted or ALL
are demoted (both outcomes are wins — the second kills embedding tourism
early and routes effort to GLM's deterministic lane); the flywheel's first
tooth (labels → judge → rerank → more labels) is turning.

## Explicitly rejected / deferred

- Chasing Magenta/Lyria as evaluators (nothing exposed), hit-song-science
  (persistently weak), commercial mix-score APIs (unstable vendor layer —
  Musiio already absorbed/shut), audio-LLM judges as *primary* signal
  (hallucination-prone on A/B comparisons per 2026 benchmarks — fine as
  critique-text features, never as ground truth).
- End-to-end RL against a learned audio reward (the exact failure mode of the
  first taste-LoRA attempt — nothing here re-opens that door until a judge
  survives its agreement bar for weeks).
