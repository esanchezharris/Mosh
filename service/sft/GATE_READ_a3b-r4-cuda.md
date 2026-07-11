# a3b-r4-cuda gate-read

Date: 2026-07-09
Model id: `a3b-r4-cuda`
RunPod pod: `gc3v0gpji7xskt` (terminated 2026-07-09 after adapter archival; see Provenance)
Outcome: gate miss

> Provenance: this file was reconstructed on 2026-07-09 during the Codex→Claude
> consolidation from the Codex session log (the original write was lost to the
> iCloud `.git` corruption — see `docs/CONSOLIDATION_2026-07-09.md`). Numbers are
> verbatim from the recorded gate read; eval report JSONs cited below exist on
> disk and corroborate them.

## Training result

- Completed cleanly: `12889/12889`
- Runtime: `17972.4s` (`4h 59m 32s`)
- Final train summary: `train_loss 0.06465`, `mean_token_accuracy 0.9894`
- Final logged step band ended at:
  - `loss 0.01762`
  - `grad_norm 0.01179`
  - `mean_token_accuracy 0.9900`

Training artifact:

- Remote adapter dir (at read time): `/workspace/ClaudeMosh/service/sft/.adapters/a3b-r4-cuda`
- Local archive (post-consolidation): `~/AI/adapters/a3b-r4-cuda-pull/.adapters/a3b-r4-cuda`
  (full dir incl. checkpoints + train/serve logs, pulled before pod termination)

## Serve / shutdown

- `serve_openai.py` smoke check passed:
  - `/v1/models` returned `a3b-r4-cuda`
  - minimal completion returned `{}`
- Serve process was stopped after the gate read.
- Pod stop was issued through `runpod_r4.py stop`; final provider state `desiredStatus=EXITED`.
- Pod resumed once on 2026-07-09 (consolidation) solely to pull the adapter, then stopped
  and **terminated** — the volume no longer exists.

## Gate surfaces

### evalA

- Clean-apply: `0.7924528301886793`
- Deferrals: `25/265`
- Report: `.claude/worktrees/intelligent-banach-25ad5f/service/sft/.sft-data/eval-v2/eval_results.a3b-r4-cuda-A-tunnel-serial.json`

### frozen300

- Clean-apply: `0.9858333333333333`
- Deferrals: `1/300`
- Report: `.claude/worktrees/intelligent-banach-25ad5f/service/sft/.sft-data/frozen300/eval_results.a3b-r4-cuda-C-tunnel-custom.json`

### grounded section B

- Positives clean: `34/37`
- Grounded clean-apply: `0.9189`
- Negative defer rate: `9/20 = 0.45`
- Wrong defers: `11`
- Class tally: `validation: 1` · `apply-error: 5` · `invented-file: 2`
- Report: `~/mosh-bench-artifacts/eval-v2/sectionB.a3b-r4-cuda.default.json`

## Gate decision

- `aggregate(A,C) = 0.8891430817610063` — passes.
- `§B = 0.9189` — passes.
- **Per-command floor fails ⇒ overall gate MISS.**

Worst evalA command floors:

- `build_skeleton_from_clip = 0.0`
- `sketch_beatbox = 0.0`
- `split_clip = 0.0`
- `assign_sample = 0.3333333333333333`
- `load_drum_kit = 0.3333333333333333`
- `set_track_type = 0.4166666666666667`

**Reconstruction note (precision):** §P8's pre-registration EXCLUDED
`build_skeleton_from_clip`/`sketch_beatbox` from the measurable floor set up front
(the "mock-broken" amendment) — their 0.0 rows are informational, not gating. The
miss stands regardless on the measurable floors: `split_clip 0.0`, `assign_sample
0.33`, `load_drum_kit 0.33`, `set_track_type 0.42` — all < 0.5.

## Most likely next-run fixes

1. Fix harness/runtime apply failures before retraining:
   `build_skeleton_from_clip` and `sketch_beatbox` fail on `window is not defined` —
   an apply/runtime bug, not a model-quality signal. *(Fixed post-read by PR #275.)*
2. Fix split-point normalization: `split_clip` mostly failed with
   `split point outside clip` — time-resolution / clip-bound conversion issues.
3. Tighten command families mixing track creation/type-change/load:
   `load_drum_kit`, `set_track_type`, `assign_sample` need better coverage +
   clearer tool semantics.

## Caveat

The stock `evalSft` client stalled on the `frozen300` tunnel path in a long-lived
socket wait. The recorded `frozen300` score came from a drop-in harness reusing the
same prompt builder and scorer (`buildExamplePrompt` + `scoreReply`) with per-example
timeouts and progress output. `evalA` and `§B` used the normal repo surfaces.

## Post-read decision (owner, 2026-07-09 consolidation)

**Fix-first, then informed r5**: land the harness fixes (PR #275 et al.), re-run the
gate surfaces against this same `a3b-r4-cuda` adapter (now archived locally), and only
fold new SFT rows into r5 for misses that survive as genuinely model-caused. Recorded
in `docs/bench/R5_TRAINING_DECISION_2026-07-09.md` (addendum) and PROGRAM_STAGE1 §R.

> **2026-07-10 addendum:** the fixed-harness RERUN of this read (same adapter, sha-verified) cleared split_clip (0.833) and set_track_type (0.500) as harness-caused; assign_sample/load_drum_kit remain model-caused → informed r5 (§P9). Full record: [R4_RERUN_AMENDMENT.md](R4_RERUN_AMENDMENT.md).
>
> **2026-07-10 — superseded by r5:** the informed r5 run **PASSED** the §P9 gate on one clean read — `assign_sample 0.333→0.667`, `load_drum_kit 0.333→0.750`, agg(A,C) 0.9563, §B 0.8919. r5 is the new best A3B adapter. Full read: [GATE_READ_a3b-r5-cuda.md](GATE_READ_a3b-r5-cuda.md).
