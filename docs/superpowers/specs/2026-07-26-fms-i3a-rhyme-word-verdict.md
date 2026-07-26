# I3a verdict — rhyme-word arms vs the honest floor

*Bar frozen in `PROGRAM.md` before these numbers were read. Measured on mask
policy **v2** (dev rhyme slice); every earlier arm number is void — see the
benchmark-defect entry in the ledger.*

## The frozen bar

> An arm graduates only if, **on the low-fame bucket**, it beats `rhyme-floor`
> on `exact` with non-overlapping 95% intervals, **and** does not regress
> `multi_depth`.

## Result

| arm | n | exact | topk | rhyme_fit | rhyme_perfect | multi_depth |
|---|---|---|---|---|---|---|
| `rhyme-floor` (free, no API) | 400 | 10.7% | 21.7% | **100%** | **93.0%** | **1.14** |
| `llm-constrained` | 150 | **37.3%** | **48.0%** | 91.4% | 35.7% | 0.84 |
| `prompt-rhyme-menu` | 150 | 32.0% | 40.7% | 97.9% | 52.7% | 0.95 |

| arm | exact vs floor | separated? | multi_depth | **verdict** |
|---|---|---|---|---|
| `llm-constrained` | **+26.6 pts** (CI +18.5…+35.0) | yes | 0.84 vs 1.14 | **FAILS** — depth regression |
| `prompt-rhyme-menu` | **+21.3 pts** (CI +13.5…+29.5) | yes | 0.95 vs 1.14 | **FAILS** — depth regression |

Head-to-head: `exact` +5.3 pts for `llm-constrained` (CI −5.4…+15.9) — **not
separated**. `rhyme_perfect` +16.7 pts for `prompt-rhyme-menu` (CI +5.4…+27.3) —
**separated**. So the rhyme menu buys measurably better *rhyme*, at no
measurable cost to matching the artist. It is not, on this evidence, a win on
`exact`.

## What actually happened

Both arms cleared the `exact` half of the bar decisively — the LLM finds the
artist's real word 3–3.5× more often than free phonology does. Both then failed
on the depth clause, and the reason is worth stating plainly rather than
explaining away:

**The floor is a better formal rhymer than either LLM.** It produces a perfect
rhyme 93% of the time at depth 1.14; the LLM arms manage 36–53% at depth
0.84–0.95. A dictionary lookup out-rhymes a language model, comfortably.

The two are good at different things. The LLM knows what the line is *about*;
phonology knows what *rhymes*. Neither dominates, and nothing in the current arm
set combines them — the rhyme menu was the first attempt and it moved
`rhyme_perfect` +16.7 pts without moving `exact`.

## On the bar itself

I am **not** reinterpreting the bar to make an arm pass. As written, both fail.

But the depth clause is arguably mis-specified, and that should be an explicit
owner decision recorded in the ledger, not a silent edit. The floor optimizes
`multi_depth` *by construction* — it picks the deepest available rhyme with no
regard for whether the line means anything. Requiring a writing arm to match a
dictionary's formal depth may be requiring the wrong thing. The clause was
intended as an **anti-blandness tripwire** (an arm must not buy `exact` by
drifting generic), and against that intent the right comparison is arm-vs-arm
over time, not arm-vs-floor.

Two honest options, owner's call:
1. **Keep the bar.** Then no prompt-side arm has graduated, and the next move is
   an arm that actually combines both strengths (constrain the LLM's choice to
   the phonology menu but let it re-rank by meaning, rather than handing over a
   menu and hoping).
2. **Re-scope the depth clause** to "does not regress vs the previous best
   *arm*", keeping the floor as the `exact` reference only. Then
   `llm-constrained` graduates today and `prompt-rhyme-menu` becomes the
   craft-leaning alternative.

## The question a metric cannot settle

The floor writes formally excellent rhymes and matches the artist 10.7% of the
time. `llm-constrained` matches the artist 37.3% of the time with visibly weaker
rhyme. **Which reads better in the bar?** No automated column can answer that,
and it is precisely the ~15-pair sitting the pivot was meant to earn: items where
the floor and the LLM disagree, rated on the I2c per-fill scale.

That answer decides whether the program optimizes `exact` or craft — which is
the single highest-leverage unknown left in I3a.

## Caveats on these numbers

- The low/high fame split is **387/13** and **146/4** on these draws, so the
  memorization diagnostic has almost no high-fame sample at rhyme granularity
  yet. The low-fame headline is sound; the memorization gap is not yet estimable.
- `nbest-rerank` was **not** measured. Its stage-1 run was killed mid-flight once
  the benchmark defect was found, to avoid paying for items about to be
  invalidated. It remains the one planned arm without a number.
- Arms ran at n=150 (±8 pts), the floor at n=400. Stage-2 confirmation at n=400
  was not reached.
