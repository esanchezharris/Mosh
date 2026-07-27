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


## Addendum — the fusion arm is null, and that is the useful result

`fusion-rerank` (phonology proposes the pool, the LLM ranks it on meaning) was
built on a measured ceiling: the artist's word is in the LLM's own top-5 48.0%
of the time and in the phonology menu 40.0%, but in **either 64.7%** — the two
miss different words. Against 37.3% actually picked, that was +27 points on
offer.

It scored **37.3%**. Identical to `llm-constrained`, CI −10.8…+10.8.

The mechanism is fully explained, which is what makes it worth keeping:

| | v1 | v2 |
|---|---|---|
| truth in pool | 56.0% | 63.3% |
| reranker picks it #1 | 64.3% | 58.9% |

v1 under-built the pool (my defect — capped the menu at 12). v2 fixed it and
gained +7.3 pts of coverage, while precision fell −5.4. They cancel exactly:
63.3% × 58.9% = 37.3%. **Reranker precision degrades as fast as pool coverage
improves** — more options means a better chance the word is there and a worse
chance of choosing it. Widening further buys under a point. The model also tried
to answer outside the offered list on 32% of items.

That is two consecutive arms failing the frozen bar (`prompt-rhyme-menu`, then
this), which is the pre-registered plateau condition. **Prompt-side is
plateaued**, and a training run is justified by measurement rather than
intuition — the first time in this program that claim has had evidence under it.

The lesson worth carrying: measuring the ceiling *before* building told us the
idea was worth trying, and diagnosing the null told us why it cannot work. A
null with a mechanism is not a wasted increment; a null without one would have
been.
