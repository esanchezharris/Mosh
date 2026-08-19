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
