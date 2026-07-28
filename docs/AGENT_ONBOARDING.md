# Driving Mosh with an AI — start here

How to point Moshi at a model, how to measure whether that model is any good at operating
Mosh, and where the answers already live. This page is an **index**: it links rather than
restates, because a restated fact is one that quietly goes stale.

> Working *on* the repo with a coding agent? That's [AGENTS.md](../AGENTS.md) — a different
> document for a different job. This one is about operating the DAW *with* a model.

---

## 1. There is no AGENTS.md for operating Mosh — the spec is generated

The most common wrong assumption: that somewhere there is a hand-written file telling an
LLM what Mosh can do. There isn't, deliberately. The system prompt is **built per turn** by
`buildSystemPrompt()` in [`ui/src/agent/brainCore.ts`](../ui/src/agent/brainCore.ts) out of:

| Piece | Source | What it is |
|---|---|---|
| Command catalog | [`ui/src/agent/commands.ts`](../ui/src/agent/commands.ts) | ~124 agent-callable commands, each with typed args and a one-line description |
| Producer knowledge | [`ui/src/agent/knowledge.ts`](../ui/src/agent/knowledge.ts) | ~113 WHY/WHEN cards, retrieved by relevance to the turn (usually 3) |
| Memory | [`ui/src/agent/memory/`](../ui/src/agent/memory/) | learned preferences/patterns/project notes, flag-gated |
| Snapshot | the live session | a compact rendering of the current arrangement |

A static hand-written spec would drift from the real command surface within a week. The
generated one cannot: [`commands.contract.test.ts`](../ui/src/agent/commands.contract.test.ts)
fails if a catalog entry declares an arg the C++ handler never reads, or if a native
dispatch entry is neither agent-callable nor explicitly classified UI-only in
[`commandClassification.ts`](../ui/src/agent/commandClassification.ts).

To see exactly what a model is told, import `commandCatalogPrompt()` from
`ui/src/agent/commands.ts`, or read the contract spec in
[`docs/02_MOSHOPS_CONTRACT.md`](02_MOSHOPS_CONTRACT.md).

**Note the blind spots before you blame a model.** The compact snapshot currently omits
buses, the master chain, the tempo map and the key — so a master/tempo failure can be a
*visibility* failure rather than a reasoning one. The agent-bench README says more.

---

## 2. Point Moshi at a model

Seats are `deepseek | openai | xai | local`, each configured with
`<PREFIX>_BASE_URL` / `_API_KEY` / `_MODEL`. `local` is an OpenAI-compatible server on this
machine and defaults its key, so a URL and a model are enough.

Setup, keys, and why a Finder double-click doesn't see them:
→ **[docs/playtest-prep/agent-setup.md](playtest-prep/agent-setup.md)**

Keeping keys off the client entirely (the Supabase edge function):
→ **[docs/brain-proxy/RUNBOOK.md](brain-proxy/RUNBOOK.md)**

Resolution order is the same in all three clients — native
([`BrainProxy.cpp`](../src/brain/BrainProxy.cpp)), the Vite dev proxy
([`ui/vite.config.ts`](../ui/vite.config.ts)), and the Python service
([`service/brain_client.py`](../service/brain_client.py)): an explicit per-call pick, then
`MOSHI_BRAIN_PROVIDER`, then the first fully-configured seat in list order.

**Switching seats without restarting:** the overflow menu (⋯) lists every seat this install
can actually reach, with its model, and marks the current one. It only appears when there
are at least two — with one seat there is nothing to choose. The same control lives in
Settings ▸ Moshi ▸ Brain, which additionally shows seats you haven't configured yet.
"Auto" sends no preference at all, which is exactly what happened before the picker existed.

Quick check with no GUI: `./run-mosh.sh smoke` (or `Mosh --brain-smoke`) prints the
resolved provider, model, and round-trip time.

---

## 3. Measure a model: MoshAgentBench

34 scored tasks across nine categories, graded by **executed state on the real headless
engine** — never by text match. Full runner docs, flags, and the honest-reading caveats:
→ **[docs/agent-bench/README.md](agent-bench/README.md)**

```bash
cd ui && npm run agent-bench -- --runner single --tag my-model-single
```

**Two suites.** `--suite single` (the default) is the 34 single-turn tasks every historical
board measured — unchanged, so old and new numbers stay comparable. `--suite conversational`
is the 12 multi-turn tasks; `--suite all` runs both. Success is a percentage of whatever
ran, so never compare across suites.

```bash
cd ui && npm run agent-bench -- --suite conversational --tag my-model-conv
```

The conversational suite measures what a single ask structurally cannot: whether the agent
**asks before guessing** (`converse-clarify`), **tracks referents** across turns
("no, the other one" — `converse-correct`), **builds over a session**
(`converse-session`), and **reads damage it caused itself** (`converse-recover`). Follow-up
turns are fixed strings, not a model playing the user — that keeps grading deterministic,
at the price of not being able to judge whether the agent's question was a *good* one.

Three transports, all the same 34 tasks:

- **HTTP** (default) — any OpenAI-compatible endpoint; `--base` + `--key-env` for sweeps
  (OpenRouter is the neutral reference used across the existing boards).
- **`--codex-cli`** — the ChatGPT/Codex subscription, no API key. Codex has no
  system-prompt override, so **always** pass `MOSH_CODEX_SEAT=agentsmd` and
  `MOSH_CODEX_EFFORT=xhigh`; the defaults cost ~9pp and read as a model difference.
- **`--claude-cli`** — the Claude Code subscription, same idea.
- **`--codex-mcp`** — the **tool-driving** seat: codex reaches Mosh through an MCP server
  (`ui/scripts/lib/moshMcpServer.mts`) with `get_snapshot` + `execute_command`, instead of
  answering with one JSON blob. Same replay substrate, same validation and destructive
  budget; the only variable is tool access. **A different measurement — never merge its
  number into a one-shot board.** ⚠ It requires
  `--dangerously-bypass-approvals-and-sandbox`: every narrower setting tried
  (`approval_policy="never"`, per-tool `approval_mode="auto"`, `-a never -s read-only`)
  auto-cancels MCP tool calls headlessly. That flag also drops codex's shell sandbox for
  the run, so this seat grants the model unsandboxed shell on the host — decide that
  deliberately before running it unattended.

Local MLX seat (fuse/serve procedure and its traps — serve a fused dir, never
`--adapter-path`; use the exact id from `/v1/models`; one MLX process at a time):
→ **[service/sft/EVAL_RUNBOOK.md](../service/sft/EVAL_RUNBOOK.md)**

---

## 4. Where things stand

Single-shot runner, 34 tasks, `/Applications/Mosh.app`. Full history:
[BASELINE_2026-07.md](agent-bench/BASELINE_2026-07.md) ·
[codex lane](agent-bench/REPORT_2026-07-19-codex-lane.md) · `scoreboard.*.md` in
[docs/agent-bench/](agent-bench/).

| Seat | single | loop | note |
|---|---|---|---|
| Sonnet 5 | 73.5% | 82.4% | the planner seat; best loop leverage measured |
| gpt-5.6-sol · codex-cli | **69.9% mean (64.7–76.5, n=4)** | 61.8% (2026-07-19) | see the noise note below |
| K3 | 70.6% | 70.6% | no loop leverage either way |
| gpt-5.6-sol · HTTP | 67.6% | — | direct OpenAI API, 2026-07-27 |
| grok-4.3 | 67.6% | 76.5% | |
| gpt-5.4-mini | 61.8% | — | the shipping default |
| **local Qwen3-30B-A3B r5** | **50.0%** | — | first local read, 2026-07-27 |

**⚠ Single codex-seat runs are not trustworthy — the spread is ~12pp.** Four runs of the
*identical* configuration (gpt-5.6-sol, `agentsmd`, `xhigh`, same 34 tasks, same binary)
scored 22, 23, 24 and 26 of 34 — **64.7 / 67.6 / 70.6 / 76.5%**. Any conclusion drawn from
one run of this seat is drawing a line through noise. Quote the range, or run n≥3.

*This retracts a claim made here on 2026-07-27.* An earlier version of this page reported
76.5% as evidence that the "codex penalty had reversed" and that the codex seat now beat
plain HTTP by +8.9pp. Re-running settled it: 76.5% was the top of the distribution, and
July's 64.7% sits **inside** today's range. There is no evidence the penalty reversed, and
none that it exists either — the two are indistinguishable at this sample size.

*The direct-API seat did reproduce the OpenRouter reference exactly* — gpt-5.6-sol scored
67.6% over `api.openai.com`, matching the July OpenRouter control to the task. That one
holds; two independent transports agreeing is the best evidence we have that the HTTP seat
measures the model and not the plumbing. (One run each, so treat it as agreement, not as a
point estimate.)

*Reasoning effort bought nothing measurable.* The full sweep, same seat and suite:

| effort | single-turn | n |
|---|---|---|
| `low` | **70.6%** | 1 |
| `medium` | 61.8% | 1 |
| `high` | 64.7% | 1 |
| `xhigh` | 67.6 / 70.6 / 76.5% | 3 |

There is no monotonic relationship — `low` beat both `medium` and `high`, and the spread
across *all four* effort levels (61.8–76.5) is barely wider than the spread *within* `xhigh`
alone (67.6–76.5). July inferred that effort was the entire "codex penalty" from two data
points; with the noise floor known, that inference does not survive. The honest read is **no
detectable effect**, not "equal" — but nothing here justifies paying for `xhigh`, and a
future sweep that needs to be cheap can use `low` without a defensible objection.

**Conversational baseline (gpt-5.6-sol · codex-cli · xhigh, 2026-07-27): 9/12.**
The interesting part is *where* it fails, and it is the same place every run:

- **It will not ask.** `conv-clarify-louder` failed on all three runs at two effort levels —
  told "make it louder" against four tracks, it acts rather than clarifying, and its guess
  was the **master fader**. Turn 1 then does the right thing once told. So the capability is
  there; the restraint is not. This is July's "strengthen `need_user`" follow-up, finally
  measurable rather than asserted.
- **Corrections it handles well** — 3/3 at `xhigh`, including the stacking trap
  (`conv-correct-too-much`: "make it 3, not 8" lands at −3, not −11). `low` failed that one
  at −11, the clearest behavioural difference any effort level produced.
- **Half-fixes it calls done.** `conv-recover-clipping`: after boosting the 808 +10 and
  being told it clips, it comes back to +6 and stops — still hot, still clipping.

## 4b. The unblinding (2026-07-27) — read this before comparing old numbers

Moshi used to be **blind to most of its own session**. The shipped single-shot brain
rendered a compact block (tempo, sections, tracks) while the agentic loop rendered a much
richer one — and `agenticLoop` defaults OFF, so the blindness was what real users got.
Every one-shot seat ever measured scored 0/3 or 1/3 on the bench's `master` category, for
the simple reason that it was being asked to change something it had never been shown.

There is now **one renderer**, `sessionBlock` in [brainCore.ts](../ui/src/agent/brainCore.ts),
used by both paths. Beyond the master it also surfaces what the catalog's own commands
need and the model previously had to guess:

| now visible | the command that needed it |
|---|---|
| master fader / pan / chain, buses | `set_master_volume`, `load_master_builtin`, `add_send` |
| key, tempo map **with indices** | `set_key`, `remove_tempo_change` |
| track **type** (audio/midi/drum) | `add_drum_pattern` — rejected on a wave track, and every model answered the rejection by *converting* the track and losing the audio |
| per-track **FX chain with indices** | `remove_plugin`, `reorder_plugin` — both take an index |
| clip **length**, gain, mute | `trim_clip`, `split_clip` — "make it 3 seconds" needs the current one |
| per-track pan / sends | `set_track_pan`, `add_send` |

**Every number recorded before 2026-07-27 was measured through the blind prompt.** They
remain valid as history and are still comparable to each other, but not to anything
measured after. The `sha256` pin in `loopPrompt.test.ts` moved twice, consciously, with the
diff written down each time.

**Two consequences worth carrying forward.** The SFT builder
(`service/sft/build_add_note_corrective.py`) hand-mirrors this renderer and was updated in
step — verified byte-identical against the TS. But **adapters trained before this date
(a3b-r5 and earlier) learned the OLD prompt shape**, so the local seat's 50.0% is stale and
that model now meets a prompt it never saw in training; re-measure before trusting it.
GEPA baselines are keyed to the old bytes too.

*Effect, measured on the HTTP seat (gpt-5.6-sol, single-turn 34):*

| prompt | score | `master` | wrong-defers |
|---|---|---|---|
| blind (before) | 67.6% | **0/3** | **4** |
| + master / key / buses / tempo map | 76.5% | 1/3 | 2 |
| + track type / FX chain / clip length | **79.4%**, 73.5% | 1/3 | **0**, **0** |

Read the last two columns, not the first. The totals (67.6 → 73.5/79.4) point the right way
but sit inside this benchmark's known run-to-run noise, and it is n=1 before vs n=2 after.
What is *consistent* is mechanistic and repeated in every post-unblinding run: `master` went
0/3 → 1/3 and stayed, and **wrong-defers went 4 → 2 → 0 → 0**. That last one is the finding
— a wrong-defer is Moshi refusing a request it should have acted on, and it stopped doing
that once it could see the session. The remaining 2/3 `master` failures are a *different*
gap: those tasks want `load_master_builtin` and the model emits `list_builtins` instead
because it cannot see what builtins exist. Same class of bug, not yet fixed.

**A guard this exposed.** With track type visible, models stopped calling
`add_drum_pattern` on a wave track (which is guarded) and started calling `set_track_type`
to "fix" it first — which was **not** guarded and silences the track by loading a sampler
over its audio. Now guarded in both MoshOps and the mock, with the same recovery copy.
Worth noting as a pattern: giving a model more sight makes it reach for commands it never
used to reach for, so the newly-reachable ones need their guards checked.

**The local seat's shape, not just its score.** 50.0% understates how usable it is and
overstates it at the same time. It is *strong* where the task is a direct instruction
(generative 3/3, compose-melody 3/4) and weak on judgment: 22.1% command-error rate (vs
~5% for the cloud seats), and it acted on 3 of the 4 ambiguous tasks that are supposed to
be declined — an action-bias, the opposite of the wrong-defer failure the GPT seats show.
It also carries a known fusion caveat: r5 was trained on the bf16 base, so it is served
through the attn-overlay builder rather than a plain fuse, which would have rounded most of
the adapter away. See [LOCAL_SERVE_READ_a3b-r5-mlx.md](../service/sft/LOCAL_SERVE_READ_a3b-r5-mlx.md).

---

## 5. Reproducing the three-way comparison

```bash
# Same model, both seats — the transport control
cd ui && npm run agent-bench -- --model gpt-5.6-sol --runner single --tag sol-http
cd ui && MOSH_CODEX_SEAT=agentsmd MOSH_CODEX_EFFORT=xhigh npm run agent-bench -- \
  --codex-cli --model gpt-5.6-sol --runner single --tag sol-codex

# The local seat (build once, ~18GB; see EVAL_RUNBOOK for the traps)
source service/sft/.sft.env
"$SFT_PY" service/sft/build_attn_overlay_model.py \
  ~/AI/models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit ~/AI/models/bf16-attn-32-47 \
  ~/AI/adapters/a3b-r5-mlx ~/AI/models/fused/a3b-r5-4bit-hd ~/AI/models/bf16-extra
"$SFT_PY" -m mlx_lm.server --model ~/AI/models/fused/a3b-r5-4bit-hd --port 8080 &
cd ui && npm run agent-bench -- --base http://127.0.0.1:8080/v1 --key-env LOCAL_KEY \
  --model "$(curl -s localhost:8080/v1/models | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"][-1]["id"])')" \
  --runner single --tag local-r5
```

A run costs cents and about 5–8 minutes per config. Scoreboards land in
`docs/agent-bench/scoreboard.<tag>.{json,md}`.
