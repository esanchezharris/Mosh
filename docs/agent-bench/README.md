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

- **compactSnapshot blind spots**: the brain's session rendering currently
  omits buses, the master chain, the tempo map and the key — master/tempo-map
  task failures can be VISIBILITY failures, not model failures. Call this out
  when comparing models; the fix belongs to the Phase-B harness lane.
- Mock-vs-real drift: if a task behaves differently across substrates, the real
  engine is the truth and the mock gets a parity fix (see the BUILTINS drift
  the bench caught on day one).
- By-feel disagreements: log them in a session-notes file
  (`SESSION_NOTES_TEMPLATE.md`) — they are the task suite's drift detector.
