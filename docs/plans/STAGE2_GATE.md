# Stage-2 gate — learned proposer (DPO on owner labels), pre-registered

*Committed era-0 (2026-07-02), BEFORE the label campaign can satisfy it. This
is the audit-prescribed door (docs/plans/moshi-training-audit-2026-07.md
Stage 2: "DPO on owner labels only if conditions met"). GRPO stays frozen
regardless of this gate's outcome (PR #176 — never merge, never run). The
decision, whenever it happens, is recorded in `docs/bench/STAGE2_DECISION.md`.*

## Why a gate

The owner's breakthrough ask includes "beats that surprise me — beyond
recombining the library." The honest path to a learned proposer runs through
evidence, not enthusiasm: prior fine-tunes DEGRADED the base model
(scaffolding > weights, Stage-0 verdict), and a DPO implicit reward trained on
labels a 30-parameter logistic can't extract signal from is unjustified by
construction.

## Conditions — ALL must hold before the pilot may even run

1. **Labels:** ≥ **300** pack keep/kill rows in the ledger
   (70 at era-0; ~16 more rated packs — mid/late campaign), plus ≥ 60 pairwise
   rows if the bonus round shipped.
2. **Ranker validity:** the taste ranker at **rung ≥ 1**
   (docs/bench/RANKER_PROMOTION.md) — prequential ≥ 0.65 sustained for an era.
3. **Rights:** the training corpus is owner-owned material + rated-pack
   renders ONLY. `~/mosh-taste/refs/` (other artists) is embed-only, never
   training data.
4. **Budget:** the pilot plan fits the remaining cloud ceiling; at most one
   ~$20 cloud run (local MLX SFT/DPO is $0).

## The decision experiment — blind A/B vs the recombination baseline

- **3 consecutive A/B packs.** Each: 7 slots learned-proposer, 7 slots
  frozen-era recombination, identical gates/FX/diversity caps, shuffled order.
  The page shows NO provenance; the arm is recorded only in `pack_meta.json`
  (which the owner does not open).
- The owner rates normally (verdict + idea/mix + chips + top pick) — zero
  extra time cost.
- **Pre-registered success — ALL of:**
  - learned-arm keeps ≥ baseline keeps + 4 (pooled over the 3 packs), OR the
    top pick lands in the learned arm in ≥ 2 of 3 packs;
  - the mix aux-verdict in the learned arm is not worse than baseline;
  - ≥ 1 learned keep whose owner note reads as genuinely new/surprising
    (recorded verbatim in the decision doc — the breakthrough criterion).
- **Outcomes:** adopt-as-a-lane · iterate once (one revision, one more 3-pack
  A/B) · freeze. Failure keeps the recombination factory primary; the learned
  proposer never gains composition power without this artifact.

## Notes

- Method if triggered: DPO (or equivalent preference optimization) on the
  owner's keep/kill + pairwise labels over the recipe-JSON representation,
  served locally (MLX). NOT GRPO; no external reward models as judges
  (Audiobox/CLAP/MuQ remain cleanliness filters and features).
- This gate is also the owner's "I hope I won't have to rate forever" exit
  ramp: rung-2 vetoes shrink what reaches his ears, and a passing proposer
  raises what deserves them.
