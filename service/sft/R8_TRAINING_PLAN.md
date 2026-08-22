# R8 — Consumer size ladder (pre-registration)

*Drafted 2026-08-18, while r7 trains. Owner approved the program direction and the
parallel PC leg the same day ("yes, I'm turning on my PC now so we can try that out
in parallel"). This memo freezes the r8 design BEFORE any r8 gate is read, per the
standing pre-registration discipline (`R6_FREEZE_MEMO.md` §6.5 precedent).*

## 1. Question

The r5/r7 base (Qwen3-30B-A3B, 4-bit ≈ 19 GB) only runs on 32 GB+ machines. Most
consumers have less. **What is the smallest base that, SFT'd on the exact same
frozen mix, stays within the acceptable-quality band on the novice-jam bench?**

Explicitly NOT the question: how far the 30B can be quantized below 4-bit. That
axis is closed by prior evidence — the r5 read (`LOCAL_SERVE_READ_a3b-r5-mlx.md`)
showed 4-bit MoE experts alone flip commands (`add_note`→`add_drum_pattern`);
sub-4-bit degrades experts unevenly and silently. 4-bit is the shipping floor.
The shrink axis is **model size at fixed 4-bit serve precision**.

## 2. Ladder legs

Same frozen data for every leg — `s2-mix-v6-prep`:
- `train.jsonl` 13,113 rows, sha256 `9e8853344d2ac111ae6da5f239b71017b97815f394d6335fae94a9aa4549dbaf`
- `valid.jsonl` 1,650 rows, sha256 `9047ab96fd7e8f7f2155d6acc9c9b391c7989ed6205d119c46be764dfa4f3638`

| Leg | Base | 4-bit serve RAM | Train lane | Status |
|-----|------|-----------------|-----------|--------|
| r8-4b | `Qwen/Qwen3-4B-Instruct-2507` | ~2.4 GB | PC CUDA (12 GB VRAM), NF4 QLoRA | approved to start now, parallel with r7 |
| r8-8b | `Qwen/Qwen3-8B` (or -Instruct-2507 if released) | ~4.7 GB | PC CUDA if it fits, else Mac MLX after r7 | after r8-4b reads |
| r8-14b | `Qwen/Qwen3-14B` | ~8.5 GB | Mac MLX (post-r7) | only if 8B misses the band |

Descend-until-break is the default read order (4B first — cheapest, biggest
consumer win). If 4B lands in the band, 8B/14B become optional confirmations,
not requirements.

## 3. Recipe (all legs)

- LoRA rank 16, attn-only keys (q/k/v/o), dropout 0.05, lr 1e-5 (MLX) /
  script default (CUDA lane, recorded in its `run_config.json`), 1 epoch,
  batch 1 (MLX) / script default (CUDA), grad checkpointing, prompt-masked loss
  (`mask_prompt` on MLX, `assistant_only_loss` on CUDA).
- **`max_seq_length`/`--max-seq-len` = 6400 on every leg, no exceptions.** The
  119 coverage rows are ~6,050–6,250 tokens; at the old 4096 cap they truncate to
  all-masked and the loss goes NaN (this killed two r7 launches — root cause and
  RED-proof recorded in `R7_FREEZE_MEMO.md` post-freeze notes, 2026-08-18).
- **Launch smoke, required before any full run:** ≥20 iters trained directly on
  the 119 coverage rows (the r7 poison-row smoke pattern). Finite loss required.
  A full run may not launch without this smoke passing on that lane.
- A NaN watcher (or `--save-steps` + log monitoring on CUDA) must be armed for
  the full run's duration.

## 4. Precision-matching policy (the r5 lesson, applied per lane)

Serve target for every leg is **MLX 4-bit on macOS**.
- Mac-trained legs (MLX LoRA on the 4-bit base): train/serve precision matched
  by construction — adapter serves directly on the 4-bit base.
- PC-trained legs (CUDA NF4 QLoRA): NF4 ≠ MLX group-quant 4-bit. The bench read
  MUST use the proven **attn-overlay hd-fuse** path (the r5 fix) — never a naive
  fuse into 4-bit, never a bf16 overlay on an 8-bit base (both refuted by the
  2026-08-18 2×2). If the hd-fused 4B shows precision artifacts (command-flip
  class), the fallback is re-training that leg on the Mac in MLX post-r7 —
  a lane swap, not a recipe change, recorded as a dated note.

## 5. Gate (read on the novice-jam bench, 25 tasks, acceptability rubric)

Reference numbers: r7's gate read (pending, vs its own 16/25 baseline) and the
frontier zero-shot line (13/25 = 52%).

- **PASS (shipping candidate):** leg scores within **2 tasks** of the r7 read,
  AND ≥ the frontier zero-shot line (≥13/25).
- **PARTIAL:** ≥13/25 but >2 tasks below r7 → leg is a floor datapoint; next
  size up becomes the candidate; a distill pass (teacher-generated data from the
  tuned 30B, validator-filtered) is the registered follow-up option to close
  the gap on this leg — as a NEW cycle, not a silent r8 edit.
- **MISS:** <13/25 → the size is below the viability floor; record and stop
  descending.
- Serving latency is part of the read: report median s/call from the bench run;
  a leg that grades acceptable but exceeds ~10 s median per call on the M1 is
  PARTIAL at best (novices won't wait).

Three named r7 misses (drum flows, lyric follow-through, create_section
ambiguity) are tracked per-leg, same as r7's memo requires.

## 6. What r8 does NOT change

- r7 continues untouched to completion and its frozen gate read comes first.
- No new training rows — the mix is frozen (any corrective data = a future
  cycle's pre-registration).
- No sub-4-bit quantization experiments on any base.
- The 30B stays the pro-tier/teacher model regardless of r8's outcome.

## 7. Disposition (fill after reads; do not edit §1–§6)

- **r8-4b lane swap, 2026-08-18 (pre-gate, owner-approved):** the PC CUDA lane is
  DEAD for this recipe. The 4070 SUPER (12 GB) cannot reliably hold the 119
  6,400-token rows: the poison-row smoke passed (20/20 steps, loss 1.766 finite,
  liger fused-CE required to get even that far), but the full run hard-OOM'd at
  optimizer step 24/1640 — a checkpoint-backward allocation of 4.45 GiB with the
  allocator already spilled to 19.1 GiB via WDDM shared memory. Long-row steps on
  this card are allocator roulette (survival depends on fragmentation and row
  order), and the spill also made them ~7.5 min/step vs ~4.5 s for short rows.
  Owner chose the §4 fallback over a split-phase or retry lane: **r8-4b trains on
  the Mac in MLX on the 4-bit base after r7 completes** — precision-matched to the
  serve target by construction, ~15–22h at 4B size. The NaN-safety half of the
  smoke DID transfer: max-seq-len 6400 is finite-loss on the CUDA lane too.
  Artifacts kept on the PC (C:\r8: venv, data, HF model cache) for possible
  short-row-only uses; nothing is running there.
- r8-4b: ‹TBD›
- r8-8b: ‹TBD›
- r8-14b: ‹TBD›
- Shipping target decision: ‹TBD›

- **Final r7 comparison read, 2026-08-20:** r7 completed all 13,113 steps,
  but its one clean novice-jam read landed at `8/25` acceptable (`12/25` goal
  success), below its own 16/25 gate. Therefore the r8 comparison-band clause
  is non-limiting at 4B: the still-binding frontier floor is `>=13/25`, with
  median call latency `<=10s`. Full r7 evidence is in
  `GATE_READ_a3b-r7-mlx.md`; no r8 threshold or frozen recipe changed.

- **r8-4b local MLX poison-row smoke, 2026-08-20 — PASS:** downloaded
  `mlx-community/Qwen3-4B-Instruct-2507-4bit` (`model.safetensors` sha256
  `2a73c6c248601ab904e035548abd8e6abb65ea27dcb5f342fb0a8910eb44173f`)
  and trained 20/20 steps directly over all 119 coverage rows (each split
  sha256 `392262600bc922b17fa863cdd5b26362f38fb24daa0b57ed3f57ac06ccb60150`).
  Step 20 train loss `1.219`, validation loss `2.963`, peak memory 16.512 GB;
  finite-loss scan passed and the final/step-20 adapter sha256 is
  `ecfc46f3cebdbc32d04dba4b78f52374733c55a7e5f023ecd84b987f2fc04255`.
  Repro configs: `R8_4B_MLX_SMOKE.yaml` and `R8_4B_MLX_FULL.yaml`.

- **r8-4b full MLX run interruption, 2026-08-21 — external launcher loss,
  checkpoint preserved:** the healthy run reached iter 7,520/13,113 with finite
  train loss `0.062` and 16.533 GB peak memory, then its MLX process and parent
  shell disappeared without a traceback, NaN/Inf alert, logged training error,
  crash report, disk-pressure event, or memory-pressure event. Runtime timing
  identifies the blocker: `r8-4b-train.log` last changed at 15:29:55 -0700,
  while the ChatGPT/Codex desktop host restarted at 15:29:59 -0700 (new host PID
  89582); the trainer had been launched as a child of that app-owned shell, so
  the host restart tore down the training process tree. This is an orchestration
  interruption, not model/loss instability. The iter-7,500 checkpoint and live
  adapter are byte-identical, sha256
  `e82b0408c6ada65c4eff64c0e382012c673d3b68e021290bd4aa766b69294367`;
  only 20 post-checkpoint steps are unpreserved. No continuation was launched
  automatically: MLX adapter checkpoints do not by themselves prove exact
  optimizer/data-loader-position recovery. Any continuation must be registered
  explicitly and launched outside the desktop-app process tree.

- **r8-4b continuation registration, 2026-08-22 (pre-launch):** continue from
  the immutable iter-7,500 adapter for exactly 5,613 additional optimizer steps
  using `R8_4B_MLX_CONT_7500.yaml` and a distinct adapter/log namespace. MLX
  0.31.3 restores LoRA weights only; Adam moments, MLX/NumPy RNG state, iterator
  position, trained-token counters, and the displayed iteration number restart
  at this seam. To avoid silently repeating rows, the continuation train split
  is the exact unconsumed tail of the original seed-0 13,113-row permutation,
  inverse-permuted so a fresh seed-0 MLX iterator consumes those 5,613 rows in
  their original order. Derived train sha256
  `a8a878191c57c97326d5bcf0911235cf30ffd6600f89a47c65d7705fc945ef3d`;
  valid remains byte-identical at
  `9047ab96fd7e8f7f2155d6acc9c9b391c7989ed6205d119c46be764dfa4f3638`;
  derived manifest sha256
  `fca65758e721879857383e679563792d6ca3e68d053752269912f24b56a7f2e2`.
  This preserves one-pass row coverage and order, but not bitwise-equivalent
  optimization because the missing Adam/dropout state cannot be reconstructed.
  The trainer and finite-loss guard must be launchd-owned so desktop-app restarts
  cannot terminate the continuation.

- **r8-4b continuation launch, 2026-08-22 — RUNNING:** memory preflight passed
  (409 GiB Data-volume free, 722 MiB swap used), all registered source/resume
  hashes matched, and launchd jobs `com.mosh.r8-4b-cont7500` plus
  `com.mosh.r8-4b-cont7500-guard` started with parent PID 1. The model loaded the
  verified iter-7,500 adapter, initial continuation validation was `0.267`, and
  local iter 10/global iter 7,510 reported finite train loss `0.103` at LR
  `1e-5`. Continuation outputs are isolated in `.adapters/r8-4b-mlx-cont7500`;
  the immutable source checkpoint remains untouched. The global-offset dashboard
  is live at `http://127.0.0.1:8788`. The Codex desktop heartbeat (not a
  launchd service) is registered at
  `~/.codex/automations/monitor-r8-4b-mlx-continuation/automation.toml` and owns
  the quiet failure/completion handoff. At local iter 40/global iter 7,540 the
  trainer remained healthy with finite train loss `0.105`; the roughly
  two-minute gaps between lines are the expected 10-step logging cadence at
  about `0.08` iter/s, not a stall.

- **Continuation guard correction, 2026-08-22:** review found that a plain
  signal would allow launchd's inferred `keepalive` policy to restart a
  non-finite trainer. The guard now boots the exact trainer job out of launchd
  before it exits, then boots out its own keepalive job. A disposable submitted
  job proved that `launchctl bootout gui/<uid>/<label>` removes this job type,
  and fixture-driven tests cover finite Train/Val losses, NaN, Inf, and the
  ordered trainer-then-guard bootout behavior. The live guard was replaced in
  place without interrupting trainer PID 46248.

- **First continuation checkpoint, 2026-08-22:** local iter 100/global iter
  7,600 saved `0000100_adapters.safetensors` with finite train loss `0.053`.
  SHA-256 is
  `51814fcc0440703e31c54f56ad783bd6de11ed89c41e1e15dd66c21fb761e9b3`;
  the rolling `adapters.safetensors` copy is byte-identical. Trainer and guard
  remained launchd-owned and running after the save.

## Appendix: r7 interim peek (2026-08-18, owner-requested, recorded for gate honesty)

Mid-run curiosity check, NOT a gate read: r7 checkpoint-2400 (19% of the epoch,
~22/119 coverage rows seen) was paused via SIGSTOP, served matched-precision on
the 4-bit base, and run through the full novice-jam suite: **7/25 acceptable
(28%)** vs r5's 64% and frontier zero-shot's 52%. Both drum tasks and lyric
follow-through failed (the unseen coverage tail, as predicted), plus broad
mid-epoch immaturity (wrong-defers, dosage flails, one ambiguity violation).
Training resumed at iter 2,490 with zero loss of state. Read: the epoch tail is
load-bearing; early-stop rejected by the owner on this evidence. The final r7
gate read is unaffected and still pending.
