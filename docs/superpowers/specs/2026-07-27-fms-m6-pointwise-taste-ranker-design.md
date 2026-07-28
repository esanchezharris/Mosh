# FMS M6 — pointwise taste ranker (design only; build is its own session)

*2026-07-27. Added by Amendment 1. Spec only — M2's arm has run; implementation
is a separate session.*

## 1. What M2 measured, and why it points here

M2 constrained the terminal word to the phonology-valid pool on the frozen dev
slice (n=146 low-fame, `itemsSha 1b9aad…`). By construction it achieved
`rhyme_fit 1.000`, `syl_fit 1.000`, `constrained_fit 1.000`, `offMenu 0`. It
scored `exact 0.178`.

Measured separately, on the same 150 items, with no model involved:

| quantity | value |
|---|---|
| truth-in-pool coverage (artist's word is IN the legal set) | **40.0%** |
| arm picked correctly | 17.3% |
| ⇒ within-pool ranking precision | **43.3%** |

`0.400 × 0.433 = 0.173`, the observed number. This is the same decomposition
`fusion-rerank` produced on the prompt side (63.3% × 58.9% = 37.3%) — reproduced
at the decoder, which is strong evidence it is a property of the problem rather
than of either implementation.

**Both factors bind, and only one of them is a ranking problem.** A perfect
ranker over today's pool would score 40.0%; a perfect pool with today's ranker
would score 43.3%. M6 attacks the second. It cannot fix the first, and the spec
says so up front so the result is not later read as a failure of the ranker.

### The kill condition, and why it is unreachable as written

Amendment 1's kill condition is `perfect-rhyme ≥90% AND exact ≤37.3%` → route to
fine-tuning. It did not trigger: `rhyme_perfect` came in at 0.616, because the
pool is built at each item's own `rhymeStrictness`, which is usually `slant`.

Reaching ≥90% perfect requires a perfect-only pool — and that was measured too:
**perfect-only coverage is 30.0%**, worse than slant's 40.0%. So the condition
could only ever be satisfied in a configuration whose ceiling is already below
its own exact threshold, making it fire automatically and carry no information.

The informative form of the same question is the decomposition above, and it
answers it: **within-pool semantic ranking is a binding constraint (43.3%)** —
which is the finding the kill condition was designed to detect. It routes here.

## 2. Shape

A **pointwise cross-encoder**: score `(context, candidate)` pairs independently.

- Class: `bge-reranker-v2-m3` or `Qwen3-Reranker-0.6B`.
- Input: the masked bar plus its surrounding lines, and ONE candidate word.
- Output: a scalar. Rank the pool by it.

**Pointwise, and no list in any prompt.** That is not a style preference — it
removes two failure modes by construction rather than by mitigation:

- **Position bias is impossible.** `fusion-rerank` needed a hash-ordered pool
  specifically to stop the model re-picking its own guesses from the top of the
  list. With no list, there is no order to be biased by.
- **Off-menu answers are impossible.** `fusion-rerank` invented a word not on
  offer on 32% of items. A scorer cannot answer with something it was not given.

## 3. Training data — free, and already clean

The ~43k cleaned rhyme items in the dev/train slices.

- **Positive:** the artist's word. Only ever the artist's word.
- **Hard negatives:** the validated rhyming pool-mates from the SAME item — they
  all rhyme, they all scan, and they are wrong. These are the hardest negatives
  obtainable, and the benchmark already produces them for free.

**Label discipline, stated as a rule because it is the tempting shortcut:** never
promote an LLM top-5 word to a positive. The whole point is a signal independent
of the generator; training on the generator's preferences reproduces them and the
measurement becomes circular.

## 4. Validation and the promotion bar

- **Diagnostic:** exact / top-5 on dev, reported per contamination split (M5).
  Diagnostic only — it is the metric the ranker is trained against, so it cannot
  also be the thing that decides.
- **Promotion bar:** agreement **≥0.67** with held-out owner accept/reject labels,
  once those exist. 0.67 is the owner's measured self-consistency, so a ranker at
  that bar matches the rater as well as the rater matches himself. Above it, more
  agreement is not obviously more truth.
- **Blocked on:** the accept-set labels (M5c). The bar cannot be evaluated before
  they exist, and that is a real dependency, not a formality.

## 5. Expected ceiling — pre-registered

With coverage fixed at 40.0%, a ranker at 100% precision scores 40.0% exact. That
is **above** the prompt-side plateau of 37.3–38.4%, but not by much, and the gain
is bounded by a factor the ranker does not touch.

So M6 should be read as answering "is within-pool ranking learnable?", not as a
route past the plateau. If the answer is yes, **coverage becomes the binding
constraint**, and the next lever is the pool — corpus-frequency filtering to strip
the CMUdict junk that M2's raw output is full of (`lyne`, `rhyne`, `rea`, `brack`,
`booz`, `back's` all appeared in real top-5 lists) — not more ranking.

## 6. Out of scope

Fine-tuning the generator; any listwise or generative reranking; anything that
puts candidates in a prompt.
