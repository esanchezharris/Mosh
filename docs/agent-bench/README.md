# MoshAgentBench

Multi-step agent eval for Moshi — "can the agent actually *operate* Mosh",
measured by executed state on the real headless engine, never by text match.

## What it measures

34 production tasks (`ui/src/bench/agentTasks.ts`) across nine categories —
arrange, compose-drums, compose-melody, mix, master, generative (fake adapter),
lyrics, repair, ambiguous — each with:

- a **setup** command list (replayable on both substrates; every command is
  agent-callable, so mock parity + native handlers are contract-guaranteed),
- a natural-language **ask**,
- deterministic **goal predicates** over the final snapshot
  (`ui/src/bench/goalChecks.ts` — the same `grade()` moshi-bench uses),
- a **par** step count for efficiency scoring.

Metrics per run: **success%** (the gate), per-category success, step efficiency
vs par, command-error rate, invalid-command rate, wrong-defers (action tasks
answered with a question) and defer-correct% (ambiguous tasks that correctly
declined to act).

## Substrates

- **Real headless engine** (the gate): `Mosh --run-script` via cumulative-prefix
  replay — step N re-runs `[setup, batch₁…batchN]` in a fresh engine (ids are
  deterministic across replays of the same prefix). This is what
  `npm run agent-bench` drives.
- **Dev mock** (harness smoke only): `ui/src/bench/agentBench.mock.test.ts` runs
  a scripted brain through the REAL executor path (validation, destructive
  screen, batch bracketing) in vitest. The mock never gates a model verdict.

## Runners

Anything implementing `AgentRunner` (`ui/src/agent/loopSeam.ts`):

- `single` — today's shipped one-shot brain (baseline),
- `single-repair` — + ONE error-fed fix turn (the loop-headroom preview),
- `loop` — the Phase-B agentic loop (errors until that lane lands and exports
  an AgentRunner; it then slots in with zero bench changes).

## Running it

```bash
cd ui
# default provider from ui/.env.local (OPENAI_BASE_URL/KEY/MODEL):
npm run agent-bench -- --runner single --tag mymodel-single

# a sweep entry via OpenRouter (one key, any model):
OPENROUTER_KEY=sk-or-... npm run agent-bench -- \
  --base https://openrouter.ai/api/v1 --key-env OPENROUTER_KEY \
  --model moonshotai/kimi-k2.5 --runner single --tag kimi-k2.5-single

# the local MLX seat:
npm run agent-bench -- --base http://127.0.0.1:8080/v1 --key-env LOCAL_KEY \
  --model <served-id> --tag local-r5-single

# options: --tasks id,id · --max-steps N (default 8) · --bin <Mosh> · --no-render
```

Needs a Mosh binary (`--bin`, or auto-discovered newest of the build trees /
`/Applications/Mosh.app`). Temperature 0. Scoreboards land here as
`scoreboard.<tag>.{json,md}`; `render:true` tasks export before/after WAVs to
`~/mosh-agentbench-artifacts/<tag>/` — the by-ear side channel (never gating).

## Reading results honestly

- **Session-rendering blind spots** (half-closed, 2026-07-27): the LOOP path now
  renders master/buses/tempo-map/key via `richSessionBlock`
  (`ui/src/agent/loop/loopPrompt.ts`), and that alone took `master-trim` from
  failing to 5/5 on the loop runner. The SINGLE-SHOT path still uses
  `compactSnapshot` (`brainCore.ts`), which omits ALL of it — so on `--runner
  single`, a master/tempo-map failure is still a VISIBILITY failure, not a model
  failure. There are two renderers, deliberately: `compactSnapshot` is byte-frozen
  for the SFT/GEPA consumers and is hand-mirrored in Python
  (`service/sft/build_add_note_corrective.py::render_session`), so moving it costs
  a corpus rebuild. Say which runner you ran before comparing models.
- **A read-only discovery call teaches the model NOTHING in the loop.**
  `StepCommandResult` is `{command, ok, error}` — no payload — so `list_builtins`
  comes back to the model as the string `list_builtins → ok`. The signature is a
  doubled `list_builtins, list_builtins` followed by a guessed argument. This is
  what made `master-eq-before-comp` fail on *every* seat: the natural guess for an
  EQ is `"eq"`, and the engine's type is `"4bandEq"`. Fixed on 2026-07-27 by
  inlining the vocabulary into the catalog (`BUILTIN_TYPES` in
  `ui/src/agent/commands.ts`), measured below. If you add another command whose
  arguments come from a `list_*` call, it has the same defect by construction —
  put the vocabulary in the description, or teach the loop to feed payloads back.

### Measured: inlining the builtin vocabulary (2026-07-27)

Seat `claude-sonnet-5` via `--claude-cli`, same binary, same task set; the ONLY
difference between arms is `ui/src/agent/commands.ts`. Repeated runs, not one
run — single-run deltas on a 3-task category are worthless (each task is 0 or 1,
so one run can only land on 0/33/67/100%). Fisher exact, two-tailed:

`--runner loop`, 5 reps/arm (15 task-instances/arm):

| task | before | after | p |
|---|---|---|---|
| master-glue | 4/5 | 5/5 | 1.00 |
| master-eq-before-comp | **0/5** | **5/5** | 0.008 |
| master-trim | 5/5 | 5/5 | — |
| **category** | **9/15 (60.0%)** | **15/15 (100%)** | **0.017** |

`--runner single`, 10 reps/arm (30 task-instances/arm):

| task | before | after | p |
|---|---|---|---|
| master-glue | 5/10 | 10/10 | 0.033 |
| master-eq-before-comp | **0/10** | **8/10** | 0.0007 |
| master-trim | **0/10** | **0/10** | 1.00 (unchanged — different cause, below) |
| **category** | **5/30 (16.7%)** | **18/30 (60.0%)** | **0.0012** |

The score is not the strongest evidence; the mechanism is. On the loop runner,
`list_builtins` calls went **24 → 0** — the dead-end discovery call stopped
happening entirely. On the single runner the before-arm was already emitting
`load_master_builtin` directly and having it *rejected by the engine* for a
guessed `type`; the after-arm emits the same command and it lands.

`master-trim` is the honest exception: unchanged at 0/10 on the single runner
while sitting at 5/5 on the loop runner. It is not a vocabulary failure — it is
the `compactSnapshot` blind spot above. The master fader defaults to **−3 dB**
and the single-shot prompt never renders it, so "pull the master down a couple
dB" gets an absolute value chosen as if the fader were at 0. Closing it means
moving `compactSnapshot`, which drags the byte pin, the SFT corpora and the
Python hand-mirror with it — a deliberate, separate piece of work.
- Mock-vs-real drift: if a task behaves differently across substrates, the real
  engine is the truth and the mock gets a parity fix (see the BUILTINS drift
  the bench caught on day one).
- By-feel disagreements: log them in a session-notes file
  (`SESSION_NOTES_TEMPLATE.md`) — they are the task suite's drift detector.
