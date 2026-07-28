# FMS M4 — tier-2 LineSpec FSA (design only; DO NOT BUILD)

*2026-07-27. Spec only. Built after M2/M3 land and an owner sitting has happened.*

## 1. What it would enforce

Tier-1 (M2) constrains **one slot**: the bar's terminal word must come from a
phonology-valid set. Tier-2 constrains **the whole line**: the bar must land on its
`syllableTarget ± syllableTol`, and optionally match a stress contour — enforced
inside the decoder as a state machine over logits, not checked afterwards.

Today syllable fit is a *validator* (`core._evaluate` → re-prompt, 3 attempts).
`llm-constrained` hits `syl_fit` 85.6% on the dev slice, so roughly one bar in
seven either burns retries or ships off-target.

## 2. Why this is a different problem from tier-1, not a bigger one

Tier-1 works because the allowed set is a **finite, enumerable list of words**. A
trie over their token sequences is exact, and the mask at each step is just the
children of the current node. Building it taught the shape of the real difficulty:

- the model's `tokens` argument is not the generated history, so state must
  advance on `tokens[-1]` (M2 handles this);
- a word is reachable if ANY of its tokenizations is, so variants must be expanded
  (M2 handles this).

Tier-2 has no enumerable set. The state is `(syllables committed, partial word in
flight)` over an open vocabulary, and the legal continuations at each step are
"every token that keeps some completion within budget" — which is not a lookup.

## 3. Proposed shape

A logits processor holding:

```
state = (syllables_committed, pending_grapheme_buffer, words_committed)
```

Per step: decode the candidate token's text, decide whether it *closes* a word
(leading space / punctuation / EOS), and if so score the completed word's
syllables via Bar-IQ's layered `Pronouncer` (user lexicon → CMUdict → g2p →
heuristic). Mask any token whose resulting state cannot reach the target.

## 4. Failure modes — enumerated BEFORE any code

These are the reasons this is spec-only. Each needs an answer that is not
"probably fine".

**F1 — OOV subword tokens mid-word.** Syllables are a property of a *word*, but
masking happens per *token*. Mid-word the count is unknown, so the processor can
only bound it. Needs a min/max-syllables-reachable interval per trie/vocabulary
prefix, not a point estimate.

**F2 — tokens spanning word boundaries.** A BPE token may be `" it's"` or `"ing a"`
— closing one word and opening the next in a single step. A state machine that
assumes "one token advances at most one word" will miscount. The transition must
be defined over the token's *decoded text*, splitting internally.

**F3 — syllable-count ambiguity.** CMUdict gives multiple pronunciations
(`fire` = 1 or 2). `Pronouncer.syllables` takes `prons[0]`, which is a *choice*,
not a fact. A hard gate on an ambiguous count will reject bars a human scans as
correct. Options: carry an interval `[min, max]` per word, or gate on the interval
overlapping the target. Deciding this needs the owner's ear, not a rule.

**F4 — dead ends.** The crux. Greedy masking can commit to a partial word that
cannot be completed within budget — e.g. 2 syllables left and the prefix `un-` in
flight, where every completion is ≥3. The decoder then has *no* legal token, and
the run either backtracks (which `generate_step` cannot do) or emits garbage.
Avoiding it requires reachability lookahead: for every vocabulary prefix, the
min/max syllables of any completion, precomputed once per tokenizer. That table is
the real cost of tier-2 and should be sized before anything is built.

**F5 — interaction with the tier-1 end-word trie.** At the final slot both
constraints apply: the terminal word must be in the phonology pool AND land the
line's total. These intersect — the pool must be filtered to words whose syllable
count closes the budget exactly. If that intersection is empty the line is
*unsatisfiable*, and the processor must detect it **before** decoding starts, not
mid-bar. Cheap to check up front; catastrophic to discover at token 14.

**F6 — the fluency telemetry trap.** Measured in M2: `generate_step` renormalizes
logprobs *after* the processors run, so under a mask the reported logprob is ≈0.0.
Any tier-2 fluency number must come from a separate teacher-forced pass under the
unconstrained model. Stated here because it will otherwise be re-discovered.

**F7 — cache identity.** A syllable table is derived from the lexicon; a lexicon
change silently changes what is legal. `fsaVersion` + a lexicon hash must join the
generation-cache key, exactly as `poolSha` does for tier-1.

## 5. Cheaper alternatives to weigh first

Tier-2 should not be built until these are ruled out, because M2 already showed
the expensive mechanism is not automatically the better one:

1. **Best-of-n with the validator** — sample k lines locally (free), keep those
   that pass `_evaluate`. No new machinery. Local inference makes n cheap in a way
   API arms never made it.
2. **Terminal-word-only budget closing** — tier-1 already picks the last word.
   Filtering that pool to counts that *close* the line converts a whole-line
   constraint into a one-slot one, which is already built (F5's check, used as the
   mechanism rather than as a guard).
3. **Length-steered prompting** — cheapest, already partly present, and the
   measured baseline any FSA must beat.

**Pre-registered:** tier-2 is justified only if `syl_fit` under (1) and (2) is
still materially short of the target AND the owner's keep-rate is the thing
limited by it. `syl_fit` rising while keep-rate is flat means the constraint was
never the binding problem — the same trap `prompt-rhyme-menu` fell into when it
moved `rhyme_perfect` +16.7 points and moved `exact` down.

## 6. Prerequisites

- M2 landed and measured on the dev slice.
- M3 landed (the planner supplies the per-line anchor tier-2 must close around).
- An owner sitting has happened, so keep-rate — not `syl_fit` — decides whether
  this is worth building.
- The F4 reachability table sized against the real Qwen vocabulary. If it is not
  affordable, tier-2 is not affordable, and §5.2 is the answer instead.
