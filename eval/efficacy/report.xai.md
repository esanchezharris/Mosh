# Efficacy A/B — does concrete-recipe rendering + top-1 retrieval lift the agent's plan?

provider `xai/grok-4.3` · 8 reps/cell · arms [none, intent, concrete] × k [1, 3]. none = no cards; intent = legacy producer_intent injection; concrete = worked-example rendering. The "Production moves" teaching is in EVERY arm, so this is the MARGINAL value of the cards.


Targeted asks — pass-rate per arm:
  none           83%
  intent@k1      88%
  concrete@k1    95%
  intent@k3      88%
  concrete@k3    90%
Golden no-regression: none 99% → concrete@k1 100% ✓
VERDICT: LIFT  ·  concrete@k1 95% vs baseline 83% vs intent@k3 88% (control)

## Targeted asks (◆ = a matching recipe card exists)

| case | none | intent@k1 | concrete@k1 | intent@k3 | concrete@k3 | Δ(concrete−none) |
|------|:--:|:--:|:--:|:--:|:--:|:--:|
| ab-boombap | 7/8 | 8/8 | 8/8 | 8/8 | 8/8 | 1 |
| ab-swing | 4/8 | 5/8 | 8/8 | 3/8 | 8/8 | 4 |
| ab-send | 6/8 | 6/8 | 8/8 | 8/8 | 8/8 | 2 |
| ab-trap | 8/8 | 8/8 | 6/8 | 8/8 | 4/8 | -2 |
| ab-filter-sweep | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 | 0 |

## Golden no-regression (cards must not break these)

| case | none | concrete@k1 |
|------|:--:|:--:|
| create-track | 8/8 | 8/8 |
| mute-named | 8/8 | 8/8 |
| play | 8/8 | 8/8 |
| multi-step | 8/8 | 8/8 |
| bounce-track | 8/8 | 8/8 |
| automate-sweep | 8/8 | 8/8 |
| param-by-name | 7/8 | 8/8 |
| humanize-feel | 8/8 | 8/8 |
| no-fake-id | 8/8 | 8/8 |

_Pre-registered bar: LIFT = concrete@k1 − baseline ≥ +10pp AND ≥ intent@k3; a golden drop FAILs the run. Symbolic plan-quality only (did the agent reach for the right commands), not audio quality._
