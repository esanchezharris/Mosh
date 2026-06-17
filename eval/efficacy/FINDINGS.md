# Injection redesign — does concrete-recipe rendering + top-1 lift the agent's plan?

**Answer: YES.** Rendering recipe cards as a CONCRETE worked example (real pitches/beats/params,
`$tokens` delabeled) instead of abstract `producer_intent`, retrieved top-1, **lifts plan quality
on both a weak and a strong model**, with golden no-regression held at 100%. This reverses the
Phase D finding ("injected cards give no inference lift") — that null result was because injection
threw away the cards' concrete content.

Pre-registered bar (fixed before the run): LIFT = concrete@k1 − baseline ≥ +10pp AND ≥ intent@k3
(the control config that previously measured −30%); a golden regression FAILs the run.

## Decision sweep — 3 arms × k{1,3}, 8 reps, 5 targeted + 9 golden cases

| targeted arm | weak · gpt-5.4-mini | strong · grok-4.3 |
|---|--:|--:|
| none (baseline) | 60% | 83% |
| intent@k1 | 57% | 88% |
| **concrete@k1 (shipped)** | **90%** | **95%** |
| intent@k3 (control) | 57% | 88% |
| concrete@k3 | 93% | 90% |
| golden no-regression | 99% → 100% ✓ | 99% → 100% ✓ |
| **VERDICT** | **LIFT (+30pp)** | **LIFT (+12pp)** |

Per-case drivers: `ab-swing` 0/8→8/8 (weak), 4/8→8/8 (strong); `ab-trap` 1/8→7/8 (weak);
`ab-send` 6/8→8/8 (strong). One soft spot: `ab-trap` on grok dipped 8/8→6/8 (concrete slightly
distracted a model that already aced the loose ≥3-add_note check) — aggregate still lifts.

Full per-run tables: `report.openai.md`, `report.xai.md`. `report.md` = last run (xai).

## A rendering bug the first sweep caught (VERIFY before relying)

The FIRST sweep (`report.*.v1-buggy.md`) reported weak=LIFT but **strong=REGRESSION (−10pp)**.
Diagnosing grok's actual replies showed the cause was the renderer, not the model: the quantize
worked example said "to a **1/8** grid", and the model faithfully copied `division: "1/8"` — a
**string** into a **number** arg — so `validateCommand` rejected every concrete `ab-swing` reply
(0/8). Fix: render the LITERAL numeric arg (`division 0.5`) with a spelled-out gloss ("an
eighth-note swung grid"), never a fraction that looks like a number. After the fix grok emits
`division: 0.5` and `ab-swing` passes — the strong-model "regression" was an artifact of the bug,
not of concrete rendering. (Other renders — add_note pitches/beats, automation values, send dB —
already emit bare numbers and were unaffected.)

## What shipped

- `ui/src/agent/knowledge/renderRecipe.ts` — pure, snapshot-independent `renderRecipeExample(card)`.
- `ui/src/agent/prompt.ts` — recipe cards inject the worked example by default (`recipeRender:"concrete"`); `intent` mode kept for the eval control arm.
- `ui/src/agent/brain.ts` — product retrieval narrowed to top-1.
- `ui/scripts/evalAB.mts` + `ui/src/agent/evalABVerdict.ts` — the 3-arm × k sweep + pure, unit-tested verdict.

Invariants held: no `$token`/id leak, pure/deterministic prompt (no snapshot or env reads),
`knowHowBlock([])` → byte-identical default prompt, prompt-kind cards still verbatim. Zero C++ change.
