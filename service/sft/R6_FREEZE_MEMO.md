# r6 pre-registration / freeze memo

**Status: DRAFT — not yet frozen.** Following this program's own discipline
(every prior cycle — §P1/§P7/§P8/§P9 in `docs/bench/PROGRAM_STAGE1_2026-07.md`
— registers recipe/data/gate **before** the run and never edits them
afterward), this memo freezes the moment the owner picks §1's open decision
and the first `sft_cli.py train --out .adapters/a3b-r6 …` invocation runs.
Until then it is a proposal, elaborated in
[`R6_TRAINING_PLAN.md`](R6_TRAINING_PLAN.md) — this file is the short,
signable version of that plan, in the shape every previous cycle's
pre-registration used.

**To freeze this memo:** fill in the two `‹TBD›` fields in §1, change the
status line above to `FROZEN <date>`, and commit. Nothing below §1 may change
after that commit lands — a change of mind at that point is a new cycle
(§P8-precedent: "P7's one-retry allowance was spent… this is a FRESH
pre-registration with its own single clean read").

---

## §1 — Open decision (must be resolved before freeze)

`R6_TRAINING_PLAN.md` §4.1 names a fork this memo cannot pre-decide:

- [ ] **(a) accept the confound** — run `service/sft/sft_cli.py` unmodified
      (mlx-lm defaults: rank 8, LoRA scope = all linear/embedding/
      SwitchLinear submodules in the last 16 layers, i.e. attention **+** MoE
      experts **+** router — see plan §2.2).
- [ ] **(b) isolate precision** — extend `sft_cli.py` with an explicit
      `lora_parameters` override (rank 16, `keys` restricted to
      `self_attn.{q,k,v,o}_proj`) so LoRA scope matches r5's recorded recipe
      exactly, and only base precision differs.

Chosen: ‹TBD — check one box above before freezing›.
Chosen by / date: ‹TBD›.

## §2 — Adapter identity

- **Adapter id:** `a3b-r6`
- **Base model:** `Qwen3-30B-A3B-Instruct-2507-4bit` (mlx-community 4-bit
  quantization, the local path used by every prior local-lane cycle —
  `~/AI/models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit` per `GATE_READ_r3.md`
  and `run-gate-r4.sh`). **Not** the bf16 HF model r4-cuda/r5-cuda trained
  against — that is the entire point of this cycle.
- **Trainer:** `service/sft/sft_cli.py train` → `mlx_lm lora --train`
  (mlx-lm 0.31.3, the version installed at `~/Library/Mosh/venvs/sft` at the
  time this memo was drafted — re-pin/re-verify at freeze time if the venv
  has since been reinstalled).
- **Lane:** local MLX on the owner's Mac (Apple Silicon), not RunPod/CUDA —
  required for the train/serve precision match; see plan §4.2 for the
  wall-clock trade this reopens.

## §3 — Data: `s2-mix-v5`, verbatim, unchanged

- **Train:** 12,994 rows, sha256
  `3c4e2e8b2ecc3562404fb824aa0b7dd131bd908e936c946cc8d3507adbf071eb`
- **Valid:** 1,650 rows, sha256
  `9047ab96fd7e8f7f2155d6acc9c9b391c7989ed6205d119c46be764dfa4f3638`
  (= `s2-mix-v4`'s valid split, verbatim, per §P9)
- Same file `a3b-r5-cuda` trained on (`GATE_READ_a3b-r5-cuda.md` line 16);
  per-command exposure tabulated in
  [`SFT_COVERAGE_MATRIX.md`](SFT_COVERAGE_MATRIX.md). **No new rows added
  this cycle** — the defect r6 targets reproduces on the base model with no
  adapter at all (`LOCAL_SERVE_READ_a3b-r5-mlx.md`), so it is not a
  data-coverage gap (plan §2.1).
- Length filter: 0 dropped at max-seq 4096 (carried forward — v5 ⊂
  already-filtered v4/v3).

## §4 — Recipe (fixed before launch)

```
batch 1 · iters 12994 (1.0 epoch) · lr 1e-5 · num-layers 16 (last-16, i.e.
transformer layers 32–47 of 48) · seq 4096 · mask-prompt ON · grad-checkpoint
ON · lora rank/scope = per §1's chosen option · from base (fresh adapter,
no --resume-adapter-file) → .adapters/a3b-r6
```
(`num_hidden_layers: 48` confirmed directly from
`~/AI/models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit/config.json`.)

Pace smoke required before the full launch (same rule as every prior cycle,
`PROGRAM_STAGE1_2026-07.md` §P7.3): a short (12–25 iter) run at this recipe
on this exact base, to (1) confirm no-NaN, (2) re-measure s/iter on the
current machine state before committing to a multi-day unattended run, and
(3) re-confirm the `<think>`-empty-block chat-template artifact is still
`parseReply`-safe (carried-forward observation from the r1/r3 investigations,
not separately re-verified here).

Projected wall-clock: **≈61–63 h** (2.5–2.6 days), by direct analogy to r3's
measured local pace (16.1–17.1 s/iter × 12,994 iters) — **not a fresh
measurement**; the pace smoke above supersedes this estimate before launch.

## §5 — Gate (re-registered verbatim from §P9, plus one new leg)

**One clean read. No retry — a miss on any leg is reported honestly, not
re-tried inside this cycle** (this program's standing rule since §P7.4).

1. aggregate(evalA, frozen300) ≥ **0.75**
2. per-command floor ≥ **0.5** on every measurable evalA family (floor
   sources: `diag_floor4` for `split_clip`, evalA 210-row core post-idfix
   sha `d68ec63696ee…` for the rest)
3. §B grounded clean-apply ≥ **85%**
4. **NEW this cycle:** `add_note` family ≥ **0.5**, read on the artifact
   actually served (the fused 4-bit dir) — the exact leg that scored 0.000
   for both quantized serves of r5 (`LOCAL_SERVE_READ_a3b-r5-mlx.md`)
5. **NEW this cycle (context, not a pass/fail gate):** latency bench warm
   median, reported against the same < 2 s bar r5's quantized serves already
   cleared (`EVAL_RUNBOOK.md` §6) — confirms the recipe change (possibly
   larger adapted-parameter count if §1 chose option (a)) didn't regress it.

Eval files are **unchanged from §P9** — no new pre-registration needed for
the eval side; see `EVAL_RUNBOOK.md` §5 for how to obtain/rebuild them if a
fresh worktree doesn't already have copies.

## §6 — Honest caveats (registered up front, per this program's habit)

1. **The three-way confound (§1).** If option (a) is chosen, a passing gate
   does not by itself prove "4-bit training fixed it because of precision
   matching" — it may equally be the broadened LoRA scope (MoE experts now
   adapted, never true for r5) or the doubled rank capacity, or some
   combination. Report the read as "r6 (option a) passes/misses" — not as
   confirmation of the LOCAL_SERVE_READ mechanistic story specifically —
   unless option (b) is chosen.
2. **Wall-clock risk is real and historically has caused a mid-run cutover
   on this exact recipe shape** (`LOCAL_R4_STOPPED.md`). If the run is
   stopped before completion for the same reason r4-local was, that is not
   a gate miss — it is an incomplete run, and should be recorded as such
   (mirroring `LOCAL_R4_STOPPED.md`'s own framing), not folded into any
   pass/fail language.
3. **No detached-run tooling exists for `a3b-r6` yet** (plan §4.4) — a
   silent process death partway through (laptop sleep edge case, OOM, etc.)
   will not auto-resume the way r4's watchdog+LaunchAgent did, unless that
   tooling is built/copied first.
4. **evalA floor families remain n=3–6** — one row flips a floor; report
   with counts, not just rates (carried forward from every prior cycle's
   caveat list, still true).
5. **This memo does not add a corrective data batch.** If leg 4 (`add_note`)
   or any of legs 1–3 misses, the fix-first precedent from the r4→r5 cycle
   (`R4_CUDA_GATE_MISS_FIX_PLAN_2026-07-09.md`) applies: diagnose before
   assuming a retrain is needed, and any new corrective rows are a **new**
   cycle's pre-registration, not a silent edit to this one.

---

## Disposition (fill in after the read; do not edit §1–§6 above)

- Adapter sha256: ‹TBD›
- Training completion: ‹TBD› (iters / wall-clock actual vs §4 projection)
- Gate read date: ‹TBD›
- Result: ‹TBD — PASS / MISS (name the leg) / HALT / incomplete-run per §6.2›
- Disposition: ‹TBD›
