# a3b-r5-cuda gate-read

Date: 2026-07-10
Model id: `a3b-r5-cuda`
RunPod pod: `szln5r26qdy66j` (A100 80GB; terminated 2026-07-10 after adapter archival)
Outcome: **gate PASS** — one clean read, no retry, per §P9.

## Training result

- Completed cleanly: `12994/12994` (1.0 epoch of s2-mix-v5)
- Runtime: `21479s` (`5h 58m 59s`)
- Final train summary: `train_loss 0.06349`, `mean_token_accuracy 0.9743`
- Recipe (from `sft_run.json`, verbatim §P9): bf16 LoRA on
  `Qwen/Qwen3-30B-A3B-Instruct-2507`, batch 1, lr 1e-5, lora-r 16,
  last-16-layers (32–47), seq 4096, assistant-only loss, grad-checkpoint.
- Dataset: `s2-mix-v5` (train 12,994 / valid 1,650), train sha `3c4e2e8b2ecc3562…`.

Training artifact:

- Remote adapter dir (at read time): `/workspace/ClaudeMosh/service/sft/.adapters/a3b-r5-cuda`
- Local archive (pulled before termination): `~/AI/adapters/a3b-r5-cuda-pull/a3b-r5-cuda`
- `adapter_model.safetensors` sha256 `76f8db52ef732734ce261063df197294f4c605a820bd6905e9854d0cd2f56b08`
  — verified identical Mac ↔ pod before the pod was terminated.

## Serve / shutdown

- `serve_openai.py` served the base + r5 adapter on the pod (`ready: … on cuda:0`);
  `/v1/models` returned `a3b-r5-cuda`; a minimal completion smoke returned `ok`.
- All four gate legs ran through an `ssh -L 18000:127.0.0.1:8000` tunnel.
- Pod terminated via `podTerminate` after the read; volume no longer exists.

## Gate surfaces

All reads through the post-#286 harness (mock length-fidelity fixed), tags
`a3b-r5-cuda-{diagfloor4,A,C}` + `a3b-r5-cuda` (§B).

### diag_floor4 (split_clip floor)

- Clean-apply: `0.895` (1 deferral / 19)
- Report: `~/Library/Mosh/work/gate/rerun-evals/eval_results.a3b-r5-cuda-diagfloor4.json`

### evalA (210-row core)

- Clean-apply: `0.9357` (5 deferrals / 210)
- Report: `~/Library/Mosh/work/gate/rerun-evals/eval_results.a3b-r5-cuda-A.json`
- **Target floors (r4 → r5):** `assign_sample 0.333 → 0.667 ✓` · `load_drum_kit 0.333 → 0.750 ✓`
- Other families that moved: `set_track_type 0.500 → 0.750`.
- Worst measurable family: `sketch_beatbox 0.500` (pre-excluded mock-broken per §P8;
  at floor regardless). Every other family ≥ `0.667`. `build_skeleton_from_clip 1.000`
  (the #275 window fix holds).

### frozen300 (§C)

- Clean-apply: `0.977` (6 deferrals / 300)
- Report: `~/Library/Mosh/work/gate/rerun-evals/eval_results.a3b-r5-cuda-C.json`

### grounded section B

- Positives clean: `33/37`
- Grounded clean-apply: `0.8919`
- Negative defer rate: `8/20 = 0.40`
- Wrong defers: `12`
- Class tally: `validation: 2` · `apply-error: 6` · `invented-file: 2`
- Report: `~/mosh-bench-artifacts/eval-v2/sectionB.a3b-r5-cuda.default.json`

> §B binary provenance: the pre-registered `build-233` binary directory had been
> deleted from `~/Library/Mosh/work/gate3/` (a stray build-clean, not this run).
> §B was run against a **faithful rebuild** from the gate3 source at HEAD — which
> carries P1 (`77ac5290`, split normalization) as a verified ancestor — using the
> `macos-arm64-debug` preset. `/Applications/Mosh.app` (built 11:45, before P1
> merged 20:03) was rejected as unfaithful.

## Gate decision

- `aggregate(A,C) = (0.9357 + 0.977) / 2 = 0.9563` — **passes** (≥ 0.75).
- `§B = 0.8919` — **passes** (≥ 0.85).
- **Per-command floors:** every measurable evalA family ≥ 0.5; the two model-caused
  targets from the r4 rerun (`assign_sample`, `load_drum_kit`) both cleared decisively
  (0.667, 0.750). **All floors pass.**
- ⇒ **Overall gate: PASS.**

## Honest caveats (as registered / observed)

1. **§B negative-defer traded slightly.** r4 → r5: `negativeDeferRate 0.45 → 0.40`,
   `deferredWrong 11 → 12`, `apply-error 5 → 6`. This is the *expected* direction of
   the r5 intervention — the corrective batch suppresses over-deferral on explicit
   asks, so the model defers less overall. Grounded clean-apply held **identical**
   (0.8919), so the positive-side win did not come at a net §B cost. Not gating, but
   the axis to watch on the next cycle is "eager-apply on genuine negatives."
2. **frozen300 dipped 0.989 → 0.977** (trivial; well above any threshold; no v5 rows
   touched those families).
3. **Floor families are n=3–6** — one row flips a floor. `assign_sample` is 2/3 and
   `sketch_beatbox` 1/2; reads reported with counts, not rates alone.
4. The base is the bf16 HF model (CUDA lane), same as the r4-cuda read this is
   compared against — not the 4-bit MLX base named in §P8's local recipe.

## Disposition

r5 is the **new best adapter** for the A3B local-agent seat: it clears the full
§P9 gate that r4 missed, on the exact same lane and comparison harness, with the
two model-caused floors that motivated the run both resolved. Archived locally;
pod terminated. Total r5 cost ≈ $8.6 (train + serve/gate + rebuild idle).
