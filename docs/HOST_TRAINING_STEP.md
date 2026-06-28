# Hosting the training step — Rung-2 GRPO (musical reward)

*The culmination join: optimize the SFT'd command-emitting **policy** (this branch) with
Ytripper's **musical Reward** (the teardown→reward thread, `claude/musing-herschel-c0501d`).
This doc is the verified map + the decided plan. Status lives at the bottom.*

## Why

We have two halves of an on-device agent-training system that have **never met**:

- **The policy + the loop** (this branch `claude/funny-mendel-aeca12`): an SFT'd local
  Qwen3-4B LoRA (0.62 clean-apply) + a Rung-1 GRPO trainer (`service/rl/grpo.py`,
  `ui/src/rl/`, `ui/scripts/rl/`) whose reward is the **deterministic clean-apply verifier**
  (mock backend, **no audio**).
- **The reward** (Ytripper, `claude/musing-herschel-c0501d`, `service/teardown/`): tutorial →
  Recipe → reward; `flywheel/reward.py` exposes **`Reward`** (`score_audio` + `composite`,
  floor = our `quality_readout` PQ, pull = MERT proximity to exemplars) and **`PromptFeed`**
  (guaranteed-renderable, teardown-seeded MoshOps programs). `flywheel/__init__.py` states it
  plainly: *"the versioned Reward/PromptFeed interface the GRPO loop consumes."* **The handoff
  was built for our loop.**

"Hosting the training step" = building the **missing middle** so the GRPO loop can score a
rollout by its **rendered audio**, sealing every gap between the two halves — **without
touching the trainer's math** (advantage / KL leash / gate / checkpoint stay byte-identical).

## The contract (verified against source, not agent-claimed)

- `grpo.py` consumes **only** `rewards.jsonl` lines `{sampleId, reward∈[0,1], deferred}`. That
  JSONL boundary — not `score.ts` — is the true swap seam. Rung 2 = a different scorer script
  writing the **same** lines, selected by an env flag. One-line change in `grpo.py`.
- `Reward.score_audio(y,sr)` → `{pq, clean[, pull]}`; `composite` = `clean × (0.5·pq/10 + 0.5·pull)`,
  and when `pull` is absent it defaults to `pq` → **floor-only reward = `clean × pq/10`**.
- `Oracle.render(commands)` already shells `Mosh --run-script` (JSONL via `MOSH_RUN_SCRIPT`),
  lands an `export_audio`, and reads the WAV with soundfile. **commands→WAV→scalar is ~80% built.**
- The genuinely missing piece: **policy reply text → MoshOps `{command,args}` program JSONL.**

## Decisions (locked 2026-06-27)

1. **First real run = FLOOR-ONLY** — reward = loudness-normalized DSP-hygiene PQ + clean, MERT
   `pull` disabled. De-risks the whole render→reward→trainer pipeline with **no torch/MERT
   dependency**. The musical head swaps in once the plumbing is proven.
2. **Musical pull (later) = GLOBAL anchor set** — one curated "good music" exemplar corpus
   embedded once, reused for every rollout. No change to RL prompt data.
3. **DoD = DUAL-METRIC** — the frozen clean-apply gate becomes a *must-not-regress guardrail*;
   the headline is a held-out **musical-reward delta** vs the SFT baseline. Tradeoffs surfaced.
4. **Render path = DETERMINISTIC ONLY** — MIDI→built-in instrument→export (proven stable WAV
   checksums). SA3/RAVE excluded from the reward loop for now (sub-percent drift = reward noise).

Plus the Rung-1 lesson (run1 stalled at step 6/60 with `signal=0/4` — group reward saturated at
1.0 → zero advantage): for Rung-2, **raise sampling temperature** and **source prompts from
`PromptFeed`** (guaranteed-renderable) to restore advantage variance.

### What the floor-only reward actually measures (verified P0)

`composite` floor-only = `clean × pq/10`, where `clean` is **binary** (`quality_readout` raises
*any* flag → 0). `quality_readout` is a **spectral-balance / signal-hygiene** readout (loudness,
clipping, dynamics, spectral centroid/rolloff, silence-gaps). Measured on synthetic audio:

| render | pq | flags | reward |
|---|---|---|---|
| pure bass sine | 5.86 | `muddy: low rolloff` | 0 |
| rich chord + harmonics + dynamics | **7.91** | none | **0.79** |
| all-treble drum bursts | 5.50 | `harsh: high centroid` | 0 |

So floor-only is a real (if coarse) signal: it rewards **full-spectrum, balanced, hygienic
arrangements** and zeros thin/harsh/imbalanced ones. It gives gradient **only when the prompt
pool yields renders that span the clean boundary** — sharpening the case for PromptFeed prompts +
higher temperature. **P4 must watch for binary-`clean` saturation** (a group rendering all-0 or
all-clean-with-flat-pq → zero advantage); if it saturates, soften `clean` to graded or lean on
PromptFeed richness. This is the floor-only analog of run1's saturation and the thing to monitor.

## Restructure (all additive — no existing file edited except a 1-line env switch)

- **Land the reward, self-contained:** path-cherry-pick `service/teardown/` from
  `claude/musing-herschel-c0501d` onto this branch. `service/teardown/` does not exist here →
  zero conflict. Pins a reviewable snapshot of the reward contract.
- **New bridge files:**
  - `ui/src/rl/replyToProgram.ts` — reuse the gepa reply parser to turn a policy reply into
    `BoundCommand[]`, serialize to run-script JSONL, append `export_audio`. Malformed/empty →
    reward 0, deferred true (mirrors the clean-apply "acts-shy" rule, keeps tripwires firing).
  - `service/rl/score_audio_cli.py` — batch render+score: consult a **pre-render program
    fingerprint cache**, render misses (bounded 3–4 parallel, unique `MOSH_SELFTEST_SESSION`
    each), score all WAVs with MERT loaded **once** (for the musical run), write the exact
    `{sampleId,reward,deferred,feedback}` lines. Render failure (nonzero `--run-script` exit) →
    reward 0, deferred.
  - `ui/scripts/rl/scoreRolloutsAudio.mts` — same CLI shape as `scoreRollouts.mts`; builds
    per-rollout program JSONL and drives the Python scorer.
- **`service/rl/grpo.py`:** one line — pick the scorer script from `MOSH_RL_REWARD=audio|symbolic`.
- **`service/rl/run_grpo.sh`:** pass `MOSH_RL_REWARD`, `MOSH_BIN`, `TEARDOWN_PY`.

### The three feasibility must-dos (else a full run balloons)

1. **Pre-render fingerprint cache** — sha256 of canonical `{command,args}` (minus export path),
   checked *before* spawning Mosh. Collapses duplicate programs within/across steps (large hit
   rate as the policy converges). The single biggest wall-clock lever.
2. **Warm MERT** (musical run only) — load once per run in one persistent process, never per
   rollout (~1s vs ~6s/score).
3. **Bounded parallel deterministic renders** — 3–4 native processes, isolated sessions/ports.

**Feasibility verdict:** FEASIBLE on M1 Max. Audio scoring adds only ~+15–40s/step warm-cached;
a 60-step run ≈ 5.5–6.5h (~+1–1.5h over a Rung-1-equivalent). MLX sampling, not the reward, is
the wall-clock bottleneck. Floor-only needs **no** torch at all.

## Plan (gated phases — each gates the next on a real signal)

- **P0 — Host landing.** Cherry-pick `service/teardown/`; create a **light** venv
  (numpy/scipy/soundfile/librosa) → `.teardown.env`. **Gate:** `Reward.score_audio` + `composite`
  on a hand-fed WAV returns a sane [0,1]; `import quality_readout` resolves.
- **P1 — Prove reply→program→WAV→reward in isolation (no trainer).** `replyToProgram.ts` +
  `Oracle.render` on a known-good MIDI program via `/Applications/Mosh.app` `--run-script`.
  **Gate:** same program → byte-identical WAV across 3 runs; a real sampled policy reply
  round-trips to a renderable program + scalar with no manual fixup.
- **P2 — Batch render+score CLI** (warm process, pre-render fingerprint cache, bounded parallel).
  **Gate:** a 24-rollout batch scores within budget and emits the exact `rewards.jsonl` schema;
  a repeated program is a cache hit (no second Mosh spawn).
- **P3 — Wire the swap behind `MOSH_RL_REWARD` + smoke the trainer.** `grpo.py --smoke` on the
  audio reward. **Gate:** a full step runs sample→reply→program→render→Reward→advantage→update
  with non-degenerate reward variance in ≥1 group.
- **P4 — (gated on Ytripper consult) short real run.** Floor-only, ~15–30 steps, higher temp,
  `PromptFeed` prompts. **Gate:** `signal_groups > 0` consistently (Rung-1 saturation fixed),
  reward μ trends up, clean-apply guardrail holds.
- **P5 — (gated) full run + honest DoD.** 60–150 steps, checkpoint-on-best; report the frozen
  clean-apply gate (vs SFT 0.62 via `dod_compare.py`) **and** the held-out musical-reward delta.

P0–P3 build the host (buildable now). P4–P5 are the actual training step — **gated on the
Ytripper consult**, per the owner.

## Status (built 2026-06-27)

The host is built and proven through P3 (the actual run, P4–P5, stays gated on the Ytripper consult).

- **P0 ✅** `service/teardown/` cherry-picked (113 files, additive). Torch-free venv (`.teardown.env`).
  Gate: `Reward.score_audio`+`composite` on real audio → sane [0,1], zeros broken/clipped/silent.
- **P1 ✅** `ui/src/rl/replyToProgram.ts` (reply→program, 6 tests) + `ui/src/rl/buildRenderProgram.ts`
  (id-remap by mock-env: `bind`→`capture`, `$ref`/concrete-id→`${VAR}`, 5 tests). **Isolation gate:**
  a real render through `/Applications/Mosh.app` is **byte-deterministic across 3 runs** + non-silent,
  scored by `Reward`. Confirmed floor `clean` is a spectral-balance gate (full beat clean / sparse or
  thin → flagged) → real reward variance.
- **P2 ✅** `service/rl/score_audio_cli.py` (warm Reward, pre-render fingerprint cache, render-fail →
  reward 0) + `ui/scripts/rl/scoreRolloutsAudio.mts` (builds programs, handles deferrals, shells the
  scorer). **Integration gate:** a 3-rollout batch through the full bridge → `{groove:0, sparse:0.721,
  defer:0/deferred}` — id-remap correct (0 render-fails), **reward variance in the group → gradient**.
- **P3 ✅/⏳** `grpo.py` selects the scorer by `MOSH_RL_REWARD=audio` (1-line, trainer math untouched);
  `run_grpo.sh` gains `REWARD=audio REWARD_MODE=floor` (sources `.teardown.env`). Minimal renderable
  scaffold `ui/scripts/rl/buildAudioSmokePrompts.mts` → `.rl-data/rl-audio-smoke` (drum tasks).
  Gate: `grpo.py --smoke` end-to-end on the audio reward (in progress at time of writing).

Verification: tsc clean, vitest **626** (+11 RL). Run the host: `REWARD=audio REWARD_MODE=floor
RL_TAG=rl-audio-smoke service/rl/run_grpo.sh` (floor-only; no torch). Swap to `REWARD_MODE=musical`
once a `reward_head.json` + global exemplars are attached (P4/P5, gated on the consult).

## Provenance

Reward snapshot cherry-picked from `claude/musing-herschel-c0501d` @ `5b197b1a`. A live,
fully-set-up reward venv (torch 2.12.1 + transformers 5.12.1) and a trained `reward_head.json`
already exist in the sibling worktree `sleepy-euler-de0f10` (same branch) — reusable for the
musical run without re-downloading. `MOSH_BIN=/Applications/Mosh.app/Contents/MacOS/Mosh`.
