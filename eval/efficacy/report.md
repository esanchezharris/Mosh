# Efficacy A/B — does injecting retrieved recipe cards lift the agent's plan?

provider `openai/gpt-5.4-mini` · 2 reps/arm · baseline = no cards, lifted = retrieveCards(ask). The "Production moves" teaching is in BOTH arms, so this is the MARGINAL lift of the cards.

◆ = card-targeted ask (a matching recipe card exists). Plain = golden no-regression.

VERDICT · card-targeted asks: baseline 70% → lifted 40% (Δ -30%, 11 retrieved a card) · golden no-regression: 100% → 100%

| case | targeted | cards | baseline | lifted | Δ |
|------|:--:|:--:|:--:|:--:|:--:|
| ab-boombap | ◆ | 3 | 2/2 | 1/2 | -1 |
| ab-swing | ◆ | 3 | 0/2 | 0/2 | 0 |
| ab-send | ◆ | 3 | 2/2 | 1/2 | -1 |
| ab-trap | ◆ | 3 | 1/2 | 0/2 | -1 |
| ab-filter-sweep | ◆ | 3 | 2/2 | 2/2 | 0 |
| create-track |  | 2 | 2/2 | 2/2 | 0 |
| mute-named |  | 1 | 2/2 | 2/2 | 0 |
| play |  | 0 | 2/2 | 2/2 | 0 |
| multi-step |  | 0 | 2/2 | 2/2 | 0 |
| bounce-track |  | 2 | 2/2 | 2/2 | 0 |
| automate-sweep |  | 3 | 2/2 | 2/2 | 0 |
| param-by-name |  | 2 | 2/2 | 2/2 | 0 |
| humanize-feel |  | 3 | 2/2 | 2/2 | 0 |
| no-fake-id |  | 0 | 2/2 | 2/2 | 0 |

_Symbolic plan-quality (did the agent reach for the right commands), not audio quality — that's the deferred layer._
