# MoshAgentBench — the Codex-subscription lane (2026-07-19)

The owner's ChatGPT/Codex subscription serves **gpt-5.4 (full), gpt-5.5, and
gpt-5.6-sol** via `codex exec` (bare `gpt-5.x` / `-codex` names are rejected on
ChatGPT auth). A new `--codex-cli` bench transport runs them with no API key.
Same 34 tasks, same `/Applications` binary as the whole sweep.

## The seat had to be built before the numbers could be trusted

Codex has **no system-prompt override** — its ~15k-token coding-agent harness
wraps every seat. Three seat variants, measured on the 5.6-sol control
(OpenRouter reference = 67.6%):

| seat | 5.6-sol single | verdict |
|---|---|---|
| inline `[system]` block, default effort | 58.8% (wrong-defers 4→7) | persona outranks quoted text |
| AGENTS.md delivery, default effort | 55.9% | instruction placement wasn't the lever |
| **AGENTS.md + `model_reasoning_effort=xhigh`** | **64.7%** | within ONE task of reference → adopted |

The −9pp "codex penalty" was **reasoning-effort default, not persona** — and
xhigh is what the owner's own daily codex config runs anyway. Method lessons,
paid for in tokens: (1) a 6-task probe subset "confirmed" the AGENTS.md seat
(4/6) and the full suite refuted it — only full-suite controls settle seat
questions; (2) the transport's guard line originally said "do not run any
commands" and gpt-5.4 promptly wrong-deferred — `commands` is the reply
contract's field name; the word is banned from the wrapper (comment-pinned).

## The GPT ladder (seat-v3: agentsmd + xhigh)

| model | single | vs |
|---|---|---|
| gpt-5.4 (full) | 61.8% | = the shipping gpt-5.4-mini's 61.8% — the mini costs NOTHING at this tier |
| gpt-5.5 | 58.8% | no step up; the 5.4→5.5 rung is flat-to-noise |
| gpt-5.6-sol | 64.7% | the only real rung on the ladder |

(Reference points: Sonnet 5 73.5 single / 82.4 loop; K3 70.6; grok-4.3 67.6.)

## The first OpenAI loop number — a REGRESSION

**gpt-5.6-sol loop: 61.8% (−2.9pp vs its own single).** The loop-leverage
spectrum is now complete and it is a model skill with a NEGATIVE end:

| model | single → loop | Δ |
|---|---|---|
| Sonnet 5 | 73.5 → 82.4 | +8.9 |
| grok-4.3 | 67.6 → 76.5 | +8.9 |
| K3 | 70.6 → 70.6 | 0 |
| gpt-5.6-sol | 64.7 → 61.8 | **−2.9** |

The anatomy (per-task diff): the loop DID deliver its structural wins — all
the predicted visibility flips landed (master-trim, rep-rogue-tempo,
mix-submix, gen-reimagine-subtle, mel-keys-in-key = 5 gains) and wrong-defers
fell 5→1. But 5.6-sol gave back six: **four command-emission failures**
(drums-boombap / mel-quantize / gen-run-render / lyr-first-line — the key
command never got issued in-loop on tasks its own single-shot solved; transcript
read = a follow-up) **plus both ambiguous regressions** (11 unsolicited
commands on "make it better"; acted on the upload defer-trap). The loop
amplifies temperament in both directions: it cures blindness and defer-bias,
and it compounds action-bias and in-loop sloppiness.

## Verdicts

- **Seat decision unchanged: Sonnet 5** remains the planner seat; nothing in
  the GPT ladder approaches it single OR loop.
- **The shipping gpt-5.4-mini is vindicated** — free upgrade to full-5.4 buys
  0.0pp. If the default seat ever changes, jump tiers, not sizes.
- **The codex transport is now a fair, reusable seat** (`--codex-cli` +
  `MOSH_CODEX_SEAT=agentsmd` + `MOSH_CODEX_EFFORT=xhigh`) for future OpenAI
  models at zero marginal cost — worth re-running when GPT-6-class lands.
- LOOP_RULES need_user strengthening (already follow-up #1 from the loop gate)
  now has a THIRD model's evidence behind it.

## Reproduce

```bash
cd ui && MOSH_CODEX_SEAT=agentsmd MOSH_CODEX_EFFORT=xhigh npm run agent-bench -- \
  --codex-cli --model gpt-5.6-sol --runner loop --tag <tag> --bin <Mosh>
```
Boards: `scoreboard.gpt-5.4-full-codex3-single` / `gpt-5.5-codex3-single` /
`gpt-5.6-sol-codex3-{single,loop}` (+ the seat-v1/v2 forensics boards
`gpt-5.6-sol-codex-single`, `gpt-5.6-sol-codex2-single`, `gpt-5.4-full-single`).
Suite at repo `ddf5e160`.
