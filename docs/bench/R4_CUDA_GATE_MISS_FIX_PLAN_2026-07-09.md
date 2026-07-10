# r4 CUDA gate-miss fix plan

Date: 2026-07-09
Source readout: `service/sft/GATE_READ_a3b-r4-cuda.md`
Model/run: `a3b-r4-cuda`, RunPod `gc3v0gpji7xskt` (terminated; adapter archived at `~/AI/adapters/a3b-r4-cuda-pull`)

> Provenance: reconstructed 2026-07-09 during the Codex→Claude consolidation from the
> Codex session log (original file lost to iCloud `.git` corruption). Plan text verbatim;
> status annotations added at reconstruction time.

## Decision

Do not restart local `r4` or relaunch a new CUDA training run for this miss.
The aggregate and grounded bars passed; the miss is a per-command floor issue.
Fix runtime/apply evidence first, then rerun the same gate surfaces against the
existing adapter before deciding whether new SFT data is needed.

*(Owner confirmed this ordering 2026-07-09: "fix-first, then informed r5.")*

## Current miss

- Aggregate(A,C): `0.8891430817610063` passes.
- Grounded section B: `0.9189` passes.
- Overall gate misses on per-command floors:
  `build_skeleton_from_clip = 0.0` · `sketch_beatbox = 0.0` · `split_clip = 0.0` ·
  `assign_sample = 0.333` · `load_drum_kit = 0.333` · `set_track_type = 0.417`

## P0: apply/runtime failures, no training

Commands: `build_skeleton_from_clip`, `sketch_beatbox` — signature `window is not defined`.

1. Extract the failing evalA rows from `eval_results.a3b-r4-cuda-A-tunnel-serial.json`.
2. Build a minimal replay applying only the generated command payload to the same
   non-browser harness used by the gate.
3. Identify where the browser global leaks in (command adapter vs helper vs shared UI code).
4. Fix the runtime boundary (prefer moving pure command logic out of browser-dependent code).
5. Add regression coverage running without a browser.

**Status: LANDED — PR #275** (`scheduleMock` → `globalThis.setTimeout` in `bridge.mock.ts`
+ Node-replay regression tests for both commands).

Acceptance: both commands apply cleanly in the replay; gate rerun shows no
`window is not defined`; floors clear without changing model weights.

## P1: split-point normalization

Command: `split_clip` — signature `split point outside clip`.

1. Bucket failing rows by split value, clip start/duration, tempo, and unit
   (seconds/beats/bars/ticks/samples).
2. Normalize split points at the MoshOps boundary: convert to project seconds before
   validation; treat clip-local values as `clip.start + localOffset`; epsilon on exact
   boundaries; reject only truly-outside values with a resolved-point error.
3. Tests: local seconds with nonzero clip start; beat/bar conversion through tempo;
   exact boundaries; clearly-outside still rejected.

**Status: OPEN** (candidate follow-up work; not covered by any open PR as of 2026-07-09).

## P2: command-family semantics and data

Commands: `assign_sample`, `load_drum_kit`, `set_track_type`.

1. Audit failures only after P0/P1 land (avoid runtime-error contamination).
2. Bucket into: ambiguous target selection / missing prerequisite track ops /
   asset lookup failures / legitimate deferrals.
3. Tighten tool semantics before adding examples.
4. Add SFT rows only for behavior still model-caused after runtime fixes
   (candidate rows staged at `service/sft/a3b-r4-cuda_next_run_examples.*`).

**Status: OPEN.**

## Rerun order

1. Targeted replays for the six failing command families.
2. Rerun evalA against `a3b-r4-cuda` (same adapter, from the local archive).
3. Rerun frozen300 with the timeout-safe harness used in the gate readout.
4. Rerun grounded section B.
5. Update `GATE_READ_a3b-r4-cuda.md` with before/after per-command floors.
6. Decide what folds into `r5`; do not mutate the completed `a3b-r4-cuda` artifact.
