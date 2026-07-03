# Taste-ranker promotion ladder — pre-registered (era-0, 2026-07-02)

*Committed BEFORE pack-006 ships, so no bar can be moved after seeing results.
The adoption metric is the **prequential AUC**: `predictedKeep` values are
stamped into `pack.json` before the owner hears anything, then scored against
his verdicts (`taste_ranker.py --report`). Immune to retrospective refit by
construction. Standing rule: models are filters/rankers, never unchecked
judges; the ranker NEVER kills — hard gates are untouched at every rung.*

## Rungs

| rung | power | promotion bar (pre-registered) | measurement on promotion |
|---|---|---|---|
| **0 — advisory** (current) | `ranker N%` badge on cards; zero composition power | — | prequential AUC reported per pack |
| **1 — pre-rank compose** | orders gate-passing candidates before the diversity caps; seating draws from the ranked order | prequential mean **≥ 0.65** over the most recent completed era (≥ 3 scored packs), **no pack < 0.50** | the first post-promotion pack is a **blind interleaved A/B**: 7 ranker-composed + 7 legacy-composed slots, shuffled, provenance only in `pack_meta.json`; keep-rate delta reported before rung-1 continues (never ship an unmeasured A/B) |
| **2 — veto-with-override** | may drop the bottom-k gate-passers from *seating* (gates untouched); every veto logged in the pack's candidates ledger | rung 1 held for **2 consecutive eras** with prequential **≥ 0.70** and calibration slope ∈ **[0.7, 1.3]** | 1–2 blind **veto-probe slots** per pack (a vetoed candidate deliberately seated, unlabeled); vetoes stay valid only while probe keep-rate < half the pack keep-rate |

## Demotion (pre-registered)

Any completed era with prequential mean **< 0.55** → drop one rung immediately.
Rung changes are recorded in the era's boundary report
(`docs/bench/ERA_REPORTS/`) with the numbers that triggered them.

## Feature-set changes

Feature additions (e.g. the corpus-similarity block) ship only if LOPO does
not degrade vs the prior feature set (ablation recorded in
`taste_ranker.json` → `lopo.ablation`). Retraining happens ONLY at era
boundaries — `make_pack.py` refuses to build if the model file changed
mid-era.

## Current status (era-0 close)

- n = 68 labeled beats with embeddings (5 packs, shifting pipeline).
- LOPO mean 0.554 (corpus features on: v1 0.545 → v2 0.554). **Rung 0.**
- Pack-005 prequential: 0.5714 (Brier 0.229) — the first stamped-prediction pack.
- Era-1 (packs 006–009, frozen pipeline) is the first era whose labels are
  drawn from ONE distribution — the first honest shot at the 0.65 bar.
