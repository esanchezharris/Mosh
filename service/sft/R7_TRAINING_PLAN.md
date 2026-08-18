# r7 training plan — coverage fold-in on the proven r5 recipe

*Status: PROPOSAL — not pre-registered, not launched. This is the plan to be
turned into a formal pre-registration (see
[`R7_FREEZE_MEMO.md`](R7_FREEZE_MEMO.md)) before any `a3b-r7` training
starts, per this program's own discipline (§P1–§P9 of
`docs/bench/PROGRAM_STAGE1_2026-07.md`, and `R6_TRAINING_PLAN.md`'s own
header note: nothing moves after a pre-registration is committed). Every
number below is cited to a file already in this repo (mostly
`GATE_READ_a3b-r5-cuda.md`, the recorded `~/AI/adapters/a3b-r5-cuda-pull/
a3b-r5-cuda/sft_run.json` + `adapter_config.json`, and
`docs/agent-bench/LADDER-cal2-2026-08-18.md`) or to source actually read for
this document (`service/sft/sft_cuda_train.py`, `README.md`'s "Cloud (CUDA)
run" section).*

## 0. Relationship to r6 — a SEPARATE, parallel cycle, not a successor

Per `R6_COVERAGE_PREP_NOTE.md` and `RUN_NEXT.md` §1: **r6 is unaffected by
anything in this document.** `R6_TRAINING_PLAN.md` / `R6_FREEZE_MEMO.md` /
`s2-mix-v5` remain exactly as pre-registered — a precision-isolation
experiment (4-bit MLX base training, testing whether train/serve precision
match fixes the `add_note` quantized-serve regression). r6 has **not yet
been launched or read** as of this writing.

r7 is a **different, independent question**: does folding the 119
coverage rows in `r7_coverage_demonstrations.jsonl` into the mix close the
SFT-coverage gaps the novice-jam bench found, using the **lane and recipe
that already passed a full gate** (`a3b-r5-cuda`)? It deliberately does
**not** wait on r6's result and does **not** reuse r6's untested 4-bit-base
lane — see §2 for why. If r6 later passes, a *future* cycle can consider
folding these same rows onto whatever base r6 establishes as the new
default; that is out of scope here, exactly as r6 declined to fold new rows
into its own cycle (`R6_COVERAGE_PREP_NOTE.md`, quoting `R6_TRAINING_PLAN.md`
§4.5: "a fourth simultaneous change — out of scope here by design").

## 1. Why r7 exists

The novice-jam bench (`docs/agent-bench/LADDER-p1-p3-2026-08-17.md`,
`LADDER-cal2-2026-08-18.md`) is this program's first end-to-end producer-task
read against `a3b-r5-cuda` (served as the attn-overlay `a3b-r5-4bit-hd`
fuse). r5 leads every entrant — **16/25 = 64% acceptable**, the standing bar
in the ladder table — but `LADDER-cal2-2026-08-18.md` "Lessons with legs" §2
names the remaining gap plainly:

> "r5's remaining misses are **SFT-coverage gaps** (drum-kit domain asks,
> multi-step lyric flows, one persistent `create_section` ambiguity
> violation) — the lever for 20/25 is a targeted training-data pass, not
> more prompting."

Both calibrated scoreboards (`scoreboard.p3-novice-jam-r5.md`,
`scoreboard.p3-novice-jam-r5-cal2.md`) show the same three-failure signature
by category:

- **`compose-drums` 0/2 both runs** — `nj-drums-groove` and `nj-hats-more`
  both fail with `add_drum_pattern ×0 < 1`: the model never emits the
  command at all. `R6_COVERAGE_PREP_NOTE.md`'s own root-cause finding
  explains why — `add_drum_pattern` was added to `commands.ts` **~20 hours
  after `s2-mix-v5` was written** (`SFT_COVERAGE_MATRIX.md` "Bucket C"),
  i.e. **zero training rows**, confirmed, not a regression. This is exactly
  the miss `r7_coverage_demonstrations.jsonl`'s 44 drum rows (beat-from-
  nothing / add-to-existing / track-only / kit-swap) target.
- **`nj-amb-empty-middle`** fails both runs with `create_section — emitted 1
  command(s) on a defer case` — the one persistent `create_section`
  ambiguity violation the ladder names. Targeted by the 12
  `ambiguous_defer` + 8 `near_miss_should_act` rows.
- **Multi-step lyric flows** — not a novice-jam category failure in these
  two specific runs (`lyrics` scored 2/2 both times), but named directly by
  the ladder's own "Lessons with legs" §2 as an observed gap class across the
  broader read, and independently confirmed as a real zero/thin-coverage
  risk by `SFT_COVERAGE_MATRIX.md`. The 37 lyric rows (sheet+line,
  exact-opening-line, full follow-through, sheet-only) target this.

r7 is the "targeted training-data pass" the ladder names as the lever —
**built on the recipe that already cleared a full gate**, not a new
mechanism.

## 2. Recipe — reuse `a3b-r5-cuda`'s exact recipe, new data only

This is deliberately **not** r6's local-MLX 4-bit-base lane. Two independent
reasons:

1. **r6 is a live, separately-pre-registered isolation experiment** whose
   whole point is holding data constant while precision varies
   (`R6_TRAINING_PLAN.md` §2.2's three-way-confound analysis). Running r7 on
   the same 4-bit-base lane would import that lane's *own* unresolved
   confound (LoRA scope/rank auto-discovery pulling in MoE experts + router
   at rank 8, vs r5's clean rank-16 attention-only) into a cycle whose
   purpose is to isolate a *different* variable (data coverage). Reusing
   r5's CUDA lane instead means r7 changes **exactly one thing** vs the last
   passing gate: the data.
2. **The CUDA lane's LoRA scope is already attention-only, verified, no
   flag needed.** Reading `service/sft/sft_cuda_train.py::linear_target_modules`
   (§58-75) shows it auto-discovers every `torch.nn.Linear`/`Linear4bit`
   submodule in the `--last-layers`-restricted scope — the same
   auto-discovery mechanism r6's plan flags as a *risk* for the MLX lane.
   But the actual r5 artifact's `adapter_config.json`
   (`~/AI/adapters/a3b-r5-cuda-pull/a3b-r5-cuda/adapter_config.json`) shows
   `target_modules: ["o_proj","q_proj","v_proj","k_proj"]` only — **no**
   `gate_proj`/`up_proj`/`down_proj` — confirming that for this exact model
   class (`Qwen/Qwen3-30B-A3B-Instruct-2507`, transformers checkpoint,
   trl+peft lane) the MoE expert FFNs are not plain `nn.Linear` submodules
   the auto-discovery would catch. r7, run the same way, inherits that same
   clean attention-only scope automatically — no `sft_cuda_train.py` code
   change needed, unlike r6's option (b).

### 2.1 Launch command

```sh
cd service/sft
bash setup-sft-cuda.sh
python3 sft_cuda_train.py \
  --data ./.sft-data/s2-mix-v6-prep \
  --model Qwen/Qwen3-30B-A3B-Instruct-2507 \
  --out ./.adapters/a3b-r7 \
  --epochs 1 \
  --max-steps 13113 \
  --batch-size 1 \
  --grad-accum 1 \
  --lr 1e-5 \
  --lora-r 16 \
  --max-seq-len 4096 \
  --last-layers 16 \
  --save-steps 200
```

(80GB card → bf16 LoRA, omit `--4bit`; matches `a3b-r5-cuda`'s recorded
`qlora_4bit: false`. `--model` here names the **default** base per §3's open
decision — swap it to whichever base the owner picks before freezing.)
`--max-steps 13113` = 1.0 epoch of the new mix's 13,113-row train split
(§4), following the same "≥1 epoch, every row gets ≥1 look" sizing rule
r4/r5/r6 all use. `lora-r 16` (α = r×2 = 32 per `sft_cuda_train.py:189`,
dropout 0.05 hardcoded at `sft_cuda_train.py:190`) and `--last-layers 16`
reproduce r5's recorded recipe exactly (§2 above).

### 2.2 Post-training pipeline (mirrors `LOCAL_SERVE_READ_a3b-r5-mlx.md`)

1. Pull the adapter dir from the box (same shape as
   `~/AI/adapters/a3b-r5-cuda-pull/a3b-r5-cuda`); verify
   `adapter_model.safetensors` sha256 Mac↔pod before terminating the pod.
2. `convert_peft_adapter_to_mlx.py` — PEFT→MLX tensor conversion (the r5
   precedent: 128 tensors, scale 2.0, ~18 MB).
3. `build_attn_overlay_model.py` — attn-overlay fuse onto the **4-bit MLX**
   base (not a plain `mlx_lm fuse`; `LOCAL_SERVE_READ_a3b-r5-mlx.md`
   documents why plain 4-bit fuse measurably destroys a bf16-trained
   attention-only adapter — cosine ≈0.03 with the intended delta, ~83% of
   ‖Δ‖ lost to requantization noise). Produces an `a3b-r7-4bit-hd`-shaped
   fused dir, ~16 GB, matching `a3b-r5-4bit-hd`'s construction.
4. Serve via `mlx_lm.server`, verify `/v1/models` + a differential probe vs
   an offline generation (Serving-trap #4 compliance, same as
   `LOCAL_SERVE_READ_a3b-r5-mlx.md` "Serving-trap #4 compliance").
5. Gate per §3 below, then bench the novice-jam suite specifically to read
   the three named misses.

## 3. Success criteria

Two tiers: the standing §P9 gate (re-registered verbatim, same as r5's own
read and r6's own re-registration in `R6_TRAINING_PLAN.md` §3), plus the
novice-jam leg this cycle exists specifically to move.

**Standing gate (§P9, unchanged):**

1. aggregate(evalA, frozen300) ≥ **0.75**
2. per-command floor ≥ **0.5** on every measurable evalA family (floor
   sources: `diag_floor4` for `split_clip`, the 210-row evalA core for
   everything else — same post-idfix file, sha `d68ec63696ee…`, per
   `EVAL_RUNBOOK.md` §5.1)
3. §B grounded clean-apply ≥ **85%**

Read per `EVAL_RUNBOOK.md` §4 (the three legs) — reusing the same frozen
eval files r5/r6 are read against (no eval-file changes this cycle).

**New this cycle — the actual target r7 exists to move:**

4. **novice-jam suite acceptable ≥ 16/25 = 64%** (r5's own standing bar,
   `LADDER-p1-p3-2026-08-17.md` / `LADDER-cal2-2026-08-18.md`) — not a
   regression vs r5 is the floor; the real goal is clearing it decisively
   toward the ladder's named **20/25** kill-line for the graduated-trust
   lane default.
5. The three named misses tracked **individually**, not just folded into
   the aggregate — a pass on (4) that still misses one of these would be a
   partial win worth reporting honestly, not spun as a clean sweep:
   - `compose-drums` category (`nj-drums-groove`, `nj-hats-more`) — was 0/2
     on both r5 reads.
   - lyric multi-step follow-through — no isolated novice-jam task failed
     this specifically in the two r5 reads on file, but it's named directly
     in `LADDER-cal2-2026-08-18.md`'s "Lessons with legs" §2; report the
     `lyrics` category result plus any lyric-adjacent task in `mix`/`arrange`
     that exercises a multi-step ask.
   - `nj-amb-empty-middle` (the `create_section` ambiguity violation) — was
     a failure on both r5 reads.

**One clean read, no retry** — the program's standing rule since §P7.4
(`PROGRAM_STAGE1_2026-07.md`), re-registered verbatim by every cycle
including r6 (`R6_TRAINING_PLAN.md` §3). A miss on leg 4/5 alone (with 1–3
passing) should be reported as a **partial** result, not spun as a pass or a
full HALT.

## 4. Known risks

### 4.1 The base-model open decision (§1 of the freeze memo)

Unlike r6 (whose fork is about *how* to train), r7's open decision is
*what* to train — see `R7_FREEZE_MEMO.md` §1. Two options, presented
without a pre-chosen winner:

- **(a) `Qwen/Qwen3-30B-A3B-Instruct-2507`** — the exact base r4/r5/r6 all
  use. Single-variable change vs r5 (data only). Conservative, directly
  comparable to every existing gate read and ladder row.
- **(b) `Qwen3.6-35B-A3B`** — a second, deliberate variable. Zero-shot (no
  adapter) already scores **13/25 = 52%** acceptable on novice-jam
  (`scoreboard.p3-novice-jam-qwen36-nothink-cal2.md`), the strongest
  zero-shot local entrant on the ladder — but training on it is
  **materially riskier**: it needs (i) sourcing the bf16 HF base (only a
  4-bit MLX conversion is on this Mac today,
  `mlx-community/Qwen3.6-35B-A3B-4bit`, confirmed 40 hidden layers / 2048
  hidden size / 256 experts, `model_type: qwen3_5_moe`,
  `architectures: ["Qwen3_5MoeForConditionalGeneration"]` — a **different**
  architecture class from Qwen3-30B-A3B's `Qwen3MoeForCausalLM`, so
  `--last-layers 16` would map to layers 24–39 of 40, not 32–47 of 48, and
  (ii) a **brand-new** MLX conversion + attn-overlay fuse path, never run
  for this model family — `convert_peft_adapter_to_mlx.py` /
  `build_attn_overlay_model.py` are both unverified against
  `qwen3_5_moe`'s tensor layout and would need their own weight-check
  before trusting a serve. Choosing (b) folds a real "does this pipeline
  even work" risk on top of the data question this cycle is actually
  trying to answer.

This plan does not choose — `R7_FREEZE_MEMO.md` §1 is where the owner
records the pick before freezing, mirroring how `R6_FREEZE_MEMO.md` §1
handles r6's own fork.

### 4.2 Wall-clock and cost — favorable, unlike r6

Because r7 reuses the CUDA lane (not r6's local-MLX lane), the wall-clock
precedent is `a3b-r5-cuda`'s own measured run: **21,479 s (5h 59m)** for
12,994 steps at this exact recipe (`sft_run.json`, `seconds: 21479.0`;
confirmed in `GATE_READ_a3b-r5-cuda.md`: "Runtime: `21479s` (`5h 58m 59s`)").
r7's mix is 13,113 rows (+119, +0.9%) — expect essentially the same
**≈6 h** wall-clock, not r6's multi-day local-MLX estimate. r5's total cost
was **≈$8.6** (train + serve/gate + rebuild idle,
`GATE_READ_a3b-r5-cuda.md` Disposition); r7's cost envelope is **≈$10–25**,
allowing for a slightly longer run, the gate-read serve time, and margin if
option (b)'s base needs extra download/conversion time. Re-run a short pace
smoke (12–25 steps) before committing to the full run regardless — same
standing rule every cycle uses (§P7.3) — since this is a new box each time.

### 4.3 Data risk is low, but not zero

`r7_coverage_demonstrations.jsonl` passed its own RED-proved validator suite
(`validate_sft_rows_test.py`, 16/16) and the real-catalog cross-check
(`validate_sft_rows.py`, 0 violations against the live 157-command catalog)
— but it is 119 hand-authored rows against a 12,994-row base mix (0.9%
of the mix by row count). If leg 4/5 (§3) still misses after this fold-in,
that is meaningful signal that either (a) 119 rows undersample the miss
classes relative to the mix's existing exposure to competing patterns
(`add_note` alone has 402 rows pulling the model toward note-population
replies), or (b) the miss is not purely a coverage gap — worth checking
against `LOCAL_SERVE_READ_a3b-r5-mlx.md`'s precision-defect finding before
assuming more rows is the fix (see `R6_FREEZE_MEMO.md` §6.5's standing rule:
diagnose before assuming a retrain is needed).

### 4.4 No operational scripts exist for a detached r7 CUDA run yet

`launch-r4-cuda.sh` is hardcoded to `a3b-r4-cuda`'s data/out paths
(`README.md` "CUDA parity run for a3b-r4"); `runpod_r4.py`'s pod-name/image
defaults are similarly r4-named. Either copy+rename this set for r7
(updating dataset dir, adapter out path, pod name) or drive
`sft_cuda_train.py` directly per §2.1 — both are real setup work this plan
does not do (docs-only ticket, same disposition as `R6_TRAINING_PLAN.md`
§4.4 for r6's own local-run tooling gap).

## 5. Procedure once launched

1. Pre-register via [`R7_FREEZE_MEMO.md`](R7_FREEZE_MEMO.md) — recipe, data,
   base-model decision (§4.1), and gate, all fixed before the first
   `sft_cuda_train.py` call.
2. Launch per §2.1 (rented CUDA 80GB box, pace smoke first per §4.2).
3. On completion: pull → convert → attn-overlay fuse → serve → weight-check
   → run the three standing gate legs (§3, per `EVAL_RUNBOOK.md`) → run the
   novice-jam suite specifically for legs 4/5.
4. Record the read in `docs/bench/PROGRAM_STAGE1_2026-07.md` (a new §
   entry, mirroring how §P7/§P8/§P9 and r6's own record each got one) and
   update `R7_FREEZE_MEMO.md`'s status line from DRAFT to the actual
   PASS/MISS/HALT disposition — never edit the pre-registered sections
   themselves.
5. If it clears leg 4 decisively (materially above 16/25) and/or closes one
   or more of the three named misses in leg 5, it becomes the new default
   local-agent adapter, superseding `a3b-r5-cuda`/`a3b-r6` per whichever of
   the two has the better read at that point — a disposition call for
   whoever reads the gate, not pre-decided here.
