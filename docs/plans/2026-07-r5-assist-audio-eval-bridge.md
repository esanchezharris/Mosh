# R5 Assist And Audio-Eval Bridge

## Purpose

This bridge connects the assist-command SFT work from the prior thread to the next
training job, and gives the musical/audio evaluator idea a controlled entry point.
It is a runbook for `s2-mix-v5` / `a3b-r5`; it permits non-MLX prep while r4
runs, but it is not permission to restart or modify the live `r4` job.

The rule is simple: audio evaluators can add measured sidecar evidence, but they
do not rewrite SFT labels, become a GRPO reward, or replace owner labels unless
they clear the existing owner-label/ranker gates.

## R4 Protection

- Check the live job only through `service/sft/monitor-r4.sh`.
- While r4 is running, do not start another `mlx_lm` job, fused-model server,
  generative service, SA3 run, or GPU audio-judge batch.
- Do not mutate `service/sft/.sft-data/s2-mix-v4`, `.adapters/a3b-r4`, or the
  detached r4 worktree runtime state.
- When r4 completes, run the registered gate read before building r5:
  `cd service/sft && ./run-gate-r4.sh`.
- Record the r4 result in `docs/bench/PROGRAM_STAGE1_2026-07.md` before starting
  `s2-mix-v5`.

## Source Map

Use the sibling worktree only as narrow source material:

- Source worktree: `.claude/worktrees/stoic-curran-f072be`.
- Port only the assist SFT exporter/data and the focused fast-path track-op patch.
- Do not merge or cherry-pick that worktree wholesale; it contains broad tutorial,
  teardown, synth, recipe, and UI changes unrelated to this bridge.
- Assist artifacts:
  - `ui/scripts/build_assist_sft.mts`
  - `service/sft/assist_demonstrations.jsonl`
  - `service/sft/assist_fixtures/{ledger.json,fixture_roles.json,fixture_snap.json}`
- Fast-path source:
  - `ui/src/agent/fastPath.ts`
  - `ui/src/agent/fastPath.test.ts`
  - `ui/src/ui/AgentComposer.tsx`

## R5 Prep While R4 Runs

1. Read the r4 monitor without auto-gating:

   ```sh
   cd service/sft
   ./monitor-r4.sh --no-gate
   ```

2. Audit the live r4 target before making any restart decision:

   ```sh
   cd service/sft
   python3 audit_r4_target.py --out .sft-data/s2-mix-v5-prep/r4_target_audit.json
   ```

   Required pass conditions: the monitor command targets `s2-mix-v4`; train and
   valid are `12889/1650`; v4 train contains the 155 `offset-coords.jsonl` rows
   and the 60 `render-routing.jsonl` rows; empty `r4-renderparam.jsonl` remains
   stale non-source material.

3. Regenerate assist demos from `ui/` when needed:

   ```sh
   cd ui
   npx tsx scripts/build_assist_sft.mts
   ```

4. Build the ready-to-run candidate from the detached r4 `s2-mix-v4` without
   touching r4 runtime files:

   ```sh
   cd service/sft
   python3 prepare_r5_prep.py
   ```

   This writes `.sft-data/s2-mix-v5-prep/manifest.json`, copies base train/valid,
   appends the 15 assist rows to train only, runs `filter_by_length.py` on the
   prep directory only, and records the evaluator sidecar path.

## R5 Dataset Sequence After R4 Gate

1. If r4 passes, hold `s2-mix-v5-prep` as optional future data.
2. If r4 misses the gate, promote the prepared candidate into the next r5 run
   plan instead of rebuilding from scratch.
3. If additional repaired rows are added after the gate, assemble the final
   `s2-mix-v5` with train-only assist rows:

   ```sh
   cd ui
   npx tsx scripts/assembleMix.mts \
     --base ../service/sft/.sft-data/<base> \
     --synth ../service/sft/.sft-data/synth \
     --assist ../service/sft/assist_demonstrations.jsonl \
     --out ../service/sft/.sft-data/s2-mix-v5 \
     --evaluator-sidecar ../service/sft/.sft-data/s2-mix-v5/evaluator_sidecar.jsonl
   ```

4. Run the length filter on the final new mix only:

   ```sh
   cd service/sft
   "$SFT_PY" filter_by_length.py \
     --model /Users/emiliosanchez-harris/AI/models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit \
     --data .sft-data/s2-mix-v5 \
     --max-seq 4096
   ```

5. Verify:
   - `assist_demo_rows` is 15 in `manifest.json`.
   - Assist rows are counted under `sources` and are present only in `train.jsonl`.
   - `valid.jsonl`, `test.jsonl`, and eval files remain inherited from the base or
     generated eval pipeline, not contaminated by assist demos.

## Evaluator Sidecar

Evaluator output is internal JSONL:

```json
{
  "id": "pack-006/beat-03",
  "audio_path": "/absolute/path/to/render.wav",
  "source_run": "era-001-pack-006",
  "features": {
    "audiobox_pq": 0.0,
    "audiobox_ce": 0.0,
    "audiobox_cu": 0.0,
    "audiobox_pc": 0.0,
    "clap_kept_centroid": 0.0,
    "clap_contrast": 0.0,
    "ranker_score": 0.0,
    "gemini": {
      "enabled": false,
      "model": null,
      "keep_probability": null,
      "defects": []
    }
  },
  "evaluator_versions": {
    "audiobox": "existing-judges-venv",
    "clap": "existing-clap-cache",
    "ranker": "taste_ranker",
    "gemini": null
  },
  "computed_at": "ISO-8601"
}
```

Initial feature policy:

- Audiobox axes, CLAP kept-centroid/contrast, and ranker score are the default
  sidecar features because they already have bench history in `docs/bench/`.
- Gemini is optional, key-gated, and bench-only. The relevant official docs are
  [Gemini audio understanding](https://ai.google.dev/gemini-api/docs/audio),
  [Gemini 3 Flash Preview](https://ai.google.dev/gemini-api/docs/models/gemini-3-flash-preview),
  and [Lyria 3 music generation](https://ai.google.dev/gemini-api/docs/music-generation).
  Gemini can inspect audio and return text/structured outputs; Lyria is a music
  generator, not an evaluator.
- Missing Gemini credentials should produce `"enabled": false`, not block the
  dataset build.

## Promotion Rules

- Owner labels remain the taste currency.
- Evaluator scores do not directly mutate SFT targets or assistant completions.
- Evaluator scores may be used for pack/ranker feature research, best-of-n
  ranking after existing gates, archived preference pairs for later DPO, and
  defect filters only after benchmark evidence.
- No evaluator becomes scorer power unless it beats the current ranker on the
  owner-labeled validity sets and satisfies the pre-registered pack-side rules in
  `docs/bench/RANKER_PROMOTION.md` and `docs/bench/MUSIC_EVAL_RESEARCH.md`.
- GRPO stays frozen unless the registered resurrection conditions are met:
  enough candidate-group reward variance and a scorer that has beaten the ranker.

## Verification Checklist

- `service/sft/monitor-r4.sh` shows r4 state and no action is taken against the
  running dataset.
- `service/sft/audit_r4_target.py` returns `restart_decision: continue-r4`
  unless the target is proven wrong or incomplete.
- `service/sft/prepare_r5_prep.py` creates `s2-mix-v5-prep` only, with train
  `12889 + 15` before filtering and valid `1650`.
- `cd ui && npx tsx scripts/build_assist_sft.mts` writes exactly 15 rows.
- Assist rows pass `parseReply` round-trip and `validateCommand` checks inside
  the exporter.
- Focused fast-path tests pass, including the complement case:
  `"mute everything but the drums and bass"`.
- The next mix manifest records `assist_demo_rows`, `assist_demo_source`, source
  hashes, and optional `evaluator_sidecar`.
- Any evaluator adoption claim points to a regenerated bench table, not to an
  uncalibrated model score.
