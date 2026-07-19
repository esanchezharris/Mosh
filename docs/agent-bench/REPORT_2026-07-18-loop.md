# MoshAgentBench — the Phase-B loop gate + the 10-model sweep (2026-07-18)

Same 34 tasks, same real engine, three runners: `single` (the shipped one-shot),
`single-repair` (one error-fed retry), `loop` (the Phase-B agentic loop: plan →
act → OBSERVE the rich session → repair, budgets 8/3/8, one undo per task).
Loop runs include the Phase-B contract-shape fixes (drum object/newline forms,
per-ArgSpec coercion) — those ship with the loop, so the loop column measures
the harness users would actually get.

## The headline

| model | single | loop | Δ |
|---|---|---|---|
| **claude-sonnet-5** | 73.5% | **82.4%** | **+8.9pp** |
| x-ai/grok-4.3 | 67.6% | **76.5%** | **+8.9pp** |
| moonshotai/kimi-k3 | 70.6% | 70.6% | 0 |

**The harness was the bottleneck, and the loop pays** — but loop leverage is a
model SKILL: Sonnet and grok convert observation into wins; K3's gains were
eaten by new losses. Costs per full loop run: Sonnet ~506k+36k tokens / 73
calls (≈ $1.5 at intro pricing); grok ~262k+35k / 58 calls and the best step
efficiency (0.75 vs Sonnet's 0.56 — grok plans tighter, Sonnet explores more).

## The full single-shot sweep (10 models, one OpenRouter key)

| model | single | wrong-defers | notes |
|---|---|---|---|
| claude-sonnet-5 | 73.5% | 2 | the seat: capability + temperament |
| claude-fable-5 | 73.5% | 1 | uniquely solved BOTH hardest repairs (incl. removing a tempo point it could not see); 5× Sonnet's price |
| moonshotai/kimi-k3 | 70.6% | 1 | best open-weight; week-old |
| x-ai/grok-4.5 | 67.6% | 1 | no gain over 4.3 here |
| openai/gpt-5.6-sol | 67.6% | 4 | lowest cmd-error rate (5.9%) |
| x-ai/grok-4.3 | 67.6% | 5 | +repair = 73.5% |
| z-ai/glm-5.2 | 64.7% | 3 | below its leaderboard reputation (contamination suspicion holds) |
| claude-opus-4.8 | 64.7% | 6 | UNDER-performs Sonnet via over-caution, not capability |
| minimax-m3 | 55.9% | 6 | |
| moonshotai/kimi-k2.5 | 55.9% | 8 | asks permission on clear asks |
| minimax-m2.1 | 52.9% | 10 | worst temperament in the field |

## What the loop actually fixed (per-task flips)

- **`master-trim` flipped for ALL THREE** — the pure visibility win, exactly as
  predicted: the loop's rich session block shows the master fader's −3 dB
  default, so "pull it down a couple dB" finally means something. Every
  single-shot model had failed it identically.
- **`rep-rogue-tempo` flipped for all three** — the tempo map (with indices) in
  the session block turns the hardest blind repair into a one-step read.
- **`arr-split-dup`** (split, then duplicate the NEW half — structurally
  impossible single-shot): Sonnet's loop observes the post-split clip id and
  finishes it. The designed prober, probed.
- **`drums-boombap`** (Sonnet, K3) + **`drums-trap-sketch`/`mute-hat-lane`**
  (grok) — the shape fixes + error-fed repair working together.
- **`mix-submix` / `mix-vocal-space`** — the bus number exists only after
  create_bus; the loop reads it from the observation instead of guessing.

## What the loop COSTS (the honest column)

Every model lost ground on **ambiguous tasks** in the loop (`amb-upload` down
for all three; `amb-make-better` down for two — grok produced EIGHT steps of
unsolicited arrangement on "make it better"). The loop prompt's plan-first
framing biases toward action, and **it amplifies temperament**: a model that
wrong-acts now wrong-acts eight steps deep (still one undo away, and Stop
works — but it's the #1 prompt-tuning follow-up: strengthen need_user guidance
in LOOP_RULES). `arr-close-gap` also regressed for Sonnet/K3 — worth a
transcript read. Still unflipped by anyone: `drums-new-hats` (the native error
copy says "use a drum track" and models convert the wave track instead of
making a new one — error-copy fix filed) and `master-eq-before-comp`.

## Seat recommendation

- **Cloud planner: claude-sonnet-5** — best loop score, zero in-loop
  wrong-defers, intro pricing to Aug 31. Runtime = OpenRouter base URL in the
  existing OpenAI-shaped proxy.
- **Value/latency alternative: grok-4.3** (already keyed directly): 76.5% loop
  at a fraction of the cost, tightest plans.
- **Track**: Kimi K3 (open weights land ~Jul 27) and Fable 5 (the repair-
  reasoning ceiling; consider it for a future "hard repair" escalation tier).
- **Local seat**: Phase C (Qwen3.6-35B-A3B pull + A/B vs r5, then the r6 call).

## Reproduce

```bash
cd ui && OPENROUTER_KEY=... npm run agent-bench -- \
  --base https://openrouter.ai/api/v1 --key-env OPENROUTER_KEY \
  --model anthropic/claude-sonnet-5 --runner loop --tag sonnet-5-loop \
  --chat-max-tokens 4000 --bin <Mosh>
```
Boards: `scoreboard.<tag>.{json,md}` beside this file. Baseline context:
`BASELINE_2026-07.md`. Suite sha at run time: repo `a6bd825a`.
