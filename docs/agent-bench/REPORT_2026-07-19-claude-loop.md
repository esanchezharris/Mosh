# MoshAgentBench — Opus 4.8 & Fable 5 through the loop (2026-07-19)

Run via the `--claude-cli` transport (the owner's Claude Code subscription,
`claude -p`, system prompt REPLACED via `--system-prompt-file`, tools denied,
empty cwd). Same 34 tasks, same `/Applications` binary as every other board.

## The transport control that rewrote the numbers

The codex lane's rule — *no cross-transport deltas without a same-transport
control* — earned its keep immediately. CLI singles for both models:

| model | OpenRouter single | claude-CLI single | seat effect |
|---|---|---|---|
| Opus 4.8 | 64.7% | 67.6% | +2.9 (friendlier) |
| Fable 5 | 73.5% | **58.8%** | **−14.7** |

Fable's CLI single collapses with NO parse failures, NO API errors, and only
one defer — it fails on decision quality (precision misses, never-emitted
commands, cmd-err 17.2%, tersely-budgeted ~470-token replies vs the 4000-token
OpenRouter cap). The CLI owns its own reasoning budget and it clearly starves
Fable single-shot. Had we compared loop-vs-OpenRouter-single, Fable would have
read "flat" and Opus "−2.9" — both wrong.

## The honest loop-leverage spectrum (same transport on both sides, complete)

| model | single → loop | Δ | transport |
|---|---|---|---|
| **Fable 5** | 58.8 → **73.5** | **+14.7** | claude-cli |
| Sonnet 5 | 73.5 → **82.4** | +8.9 | OpenRouter |
| grok-4.3 | 67.6 → 76.5 | +8.9 | OpenRouter |
| K3 | 70.6 → 70.6 | 0 | OpenRouter |
| gpt-5.6-sol | 64.7 → 61.8 | −2.9 | codex |
| Opus 4.8 | 67.6 → 61.8 | **−5.8** | claude-cli |

## Anatomies

**Opus — the pendulum.** The loop cured exactly what single-shot measured
(wrong-defers 6→1; every visibility class flipped; +6 gains) and then
overshot: ALL THREE ambiguous tasks lost (16 unsolicited commands on "make it
better"), plus in-loop slips (never-emitted `set_clip_loop`, an extra bus, an
empty master chain) and the worst step-efficiency measured (0.48, 63 calls,
3.2M input tokens). The loop doesn't just amplify temperament — for the most
cautious model it INVERTED it straight past the target.

**Fable — the ceiling.** 8 gains / 8 losses, the most churn of any model. The
gains include **`drums-new-hats` — the first model EVER to pass it** (the
native-error-copy trap), the full compose-drums category, and `arr-split-dup`
(the designed-impossible prober). The losses: all three ambiguous tasks (19
unsolicited commands — the worst action-bias measured), the same
`set_clip_loop`/`arr-close-gap` in-loop slip classes that hit Opus and GPT,
and two scattered regressions. Fable in-loop reaches tasks nothing else
reaches, and bleeds the surplus on discipline.

## What this settles

- **The LOOP_RULES `need_user` fix is worth ~3 points to EVERY model** — all
  six loop runs lost the ambiguous category (2–3 tasks) to plan-first action
  bias. It is unambiguously the top post-playtest change; with just the
  ambiguous tasks recovered, Fable-loop projects to ~82% (Sonnet territory)
  with a higher demonstrated ceiling, Sonnet to ~88%.
- **Seat verdict unchanged: Sonnet 5** — best absolute loop score, zero
  in-loop wrong-defers, an order of magnitude cheaper than Fable. **Fable 5 is
  the confirmed escalation tier**: uniquely solves the hardest tasks in BOTH
  runners (both hardest repairs single-shot on OpenRouter; the never-solved
  drums trap in-loop). A "hard task → escalate one call to Fable" tier is now
  evidence-backed, not speculative.
- **A third transport lesson**: every CLI seat reshapes model behavior its own
  way (codex: effort default; claude-cli: reply/reasoning budget). The bench's
  rule is now standing: a scoreboard's transport is part of its identity, and
  only same-transport deltas are real.

## Costs (owner's subscription, Max plan)

Opus loop 63 calls / 3.2M+40k tok · Fable loop 72 calls / 2.2M+42k tok ·
controls 34 calls each. All free-on-subscription; no usage-window stalls hit.

## Reproduce

```bash
cd ui && npm run agent-bench -- --claude-cli --model claude-fable-5 \
  --runner loop --tag fable-5-loop --bin <Mosh>   # requires `claude auth login`
```
Boards: `scoreboard.{opus-4.8,fable-5}-{loop,cli-single}.*` beside this file.
Suite at repo `f6c18a45`.
