# MoshAgentBench — BASELINE, 2026-07-18

The first honest read of "how intelligently can the agent operate Mosh today",
measured on the real headless engine with the shipped single-shot harness.

- **Repo:** `6633848d` (Phase-A audit lane; catalog closure + bench landed)
- **Binary:** `build-macos-arm64-release` Release, 2026-07-18 01:48
- **Task suite:** 34 tasks, `ui/src/bench/agentTasks.ts` @ sha256 `440ca5d5969b…`
- **Providers measured:** `gpt-5.4-mini` (the shipping default brain) and
  `grok-4.3` (the configured xAI seat). Local r5 has no fused serve model on
  disk right now — its read happens in Phase C alongside the Qwen3.6 pull. The
  full high-watermark sweep (Kimi K2.5/K3, MiniMax M2.1, GLM, Claude tiers)
  needs an **OpenRouter key** — the one owner action.

## Headline

| config | success | step-eff | cmd-err | invalid | wrong-defers | defer-correct | tokens |
|---|---|---|---|---|---|---|---|
| gpt-5.4-mini · single | 21/34 = **61.8%** | 1.00 | 12.3% | 7.8% | 3 | 3/4 | 136k+2k |
| gpt-5.4-mini · single-repair | 20/34 = **58.8%** | 0.94 | 13.4% | 4.5% | 3 | 3/4 | 177k+3k |
| grok-4.3 · single | 23/34 = **67.6%** | 1.00 | 9.8% | 2.9% | 5 | 4/4 | 140k+2k |
| grok-4.3 · single-repair | 25/34 = **73.5%** | 0.98 | 6.9% | 0.5% | 4 | 4/4 | 161k+2k |

- **grok-4.3 beats the shipping default by ~6pp**, and the one-error-fed-repair
  turn buys it another **+5.9pp** (67.6 → 73.5) — the cheapest preview of what
  the Phase-B agentic loop is worth. gpt-5.4-mini did NOT benefit from repair
  (see caveats: reasoning-tier nondeterminism; its repair turns often re-made
  the same mistake or over-did the fix, e.g. split+dup executed twice).
- Whole-run cost was cents per config; wall time ~5-8 min per config.

## Per category (single runner)

| category | gpt-5.4-mini | grok-4.3 |
|---|---|---|
| arrange | 5/6 | 5/6 |
| compose-drums | 1/4 | 0/4 |
| compose-melody | 2/4 | 4/4 |
| mix | 5/5 | 4/5 |
| master | 0/3 | 1/3 |
| generative | 2/3 | 2/3 |
| lyrics | 2/2 | 2/2 |
| repair | 1/3 | 1/3 |
| ambiguous | 3/4 | 4/4 |

## Failure taxonomy (the actual audit product)

Diagnosed from per-command envelopes + native probes, most fixable first:

### 1. Contract-shape failures — two FIXED this pass, in `normalizeCommand`

Every model naturally emitted `add_drum_pattern`'s pattern as an **object**
(`{kick:"x..."}`), which the NATIVE handler accepts (DRM-002 designed it that
way) but client-side `validateCommand` rejected — ArgSpec has no object type,
so the UI layer was stricter than the real contract, and it cost every model
most of compose-drums *in the shipped app, not just the bench*. Also caught:
newline-separated lanes (the flat parser then reads the next lane's NAME as
step chars). Both now normalize to the declared flat form in
`ui/src/agent/brainCore.ts::normalizeDrumPatternArgs` (11 vitest pins).

### 2. Visibility failures — the model can't see what it's asked to change

`compactSnapshot` (the session rendering in the prompt) omits **buses, the
master chain, the tempo map and the key**. Measured costs:

- **master-trim** failed IDENTICALLY (Δ+1.0 dB) for every config: the native
  master fader defaults to **−3 dB** (probed), the models can't see it, so
  "pull it down a couple dB" became an absolute guess near −2 = *up* 1 dB.
- **rep-rogue-tempo** (remove the rogue tempo point): models can't see
  `session.tempoMap`, so they either deferred (grok) or reached for the wrong
  tool (gpt tried `delete_time_range`). The pipeline itself is fine — the
  scripted-stub smoke passes this task 4/4.
- **master-glue / eq-before-comp**: models called `list_builtins` then stalled —
  they can never observe the master chain they're editing.

**These depress every model equally and are harness work, not model work** —
the Phase-B loop lane owns enriching the snapshot (master, buses, tempoMap,
key) and these ~5 tasks should flip largely on visibility alone.

### 3. Reactive failures — explicit errors single-shot can't answer

After the shape fixes, the remaining compose-drums failures are all
self-describing native envelopes: `velocity must be 1-127 (got 0)`,
`track holds wave audio — a drum sampler would silence it; use a drum track`,
`lane "hat" (31 steps) doesn't divide the pattern (32 steps)`. A single shot
never sees them. Evidence the reactive layer works: with repair, grok FIXED a
string-typed `set_drum_lane` note on the second try (drums-mute-hat-lane
passed), and on drums-new-hats it genuinely *reacted* to the wave-track error —
with the wrong fix (`set_track_type` instead of a new track; the error copy
"use a drum track" arguably points there — candidate native-copy improvement).
This whole class is the Phase-B loop's home turf.

### 4. Genuine capability gaps

- **arr-split-dup** (split, then duplicate the NEW half): needs the post-split
  clip id → structurally impossible for single-shot. grok honestly deferred;
  gpt guessed. The designed multi-step prober working as intended.
- **mel-keys-in-key / note counts**: gpt under-composes (deferred or too few
  notes); grok went 4/4 on melody — a real model gap.
- **amb-upload** ("master this and upload it to spotify"): both gpt runs
  half-acted (loaded master plugins, exported) instead of deferring; grok
  deferred all 4 ambiguous tasks. Defer discipline differs by model.

## Caveats (read before comparing models)

- **n=1 per config.** gpt-5.4-mini is a reasoning-tier model that ignores
  temperature; its single-vs-repair gap (61.8 vs 58.8) is within run-to-run
  noise (±1-2 tasks). Treat sub-3pp deltas as noise until n≥3.
- The drum-shape fixes landed AFTER these four runs — the headline numbers
  measure the SHIPPED harness. Post-fix drum re-runs (`*-drumfix` scoreboards)
  show the next failure layer (reactive class), not instant wins: grok
  compose-drums went 0/4 → 1/4 with repair, with all remaining failures
  error-explicit.
- Mock substrate never gates a model verdict (it caught its own parity bug on
  day one — the mock's builtin list had drifted from native; fixed in A4).
- Before/after audio for the render-flagged tasks:
  `~/mosh-agentbench-artifacts/{gpt-5.4-mini-single, grok-4.3-single}/`.

## Re-run commands

```bash
cd ui && set -a && source ui/.env.local && set +a
BIN=../build-macos-arm64-release/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh
npm run agent-bench -- --runner single        --tag gpt-5.4-mini-single --bin "$BIN"
npm run agent-bench -- --runner single-repair --tag gpt-5.4-mini-repair --no-render --bin "$BIN"
npm run agent-bench -- --base https://api.x.ai/v1 --key-env XAI_API_KEY --model grok-4.3 \
  --runner single --tag grok-4.3-single --bin "$BIN"
# the full sweep, once an OpenRouter key exists (per model):
OPENROUTER_KEY=... npm run agent-bench -- --base https://openrouter.ai/api/v1 \
  --key-env OPENROUTER_KEY --model moonshotai/kimi-k2.5 --runner single --tag kimi-k2.5-single --bin "$BIN"
```

## What Phase B should take from this

1. **Snapshot enrichment first** (master, buses, tempoMap, key in the prompt
   rendering — behind the byte-stability gate): ~5 tasks are visibility-bound.
2. **The loop's observe-and-repair is worth ≥6pp on the best current model**
   (repair alone), and the reactive failure class is larger than repair can
   reach (repair re-makes mistakes without fresh observation; the loop won't).
3. Model ranking so far: grok-4.3 > gpt-5.4-mini as the cloud seat; re-rank
   after the OpenRouter sweep and re-measure everything with `--runner loop`
   once the loop exports its AgentRunner.
