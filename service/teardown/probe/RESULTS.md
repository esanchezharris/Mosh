# Reward-validity probe — RESULT (2026-06-29)

**Verdict: 🔴 RED — the §12 composite reward does NOT track the owner's musical taste.**
Do not train a policy against it as-is. The §11 keystone validated *relative* ordering
(original > timing-ablation); that did **not** transfer to *absolute* taste validity.

## Method
Owner blind-rated 38 loudness-matched ~10s clips (1–7) + 10 A/B pairs (build `r2-n38`).
All clips on-grid / in-key / clean (timing held structural), so ratings measure taste, not
brokenness. Sources: 12 gold (owner's own beats), 14 auto (real kit + 808 + melodic), 12
degraded (one subtle in-time flaw). Reward components scored separately via the activated
composite head; clip = owner-rated and reward-scored on the identical normalized signal.

## Numbers
Pooled Spearman ρ(owner rating, X): composite **+0.007**, pull **−0.129**, pq −0.057, clean +0.030.
pull dynamic range: spread 0.104, std 0.0227 (≈flat).
A/B agreement with owner: composite 6/10, **pull 3/10** (below chance), pq 6/10.

Per source — owner rating vs reward:
| source | owner rating | pull | composite |
|---|---|---|---|
| gold (owner beats) | 6.92 | 0.527 (lowest) | 0.601 |
| auto | 3.21 | 0.544 | 0.541 |
| deg_mix | 2.00 | 0.539 | 0.586 |
| deg_harmony | 3.25 | 0.544 | 0.611 (highest) |
| deg_arr | 3.50 | 0.547 | 0.599 |

## What it proves
- The owner discriminates taste sharply (gold ≈7 vs degraded ≈2); the reward is flat/slightly
  inverse to it. The learned `pull` (MuQ timbre + timing-φ proximity to 21 exemplars) does NOT
  generalize to ranking real musical quality — it ranks the owner's own beats *lowest*.
- Apples-to-apples among loops: owner rates auto (3.21) > deg_mix (2.00); reward INVERTS it
  (auto composite 0.541 < deg_mix 0.586). So it's not merely "finished song vs sketch loop".

## Caveats (honest)
- gold = finished full tracks vs simple loops → part of the 6.92-vs-2 gap is format, not taste;
  the within-loop inversion is the caveat-proof evidence.
- Owner flagged (note on #035) that the auto beats are hard to judge without the right bass
  (808/synth) → auto ratings carry noise; the gold-vs-degraded and within-loop results don't.
- n=38; but ρ≈0 with huge human separation = a signal problem, not statistical power.

## Implication / next fork
Exemplar-proximity-as-taste, AS BUILT, is not a valid optimization target. The constructive
pivot (owner's call): LEARN a reward that predicts the owner's taste from labels — owner's 1296
beats as positives + degraded/generated negatives + the 38 graded ratings — then re-run THIS probe
to validate ρ before any policy/RL work. The probe is now the reward-validation instrument.
Reproduce: `analyze.py --pack ~/mosh-reward-probe`.
