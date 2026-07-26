# I3a — the pivot to the rhyme word, and a benchmark that was 32% junk (2026-07-26)

The owner stopped calibration sitting 4 partway through:

> *"why are we starting with blocking out whole bars instead of individual words?
> … I feel like I'm really shooting in the dark."*

He was right, and the reason is measurable.

## Why line-level judging felt like nothing

At line granularity the deterministic instrument is **pegged**. `exact` is not
even defined for a whole bar — there is no single correct line — and
`constrained_fit` reads **100.0** for the shipped product loop, because it always
hits the syllable target and always rhymes. Nothing can be distinguished, so the
owner *was* the entire measuring apparatus. Three sittings had been spent that
way.

At the rhyme word the same family of metrics has real range and costs nothing:
floor → 28.9 → 47.4 → 100 on `exact`, with `rhyme_perfect` and `multi_depth`
alongside. Sample sizes had been lopsided too — the brackets ran on 2000 items,
the arms that mattered on **37**.

So: a human gate had been built on the granularity with the weakest ground truth,
before extracting the free signal from the one with the strongest.

## The bigger problem, found by reading output

Three new arms went in — a rhyme-aware floor, a prompt arm handed the actual
rhyme menu, and an n-best reranker. The first comparison said the menu arm was
*worse* on `exact`. Spot-checking the disagreements is what saved it:

```
partner='huh'        artist wrote 'motherfucker'
   constrained: 'motherfucker'  MATCH
   menu:        'Maharaja'
partner='a'          artist wrote 'up'
partner='D'          artist wrote 'fiend'
partner='education'  artist wrote 'today'
```

Rhyme partners of `'a'`, `'D'`, `'huh'`. Measured across the whole dev split:
**32.2% of rhyme items had a stopword or sub-3-char token at one end**, and the
most-tested "rhyme words" were *me, yeah, you, it, up*. A third of the benchmark
was asking "can you guess the word 'me'" — function-word completion, not craft.

Worse, those items **invert the ranking**. An arm that obeys a nonsense partner
loses to one that ignores it. The menu arm dutifully rhymed with `'huh'` and got
*'Maharaja'*; the plain arm ignored the constraint and wrote what the artist
wrote. The comparison was measuring obedience to junk.

Fixed at the policy (`POLICY_VERSION` v1 → v2): a rhyme item refuses a function
word at either end. Dev rhyme items 59,333 → 43,006, junk **32.2% → 0.00%**, and
the tested words became *shit, time, back, life, mind, way*. Frozen golden
regenerated as `expected_items_v2.jsonl`; the version rides in every itemId, so
v1 runs can never mix with v2 items. All 17 pre-fix runs were sidelined to
`runs/_policy-v1/`.

## The verdict, on the clean benchmark

| arm | exact | rhyme_perfect | multi_depth |
|---|---|---|---|
| `rhyme-floor` (free) | 10.7% | **93.0%** | **1.14** |
| `llm-constrained` | **37.3%** | 35.7% | 0.84 |
| `prompt-rhyme-menu` | 32.0% | 52.7% | 0.95 |

**A dictionary out-rhymes a language model.** Free phonology lands a perfect
rhyme 93% of the time; the LLM arms manage 36–53%. The LLM's edge is elsewhere —
it knows what the line is *about*, so it finds the artist's actual word 3–3.5×
more often.

Both arms beat the floor on `exact` with separated intervals, and both **fail the
frozen bar** on its `multi_depth` clause. That is recorded as a failure, not
reinterpreted into a pass — though the clause is arguably mis-specified, since
the floor maximizes depth by construction with no regard for meaning. Whether to
re-scope it is an owner decision in the ledger.

## Three ghosts worth remembering

1. **A cache-replayed "fix".** I fixed the floor's ordering, re-ran, got a
   byte-identical result, and honestly reported "changed 0 of 400 picks". Wrong:
   the runner keys results on `(arm, version, itemSha)` and I had not bumped the
   arm version, so the old candidates replayed. At v2 the real effect was large —
   `rhyme_perfect` **15.5% → 94.5%**. `runner_test` now pins every arm's version,
   so a behaviour change without a bump fails the suite.
2. **Three vacuous tests in a row, all mine.** "Hidden pairs leak no artist"
   passed a sabotage that deleted the hiding logic — the fixture had no artist to
   leak. "Perfect rhymes rank first" passed because every frequent word in the
   fixture happened to be a perfect rhyme. "Stanzas of stopwords mint no items"
   passed because the stopwords had no phones. Each needed a fixture that could
   actually exhibit the failure before the check meant anything.
3. **Arms missing from `API_ARMS`** got no chat client (a bare
   `'NoneType' object is not callable`) *and* silently escaped the spend guard.

## Verified

92/92 service py suites green; changed suites 3× byte-identical;
`grep SABOTAGE` clean. Zero C++/UI, so `--selftest` is unchanged by construction.

`nbest-rerank` is the one planned arm still without a number — its run was killed
mid-flight once the benchmark defect surfaced, rather than pay for items about to
be voided.
