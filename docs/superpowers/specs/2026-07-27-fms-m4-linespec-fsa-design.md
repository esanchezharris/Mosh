# FMS M4 — line-level constraint: hard slot, soft line (design only; DO NOT BUILD)

*2026-07-27. Spec only. Built after M2/M3 land and an owner sitting has happened.*
*Revised the same day by Amendment 1, which replaced the original direction.*

## 0. What changed, and why it matters

The first draft of this spec proposed a whole-line FSA: hard per-token masks
enforcing syllable count across the entire bar. **That direction is withdrawn.**

Hard masking every token distorts the output distribution and suppresses exactly
the semantic channel the owner's ear rewards. The program already has the
evidence: `prompt-rhyme-menu` moved `rhyme_perfect` +16.7 points and moved `exact`
*down*, because anchoring the model onto formally-correct rhymes cost meaning. A
full-line mask is that failure mode with a stronger instrument — it would improve
`syl_fit` and plausibly make the bars worse, and the pre-registered rule is that
`syl_fit` rising while keep-rate is flat means the constraint was never the
binding problem.

The replacement is three mechanisms with sharply different force, applied where
each is justified.

## 1. The three mechanisms

**(a) Hard mask at the rhyme slot only.** Exactly M2's built mechanism: at the
terminal-word position the allowed set is the phonology-valid pool, enforced by
the token trie. One slot, fully enumerable, off-menu impossible. Nothing new.

**(b) Soft phonology bias across the rest of the line.** Rather than forbidding
tokens, interpolate the model's logits with a rhyme/register prior
(DeepRapper-style):

```
logits' = logits + λ · prior
```

where `prior` scores tokens by register fit (does this word appear in the corpus's
rap register at all) and by phonological affinity to the bar's rhyme family. `λ`
is a dial, **defeatable**, and `λ = 0` must reproduce the unconstrained arm
byte-for-byte — that equivalence is the first test, not an afterthought. A soft
bias shifts probability without removing options, so the model can still say the
thing it wanted to say.

**(c) Satisfiability check, hard-masking only at the cliff edge.** The line's
syllable budget is enforced *only* when it is about to become unsatisfiable:

```
remaining_budget − min_syllables(any legal ending) ≥ 0
```

While that holds, nothing is masked. When emitting a token would drive it
negative, that token is masked. This is the minimum intervention that guarantees
the bar can still be finished, and it touches a small fraction of positions
instead of all of them.

**Stress contour stays in the external validator.** No decode-time stress
enforcement exists anywhere in the literature or this codebase; inventing one is
out of scope. `_evaluate` and `_analyze_line` already grade stress after the fact,
and that is where it stays.

## 2. Failure modes — enumerated BEFORE any code

Requirement carried over from the first draft. Some are softened by the new
design; that is noted rather than assumed.

**F1 — OOV subword tokens mid-word.** Syllables are a property of a word, but
masking happens per token; mid-word the count is unknown. *Softened:* only (c)
needs this, and only near the cliff edge, so a conservative bound (assume the
in-flight word costs at least one more syllable) is sound and cheap.

**F2 — tokens spanning word boundaries.** A BPE token may be `" it's"` or
`"ing a"`, closing one word and opening the next. Transitions must be defined over
the token's decoded TEXT, split internally — never "one token, one word".

**F3 — syllable-count ambiguity.** CMUdict gives multiple pronunciations
(`fire` = 1 or 2) and `Pronouncer.syllables` takes `prons[0]`, which is a choice,
not a fact. *Materially softened:* (c) only needs the MINIMUM syllables of a legal
ending, and a min over pronunciations is well-defined where a point estimate was
not. Take the min; never gate on an ambiguous point value.

**F4 — dead ends.** The crux of the old design, and the reason it was expensive:
greedy masking can commit to a prefix no legal completion can finish. *This is now
the mechanism rather than a hazard* — (c) IS the reachability check, and it needs
a per-vocabulary-prefix table of `min_syllables(completion)`. **Size that table
against the real Qwen vocabulary before building anything.** If it is not
affordable, M4 is not affordable, and §4.2 is the answer instead.

**F5 — interaction with the tier-1 pool.** At the final slot both constraints
apply: the word must be in the phonology pool AND close the budget. Their
intersection can be EMPTY, which makes the line unsatisfiable. Check it **before**
decoding starts — cheap up front, catastrophic to discover at token 14. When
empty, the honest move is to widen the pool or relax the target, and to say which.

**F6 — the fluency-telemetry trap.** Measured during M2: `generate_step`
renormalizes logprobs *after* processors run, so under a mask the reported logprob
is ≈0.0 and any constrained output looks perfectly fluent. Telemetry must come
from a separate teacher-forced pass under the unconstrained model.

**F7 — cache identity.** Syllable and prior tables derive from the lexicon, and
mask tables derive from the tokenizer AND the quantizer — a quantizer change can
silently shift token ids. Version by `(model, tokenizer, quantizer, lexicon)` and
put it in the generation-cache key, exactly as `poolSha` does for tier-1.

**F8 — λ is a distribution edit, and edits compound.** (b) and (c) both modify
logits. Applied together their interaction is not the sum of their measured
effects. Measure λ alone, satisfiability alone, and both — three arms, not one.

## 3. Pre-registered routing

Consistent with Amendment 1: numeric bars route, they do not define success.

- `λ = 0` must reproduce `local-constrained-endword` byte-for-byte. Not a bar —
  a build gate. If it does not, the interpolation is wrong and nothing downstream
  is readable.
- Soft bias is worth keeping only if `syl_fit` rises **and** accept-set score does
  not fall. `syl_fit` up with accept-set flat is the Goodhart alarm M5 exists to
  raise, and routes to abandoning (b), not to tuning λ.
- Ship/keep still gates on an owner sitting. Always.

## 4. Cheaper alternatives to rule out first

M2 already demonstrated that the expensive mechanism is not automatically the
better one — trie-masked sampling turned out to buy nothing at the rhyme slot
because the masked distribution was degenerate (p=0.9998 on one token).

1. **Best-of-n with the existing validator.** Sample k lines locally (free on
   local weights), keep those that pass `_evaluate`. No new machinery at all.
2. **Terminal-word budget closing.** Tier-1 already picks the last word; filtering
   that pool to counts that CLOSE the line converts a whole-line constraint into a
   one-slot one that is already built. This is F5's check used as the mechanism
   rather than as a guard, and it is the strongest cheap option.
3. **Length-steered prompting.** The measured baseline any of this must beat.

## 5. Prerequisites

- M2 landed and measured, with M5's contamination split and canaries applied.
- M3 landed (the planner supplies the per-line anchor the budget closes around).
- An owner sitting has happened, so keep-rate — not `syl_fit` — decides.
- The F4 prefix table sized against the real vocabulary.
