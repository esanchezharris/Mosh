# FMS lyrics-bench — scoreboard

**UNCALIBRATED** — deterministic columns only; judged metrics are untrusted until the owner blind-calibration round (I2).

## rhyme

**rhyme · low-fame — THE HEADLINE**

| arm | slice | n | exact | topk | syl_fit | rhyme_fit | rhyme_perfect | constrained_fit | multi_depth | empty | run |
|---|---|---|---|---|---|---|---|---|---|---|---|
| fusion-rerank | dev | 146 | 37.0 | 51.4 | 89.0 | 90.1 | 40.1 | 84.2 | 0.81 | 0 | 2026-07-26T20-42-46-fusion-rerank-dev |
| fusion-rerank | dev | 146 | 37.7 | 50.0 | 93.8 | 93.1 | 34.7 | 90.4 | 0.81 | 0 | 2026-07-26T20-51-38-fusion-rerank-dev |
| fusion-rerank | dev | 146 | 37.7 | 50.0 | 93.8 | 93.1 | 34.7 | 90.4 | 0.81 | 0 | 2026-07-28T01-12-39-fusion-rerank-dev |
| llm-constrained | dev | 146 | 38.4 | 48.6 | 85.6 | 91.2 | 35.3 | 82.9 | 0.83 | 0 | 2026-07-26T16-50-11-llm-constrained-dev |
| llm-constrained | dev | 146 | 38.4 | 48.6 | 85.6 | 91.2 | 35.3 | 82.9 | 0.83 | 0 | 2026-07-28T01-12-29-llm-constrained-dev |
| llm-constrained | dev | 146 | 38.4 | 48.6 | 85.6 | 91.2 | 35.3 | 82.9 | 0.83 | 0 | 2026-07-28T01-59-52-llm-constrained-dev |
| llm-constrained | dev | 146 | 38.4 | 48.6 | 85.6 | 91.2 | 35.3 | 82.9 | 0.83 | 0 | 2026-07-28T05-44-39-llm-constrained-dev |
| local-constrained-endword | dev | 5 | 20.0 | 20.0 | 100.0 | 100.0 | 60.0 | 100.0 | 0.80 | 0 | 2026-07-28T00-20-14-local-constrained-endword-dev |
| local-constrained-endword | dev | 146 | 17.8 | 21.2 | 100.0 | 100.0 | 61.6 | 100.0 | 0.95 | 0 | 2026-07-28T00-21-29-local-constrained-endword-dev |
| local-constrained-endword | dev | 146 | 17.8 | 21.2 | 100.0 | 100.0 | 61.6 | 100.0 | 0.95 | 0 | 2026-07-28T01-59-38-local-constrained-endword-dev |
| local-constrained-endword | dev | 146 | 17.8 | 21.2 | 100.0 | 100.0 | 61.6 | 100.0 | 0.95 | 0 | 2026-07-28T02-44-17-local-constrained-endword-dev |
| local-constrained-endword-fp | dev | 146 | 26.0 | 41.1 | 100.0 | 100.0 | 40.4 | 100.0 | 0.84 | 0 | 2026-07-28T02-01-50-local-constrained-endword-fp-dev |
| local-constrained-endword-fp | dev | 146 | 26.0 | 41.1 | 100.0 | 100.0 | 40.4 | 100.0 | 0.84 | 0 | 2026-07-28T02-44-23-local-constrained-endword-fp-dev |
| local-rerank-fp40 | dev | 146 | 30.8 | 52.1 | 92.5 | 95.8 | 51.7 | 89.7 | 0.99 | 0 | 2026-07-28T16-58-57-local-rerank-fp40-dev |
| local-unconstrained | dev | 146 | 18.5 | 18.5 | 73.3 | 55.8 | 24.8 | 48.9 | 0.61 | 11 | 2026-07-28T00-12-23-local-unconstrained-dev |
| prompt-rhyme-menu | dev | 146 | 32.2 | 41.1 | 91.1 | 98.6 | 52.1 | 89.7 | 0.94 | 0 | 2026-07-26T16-51-12-prompt-rhyme-menu-dev |
| prompt-rhyme-menu | dev | 146 | 32.2 | 41.1 | 91.1 | 98.6 | 52.1 | 89.7 | 0.94 | 0 | 2026-07-28T01-12-34-prompt-rhyme-menu-dev |
| prompt-rhyme-menu | dev | 146 | 32.2 | 41.1 | 91.1 | 98.6 | 52.1 | 89.7 | 0.94 | 0 | 2026-07-28T02-20-35-prompt-rhyme-menu-dev |
| prompt-rhyme-menu | dev | 146 | 32.2 | 41.1 | 91.1 | 98.6 | 52.1 | 89.7 | 0.94 | 0 | 2026-07-28T05-44-46-prompt-rhyme-menu-dev |
| prompt-rhyme-menu-fp | dev | 146 | 41.8 | 52.1 | 96.6 | 97.9 | 48.6 | 94.5 | 0.91 | 0 | 2026-07-28T02-22-49-prompt-rhyme-menu-fp-dev |
| prompt-rhyme-menu-fp | dev | 146 | 41.8 | 52.1 | 96.6 | 97.9 | 48.6 | 94.5 | 0.91 | 0 | 2026-07-28T05-44-22-prompt-rhyme-menu-fp-dev |
| prompt-rhyme-menu-fp100 | dev | 146 | 32.9 | 50.0 | 90.4 | 95.8 | 41.7 | 88.4 | 0.92 | 0 | 2026-07-28T02-39-08-prompt-rhyme-menu-fp100-dev |
| prompt-rhyme-menu-fp200 | dev | 146 | 27.4 | 47.3 | 90.4 | 95.0 | 37.9 | 87.7 | 0.90 | 0 | 2026-07-28T02-26-12-prompt-rhyme-menu-fp200-dev |
| prompt-rhyme-menu-fp24 | dev | 146 | 39.7 | 50.0 | 91.8 | 95.8 | 49.0 | 89.0 | 0.94 | 0 | 2026-07-28T02-44-12-prompt-rhyme-menu-fp24-dev |
| rhyme-floor | dev | 387 | 10.9 | 21.7 | 100.0 | 100.0 | 93.0 | 100.0 | 1.14 | 0 | 2026-07-26T16-42-26-rhyme-floor-dev |
| rhyme-floor | dev | 8 | 12.5 | 37.5 | 100.0 | 100.0 | 100.0 | 100.0 | 1.50 | 0 | 2026-07-28T00-45-52-rhyme-floor-dev |
| rhyme-floor | dev | 19 | 21.1 | 36.8 | 100.0 | 100.0 | 94.7 | 100.0 | 1.21 | 0 | 2026-07-28T00-47-18-rhyme-floor-dev |
| rhyme-floor-fp | dev | 146 | 11.6 | 21.9 | 100.0 | 100.0 | 93.8 | 100.0 | 1.12 | 0 | 2026-07-28T02-00-20-rhyme-floor-fp-dev |
| xenc-rerank-fp40 | dev | 146 | 21.9 | 52.1 | 92.5 | 96.4 | 52.9 | 90.4 | 0.99 | 0 | 2026-07-28T17-11-55-xenc-rerank-fp40-dev |
| xenc-rerank-fp40 | dev | 146 | 25.3 | 52.1 | 91.1 | 96.6 | 51.0 | 89.7 | 0.94 | 0 | 2026-07-28T17-44-19-xenc-rerank-fp40-dev |
| xenc-rerank-fp40 | dev | 146 | 27.4 | 52.1 | 92.5 | 95.9 | 48.3 | 90.4 | 0.94 | 0 | 2026-07-28T18-01-01-xenc-rerank-fp40-dev |

**rhyme · high-fame — memorization diagnostic**

| arm | slice | n | exact | topk | syl_fit | rhyme_fit | rhyme_perfect | constrained_fit | multi_depth | empty | run |
|---|---|---|---|---|---|---|---|---|---|---|---|
| fusion-rerank | dev | 4 | 0.0 | 25.0 | 75.0 | 100.0 | 75.0 | 75.0 | 1.00 | 0 | 2026-07-26T20-42-46-fusion-rerank-dev |
| fusion-rerank | dev | 4 | 25.0 | 25.0 | 75.0 | 100.0 | 75.0 | 75.0 | 1.00 | 0 | 2026-07-26T20-51-38-fusion-rerank-dev |
| fusion-rerank | dev | 4 | 25.0 | 25.0 | 75.0 | 100.0 | 75.0 | 75.0 | 1.00 | 0 | 2026-07-28T01-12-39-fusion-rerank-dev |
| llm-constrained | dev | 4 | 0.0 | 25.0 | 75.0 | 100.0 | 50.0 | 75.0 | 1.00 | 0 | 2026-07-26T16-50-11-llm-constrained-dev |
| llm-constrained | dev | 4 | 0.0 | 25.0 | 75.0 | 100.0 | 50.0 | 75.0 | 1.00 | 0 | 2026-07-28T01-12-29-llm-constrained-dev |
| llm-constrained | dev | 4 | 0.0 | 25.0 | 75.0 | 100.0 | 50.0 | 75.0 | 1.00 | 0 | 2026-07-28T01-59-52-llm-constrained-dev |
| llm-constrained | dev | 4 | 0.0 | 25.0 | 75.0 | 100.0 | 50.0 | 75.0 | 1.00 | 0 | 2026-07-28T05-44-39-llm-constrained-dev |
| local-constrained-endword | dev | 4 | 0.0 | 0.0 | 100.0 | 100.0 | 100.0 | 100.0 | 1.25 | 0 | 2026-07-28T00-21-29-local-constrained-endword-dev |
| local-constrained-endword | dev | 4 | 0.0 | 0.0 | 100.0 | 100.0 | 100.0 | 100.0 | 1.25 | 0 | 2026-07-28T01-59-38-local-constrained-endword-dev |
| local-constrained-endword | dev | 4 | 0.0 | 0.0 | 100.0 | 100.0 | 100.0 | 100.0 | 1.25 | 0 | 2026-07-28T02-44-17-local-constrained-endword-dev |
| local-constrained-endword-fp | dev | 4 | 0.0 | 25.0 | 100.0 | 100.0 | 50.0 | 100.0 | 0.50 | 0 | 2026-07-28T02-01-50-local-constrained-endword-fp-dev |
| local-constrained-endword-fp | dev | 4 | 0.0 | 25.0 | 100.0 | 100.0 | 50.0 | 100.0 | 0.50 | 0 | 2026-07-28T02-44-23-local-constrained-endword-fp-dev |
| local-rerank-fp40 | dev | 4 | 0.0 | 25.0 | 75.0 | 100.0 | 100.0 | 75.0 | 1.25 | 0 | 2026-07-28T16-58-57-local-rerank-fp40-dev |
| local-unconstrained | dev | 4 | 0.0 | 0.0 | 75.0 | 33.3 | 0.0 | 25.0 | 0.00 | 11 | 2026-07-28T00-12-23-local-unconstrained-dev |
| prompt-rhyme-menu | dev | 4 | 25.0 | 25.0 | 75.0 | 75.0 | 75.0 | 50.0 | 1.50 | 0 | 2026-07-26T16-51-12-prompt-rhyme-menu-dev |
| prompt-rhyme-menu | dev | 4 | 25.0 | 25.0 | 75.0 | 75.0 | 75.0 | 50.0 | 1.50 | 0 | 2026-07-28T01-12-34-prompt-rhyme-menu-dev |
| prompt-rhyme-menu | dev | 4 | 25.0 | 25.0 | 75.0 | 75.0 | 75.0 | 50.0 | 1.50 | 0 | 2026-07-28T02-20-35-prompt-rhyme-menu-dev |
| prompt-rhyme-menu | dev | 4 | 25.0 | 25.0 | 75.0 | 75.0 | 75.0 | 50.0 | 1.50 | 0 | 2026-07-28T05-44-46-prompt-rhyme-menu-dev |
| prompt-rhyme-menu-fp | dev | 4 | 25.0 | 25.0 | 75.0 | 75.0 | 75.0 | 75.0 | 1.50 | 0 | 2026-07-28T02-22-49-prompt-rhyme-menu-fp-dev |
| prompt-rhyme-menu-fp | dev | 4 | 25.0 | 25.0 | 75.0 | 75.0 | 75.0 | 75.0 | 1.50 | 0 | 2026-07-28T05-44-22-prompt-rhyme-menu-fp-dev |
| prompt-rhyme-menu-fp100 | dev | 4 | 0.0 | 25.0 | 100.0 | 66.7 | 66.7 | 75.0 | 0.67 | 0 | 2026-07-28T02-39-08-prompt-rhyme-menu-fp100-dev |
| prompt-rhyme-menu-fp200 | dev | 4 | 0.0 | 50.0 | 75.0 | 100.0 | 75.0 | 75.0 | 1.00 | 0 | 2026-07-28T02-26-12-prompt-rhyme-menu-fp200-dev |
| prompt-rhyme-menu-fp24 | dev | 4 | 0.0 | 25.0 | 75.0 | 75.0 | 75.0 | 50.0 | 1.50 | 0 | 2026-07-28T02-44-12-prompt-rhyme-menu-fp24-dev |
| rhyme-floor | dev | 13 | 7.7 | 23.1 | 100.0 | 100.0 | 92.3 | 100.0 | 1.15 | 0 | 2026-07-26T16-42-26-rhyme-floor-dev |
| rhyme-floor | dev | 1 | 0.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 1.00 | 0 | 2026-07-28T00-47-18-rhyme-floor-dev |
| rhyme-floor-fp | dev | 4 | 0.0 | 50.0 | 100.0 | 100.0 | 100.0 | 100.0 | 1.25 | 0 | 2026-07-28T02-00-20-rhyme-floor-fp-dev |
| xenc-rerank-fp40 | dev | 4 | 0.0 | 25.0 | 75.0 | 100.0 | 100.0 | 75.0 | 1.25 | 0 | 2026-07-28T17-11-55-xenc-rerank-fp40-dev |
| xenc-rerank-fp40 | dev | 4 | 0.0 | 25.0 | 75.0 | 100.0 | 100.0 | 75.0 | 1.25 | 0 | 2026-07-28T17-44-19-xenc-rerank-fp40-dev |
| xenc-rerank-fp40 | dev | 4 | 0.0 | 25.0 | 75.0 | 100.0 | 100.0 | 75.0 | 1.25 | 0 | 2026-07-28T18-01-01-xenc-rerank-fp40-dev |

*A gain visible only in the high-fame block is memorization, not writing — compare the two `exact` columns before believing an arm.*

**all items (pooled)**

| arm | slice | n | exact | topk | syl_fit | rhyme_fit | rhyme_perfect | constrained_fit | multi_depth | empty | run |
|---|---|---|---|---|---|---|---|---|---|---|---|
| fusion-rerank | dev | 150 | 36.0 | 50.7 | 88.7 | 90.4 | 41.1 | 84.0 | 0.82 | 0 | 2026-07-26T20-42-46-fusion-rerank-dev |
| fusion-rerank | dev | 150 | 37.3 | 49.3 | 93.3 | 93.2 | 35.8 | 90.0 | 0.81 | 0 | 2026-07-26T20-51-38-fusion-rerank-dev |
| fusion-rerank | dev | 150 | 37.3 | 49.3 | 93.3 | 93.2 | 35.8 | 90.0 | 0.81 | 0 | 2026-07-28T01-12-39-fusion-rerank-dev |
| llm-constrained | dev | 150 | 37.3 | 48.0 | 85.3 | 91.4 | 35.7 | 82.7 | 0.84 | 0 | 2026-07-26T16-50-11-llm-constrained-dev |
| llm-constrained | dev | 150 | 37.3 | 48.0 | 85.3 | 91.4 | 35.7 | 82.7 | 0.84 | 0 | 2026-07-28T01-12-29-llm-constrained-dev |
| llm-constrained | dev | 150 | 37.3 | 48.0 | 85.3 | 91.4 | 35.7 | 82.7 | 0.84 | 0 | 2026-07-28T01-59-52-llm-constrained-dev |
| llm-constrained | dev | 150 | 37.3 | 48.0 | 85.3 | 91.4 | 35.7 | 82.7 | 0.84 | 0 | 2026-07-28T05-44-39-llm-constrained-dev |
| local-constrained-endword | dev | 5 | 20.0 | 20.0 | 100.0 | 100.0 | 60.0 | 100.0 | 0.80 | 0 | 2026-07-28T00-20-14-local-constrained-endword-dev |
| local-constrained-endword | dev | 150 | 17.3 | 20.7 | 100.0 | 100.0 | 62.7 | 100.0 | 0.96 | 0 | 2026-07-28T00-21-29-local-constrained-endword-dev |
| local-constrained-endword | dev | 150 | 17.3 | 20.7 | 100.0 | 100.0 | 62.7 | 100.0 | 0.96 | 0 | 2026-07-28T01-59-38-local-constrained-endword-dev |
| local-constrained-endword | dev | 150 | 17.3 | 20.7 | 100.0 | 100.0 | 62.7 | 100.0 | 0.96 | 0 | 2026-07-28T02-44-17-local-constrained-endword-dev |
| local-constrained-endword-fp | dev | 150 | 25.3 | 40.7 | 100.0 | 100.0 | 40.7 | 100.0 | 0.83 | 0 | 2026-07-28T02-01-50-local-constrained-endword-fp-dev |
| local-constrained-endword-fp | dev | 150 | 25.3 | 40.7 | 100.0 | 100.0 | 40.7 | 100.0 | 0.83 | 0 | 2026-07-28T02-44-23-local-constrained-endword-fp-dev |
| local-rerank-fp40 | dev | 150 | 30.0 | 51.3 | 92.0 | 95.9 | 53.1 | 89.3 | 1.00 | 0 | 2026-07-28T16-58-57-local-rerank-fp40-dev |
| local-unconstrained | dev | 150 | 18.0 | 18.0 | 73.4 | 55.2 | 24.1 | 48.2 | 0.59 | 11 | 2026-07-28T00-12-23-local-unconstrained-dev |
| prompt-rhyme-menu | dev | 150 | 32.0 | 40.7 | 90.7 | 97.9 | 52.7 | 88.7 | 0.95 | 0 | 2026-07-26T16-51-12-prompt-rhyme-menu-dev |
| prompt-rhyme-menu | dev | 150 | 32.0 | 40.7 | 90.7 | 97.9 | 52.7 | 88.7 | 0.95 | 0 | 2026-07-28T01-12-34-prompt-rhyme-menu-dev |
| prompt-rhyme-menu | dev | 150 | 32.0 | 40.7 | 90.7 | 97.9 | 52.7 | 88.7 | 0.95 | 0 | 2026-07-28T02-20-35-prompt-rhyme-menu-dev |
| prompt-rhyme-menu | dev | 150 | 32.0 | 40.7 | 90.7 | 97.9 | 52.7 | 88.7 | 0.95 | 0 | 2026-07-28T05-44-46-prompt-rhyme-menu-dev |
| prompt-rhyme-menu-fp | dev | 150 | 41.3 | 51.3 | 96.0 | 97.3 | 49.3 | 94.0 | 0.93 | 0 | 2026-07-28T02-22-49-prompt-rhyme-menu-fp-dev |
| prompt-rhyme-menu-fp | dev | 150 | 41.3 | 51.3 | 96.0 | 97.3 | 49.3 | 94.0 | 0.93 | 0 | 2026-07-28T05-44-22-prompt-rhyme-menu-fp-dev |
| prompt-rhyme-menu-fp100 | dev | 150 | 32.0 | 49.3 | 90.7 | 95.2 | 42.2 | 88.0 | 0.92 | 0 | 2026-07-28T02-39-08-prompt-rhyme-menu-fp100-dev |
| prompt-rhyme-menu-fp200 | dev | 150 | 26.7 | 47.3 | 90.0 | 95.1 | 38.9 | 87.3 | 0.90 | 0 | 2026-07-28T02-26-12-prompt-rhyme-menu-fp200-dev |
| prompt-rhyme-menu-fp24 | dev | 150 | 38.7 | 49.3 | 91.3 | 95.2 | 49.7 | 88.0 | 0.95 | 0 | 2026-07-28T02-44-12-prompt-rhyme-menu-fp24-dev |
| rhyme-floor | dev | 400 | 10.8 | 21.8 | 100.0 | 100.0 | 93.0 | 100.0 | 1.14 | 0 | 2026-07-26T16-42-26-rhyme-floor-dev |
| rhyme-floor | dev | 8 | 12.5 | 37.5 | 100.0 | 100.0 | 100.0 | 100.0 | 1.50 | 0 | 2026-07-28T00-45-52-rhyme-floor-dev |
| rhyme-floor | dev | 20 | 20.0 | 40.0 | 100.0 | 100.0 | 95.0 | 100.0 | 1.20 | 0 | 2026-07-28T00-47-18-rhyme-floor-dev |
| rhyme-floor-fp | dev | 150 | 11.3 | 22.7 | 100.0 | 100.0 | 94.0 | 100.0 | 1.12 | 0 | 2026-07-28T02-00-20-rhyme-floor-fp-dev |
| xenc-rerank-fp40 | dev | 150 | 21.3 | 51.3 | 92.0 | 96.5 | 54.2 | 90.0 | 0.99 | 0 | 2026-07-28T17-11-55-xenc-rerank-fp40-dev |
| xenc-rerank-fp40 | dev | 150 | 24.7 | 51.3 | 90.7 | 96.6 | 52.3 | 89.3 | 0.95 | 0 | 2026-07-28T17-44-19-xenc-rerank-fp40-dev |
| xenc-rerank-fp40 | dev | 150 | 26.7 | 51.3 | 92.0 | 96.0 | 49.7 | 90.0 | 0.95 | 0 | 2026-07-28T18-01-01-xenc-rerank-fp40-dev |

*Values are percentages of items, except `multi_depth`, which is a mean rhyme depth in syllables — an arm that raises `exact` while dropping `multi_depth` is drifting toward generic. Regenerated by `bench_cli.py scoreboard` — do not hand-edit.*
