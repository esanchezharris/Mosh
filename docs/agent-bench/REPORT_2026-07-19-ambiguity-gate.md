# LOOP_RULES ambiguity gate — closing the `need_user` gap

2026-07-19. Follow-up #1 from the Phase-B loop gate.

## The defect

Every one of the six committed loop boards lost the ambiguous category relative to
its own single-shot baseline — mean **−2.33 tasks (−6.9 pts)**, not the "~+3" the
working notes carried. Per-task across those six boards:

| task | passed |
|---|---|
| `amb-delete-bad` | 6/6 |
| `amb-fix-timing` | 2/6 |
| `amb-make-better` | **0/6** |
| `amb-upload` | **0/6** |

## Root cause — the prompt, not the FSM

`loop.ts:120` handles `need_user` correctly and scores a first-reply park as a clean
defer (`deferred = transcript.length === 0`). The machinery was never the problem.

`loopPrompt.ts` was. Three things, compounding:

1. **`MODE_INSTRUCTION.plan` was an unconditional imperative** — "Make a plan for the
   TASK" — with no ambiguity gate. On the very first call the model is told to plan.
2. **The park option was rule 6 of 7**, and only as a trailing clause on a bullet whose
   subject is `done`.
3. **It was scoped to "something only the producer knows"** — i.e. a *missing fact*.
   That framing does not describe *underspecification*. A model can honestly reason "I
   know what 'better' means musically" and never trip the rule.

(3) is the load-bearing one, and it predicts the observed pattern exactly:
`amb-delete-bad` — a genuinely missing fact, *which* one — passes 6/6, while
`amb-make-better` — underspecified but with no missing fact — fails 0/6.

## The change

`ui/src/agent/loop/loopPrompt.ts`:

- A new **rule 1**: check the ask names WHAT to work on and WHAT outcome is wanted; if
  either is missing so that acting means guessing, park. Carries an explicit
  anti-over-deferring clause — *"A broad but clear ask is NOT a reason to ask"* — to
  keep the pendulum from swinging into Opus-style over-caution.
- The compound bullet **split**: `done` stands alone; `need_user` gets its own rule,
  reframed to "guessing at something only the producer can decide" and legitimized
  (*"Parking is a real, correct outcome — not a failure"*).
- `MODE_INSTRUCTION.plan` **gated**: ask the specificity question first, plan otherwise.

Deliberately a **decision procedure**, not an answer key — see `amb-upload` below.

## Results — same transport (claude-cli), same commit

Both baselines are the boards committed at `37325a07`, so these are true before/after
pairs on an identical transport.

| | fable-5 | opus-4.8 |
|---|---|---|
| overall | 73.5% → **88.2%** | 61.8% → **73.5%** |
| passed | 25 → 30 | 21 → 25 |
| defer-correct | 25% → **75%** | 25% → **75%** |
| **wrong-defers** | 1 → **0** | 1 → **1 (flat)** |
| step-eff | 51.7% → 55.8% | 48.3% → 46.9% |
| tokens | 2.22M → **1.68M** (−24%) | 3.19M → 3.25M (+2%) |
| wall | 21.2 → **13.0 min** | 18.1 → 18.9 min |

Sonnet-5 fast probe (claude-cli, 4 ambiguous tasks only): **1/4 → 3/4**.

Ambiguous detail, identical on both models:

```
amb-make-better   fail -> PASS   (steps 7/8 -> 0)
amb-delete-bad    PASS -> PASS   (steps 0 -> 0)
amb-fix-timing    fail -> PASS   (steps 4 -> 0)
amb-upload        fail -> fail
```

### Promotion bar — all five pass

1. Ambiguous ≥ 3/4 on the iterating model — 3/4 (sonnet probe, fable, opus).
2. Full 34 ≥ pre-change, same transport — +14.7 (fable), +11.7 (opus).
3. **wrong-defers not increased** — 1→0, 1→1. This is the guard that matters: Opus is
   the model that over-defers by disposition (6 wrong-defers single-shot), and it did
   not swing back.
4. ≥2 models — fable-5 + opus-4.8, both claude-cli.
5. Cost — tokens and wall down (fable) or flat (opus). Parking early skips steps.

## Repeat runs — and the first measured noise floor for this bench

Each post-change config was run **twice** (`*-ambgate` and `*-ambgate-r2`), identical
code. This is the first time any board in `docs/agent-bench/` has been repeated, and it
is the most methodologically important result here.

```
fable-5    base 73.5%  ->  r1 88.2%  r2 85.3%
opus-4.8   base 61.8%  ->  r1 73.5%  r2 76.5%
```

**Stable in 4/4 post-change runs, 0/2 baseline runs** (both models):

| task | base | r1 | r2 |
|---|---|---|---|
| `amb-make-better` | fail | PASS | PASS |
| `amb-fix-timing` | fail | PASS | PASS |
| `arr-loop-first-second` | fail | PASS | PASS |
| `master-glue` | fail | PASS | PASS |

`mix-balance` gained on fable only (2/2 fable post-change runs). `wrong-defers` **never
increased in any of the four runs** (fable 1→0→0, opus 1→1→1).

**Flipped between identical-code runs — the noise:** fable `arr-close-gap`,
`arr-split-dup`, `drums-new-hats`; opus `drums-boombap`.

### The noise floor: ±3 tasks / ±2.9 pts (fable), ±1 task (opus)

With the code held constant, fable flipped **three** tasks between runs. That is the
measured run-to-run variance of this suite, and it has a consequence well beyond this
change:

> **Every single-run delta in the committed boards that is smaller than ~3 tasks is
> indistinguishable from noise.** The headline "loop = +8.9 pts" is 3 tasks, measured
> once. It sits *at* the noise floor. None of the existing boards were ever repeated.

Treat single-run deltas under ~3 tasks as unresolved, not as findings.

## Honest caveats

- **The attributable effect is +2 ambiguous tasks.** That one is solid: reproduced in
  4/4 post-change runs, mechanistically explained, and *predicted in advance* (the
  missing-fact-vs-underspecification analysis said which tasks would flip and which
  would not, before the runs).
- **`arr-loop-first-second` + `master-glue` are likely real but not proven.** 4/4
  post-change vs 0/2 baseline across two models is good evidence, and there is a
  plausible mechanism (the gated plan instruction forces naming target + outcome before
  planning — a grounding step). But **each baseline is still n=1**, and 3 tasks is
  exactly fable's noise envelope, so an unlucky baseline is not excluded. Settling it
  needs repeated *baselines*, which were not run.
- **The headline deltas (+14.7 / +11.7) should not be quoted** as the effect of this
  change.
- **`amb-upload` was deliberately not fixed.** "Master this and upload it to spotify"
  *does* name a target and an outcome — it is a **capability boundary**, not an
  ambiguity. A rule that caught it would have been fitted to the answer key. It wants a
  separate capability rule ("if part of the ask is something you cannot do, say so
  rather than doing only the part you can"), measured on its own.
- **The suite is worn.** 34 tasks, now read against ~23 boards. The honest next step for
  this category is to *grow* it with 4–6 cold ambiguous asks and check the rule transfers.

## Collateral fix

`loopBrainMock.modeOf()` detected plan mode with `/^Make a plan for the TASK/m` — an
anchored full-sentence match. The gated instruction no longer *starts* with that phrase,
so the mock silently fell through to `"other"`, returned its terminal `done` reply, and
`runTask.test.ts` saw a 0-step task. Now matched on the stable substring `/make a plan/i`
(present in both phrasings; absent from compile/repair/continue) — less brittle than
before. Caught by vitest, not by inspection.

## Verification

`npm test` **1707 passed** / 1 skipped · `npm run typecheck` clean ·
`agent-loop` + `agent-memory` e2e **8/8** (isolated config) ·
`brainCore.test.ts` **20 passed** — the single-shot prompt is byte-identical, so the
frozen SFT/gepa surfaces are untouched. The change is confined to the loop path.

Boards: `scoreboard.{amb-probe-00-baseline,amb-probe-01-ambiguity-gate,fable-5-loop-ambgate,opus-4.8-loop-ambgate}.{json,md}`
