# r6 training plan — 4-bit MLX base, train/serve precision match

*Status: PROPOSAL — not pre-registered, not launched. This is the plan to be
turned into a formal pre-registration (see
[`R6_FREEZE_MEMO.md`](R6_FREEZE_MEMO.md)) before any `a3b-r6` training
starts, per this program's own discipline (§P1–§P9 of
`docs/bench/PROGRAM_STAGE1_2026-07.md`: nothing moves after a pre-registration
is committed). Every number below is cited to a file already in this repo
(mostly `service/sft/GATE_READ_a3b-r5-cuda.md` and
`service/sft/LOCAL_SERVE_READ_a3b-r5-mlx.md`) or to source actually read for
this document (`mlx-lm` 0.31.3, installed at `~/Library/Mosh/venvs/sft`, and
`service/sft/sft_cli.py`/`sft_cuda_train.py`).*

## 1. Why r6 exists

`a3b-r5-cuda` **passed** its gate on 2026-07-10 — bf16 LoRA on
`Qwen/Qwen3-30B-A3B-Instruct-2507`, trained and served bf16
(`GATE_READ_a3b-r5-cuda.md`): `diag_floor4 0.895 · evalA 0.9357 · frozen300
0.977 · agg(A,C) 0.9563 · §B 0.8919` — every bar cleared.

The problem surfaced one cycle later, when the owner asked whether r5 could
serve locally instead of via the cloud brain
(`LOCAL_SERVE_READ_a3b-r5-mlx.md`, 2026-07-16). Latency is solved either way
(4-bit warm median **1.67 s**, 8-bit **1.77 s**, both well under the 2 s bar).
Quality is not: **every quantized serve of r5 fails exactly one family,
`add_note`, at 0.000** (6/6 rows; bf16 serve of the identical adapter clears
that family at ≥0.667). The failure cascades into `frozen300` because the
corpus is note-population-heavy: 0.977 (bf16) → 0.767 (4-bit) / 0.793 (8-bit).
The document's own attribution work (isolating bf16 MoE routers + `lm_head`
on top of the attention overlay — still 6/6 broken) narrows the defect to
**the quantized FFN experts**, and its own recommendation is explicit:

> "The fix is r6 trained against the 4-bit MLX base (the §P8 local recipe,
> the r3 precedent: §C 0.960 served fused-4-bit). Train/serve precision
> matching is the durable lesson."
> — `LOCAL_SERVE_READ_a3b-r5-mlx.md`, "Recommendation"

r6 is that cycle: train **and** serve on the same 4-bit MLX-quantized base,
so there is no cross-precision gap to diagnose after the fact.

## 2. Recipe

Reuse `service/sft/sft_cli.py train` (the local mlx-lm LoRA lane — the same
tool r1/r2/r3 used, and the one §P8 pre-registered for the original,
locally-run r4 attempt before it was cut over to RunPod CUDA for speed —
see `LOCAL_R4_STOPPED.md`):

```sh
cd service/sft && source .sft.env
BASE=~/AI/models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit   # the same base run-gate-r4.sh/GATE_READ_r3.md use

"$SFT_PY" sft_cli.py train \
  --data .sft-data/s2-mix-v5 \
  --out .adapters/a3b-r6 \
  --model "$BASE" \
  --iters 12994 \
  --batch-size 1 \
  --num-layers 16 \
  --lr 1e-5 \
  --max-seq-length 4096
# mask-prompt and grad-checkpoint default ON (sft_cli.py flags: --no-mask-prompt / --no-grad-checkpoint to disable)
```

`--iters 12994` = 1.0 epoch of the 12,994-row mix at batch 1, following the
epoch-sizing rule that fixed r1/r2's exposure defects (`PROGRAM_STAGE1_2026-07.md`
§P7.3 — "every training row gets ≥E looks"). `--num-layers 16` matches every
prior cycle's last-16-layer scope (r3/r4/r5 all used 16).

### 2.1 Data — `s2-mix-v5` verbatim, no new corrective batch

r6 changes **base precision only**, not the mix. `s2-mix-v5` (train sha
`3c4e2e8b2ecc3562…`, 12,994/1,650 — same file this plan's counterpart,
[`SFT_COVERAGE_MATRIX.md`](SFT_COVERAGE_MATRIX.md), tabulates) is carried
forward unmodified. Rationale: the LOCAL_SERVE_READ diagnosis is explicit that
the `add_note` regression is a **precision/architecture** defect (identical
6/6 failure signature across a plain 4-bit fuse, the attention-overlay
construction, AND the plain 4-bit base with no adapter at all) — not a
data-coverage gap. `add_note` already has 402 training rows, the single
highest-coverage command in the mix (`SFT_COVERAGE_MATRIX.md`). Adding more
`add_note` rows would not address a defect that reproduces on the BASE model.

### 2.2 The mechanistic hypothesis this recipe is actually testing

This is the part worth stating plainly, because "train on the 4-bit base"
bundles **three** simultaneous changes versus r5 if `sft_cli.py` is run
unmodified — and only one of them is the one LOCAL_SERVE_READ names.

Reading `service/sft/sft_cli.py::run_train` (the local lane) shows it never
passes `--lora-parameters`/a `keys` override to `mlx_lm lora` — so mlx-lm
0.31.3's own defaults govern LoRA scope and rank
(`mlx_lm/lora.py:74`: `"lora_parameters": {"rank": 8, "dropout": 0.0, "scale":
20.0}` — **rank 8**, not 16). And `mlx_lm/tuner/utils.py`'s
`linear_to_lora_layers`, when no `keys` are given, auto-discovers **every**
`nn.Linear` / `QuantizedLinear` / `SwitchLinear` / `QuantizedSwitchLinear` /
`Embedding` submodule inside the selected layers
(`mlx_lm/tuner/utils.py:85-101`). For the A3B's MoE architecture
(`mlx_lm/models/qwen3_moe.py`), that scan reaches **`mlp.switch_mlp.{gate_proj,
up_proj,down_proj}`** — the batched expert FFN weights, implemented as
`SwitchLinear` (`mlx_lm/models/switch_layers.py:171-173`) — in addition to
`self_attn.{q,k,v,o}_proj` and the MoE router (`mlp.gate`).

Compare that to r5's own recorded recipe: **"bf16 LoRA on
Qwen/Qwen3-30B-A3B-Instruct-2507, r16 · α32 · q/k/v/o · layers 32–47"**
(`LOCAL_SERVE_READ_a3b-r5-mlx.md`, header) — attention projections **only**.
Independently confirmed for this document by inspecting the actual converted
adapter's tensor names/shapes (`~/AI/adapters/a3b-r5-mlx/adapters.safetensors`,
128 tensors): every key matches
`model.layers.{32..47}.self_attn.{q,k,v,o}_proj.lora_{a,b}` — 16 layers × 4
projections × 2 — with `lora_a`/`lora_b` shapes confirming rank 16
(`(2048,16)`/`(16,512)` on `k_proj`). Not one `switch_mlp`/`mlp.gate` key
exists. r5's LoRA never had the capacity to adapt the FFN experts at all —
which lines up exactly with LOCAL_SERVE_READ's own attribution conclusion:
"the flip lives in the quantized experts… unfixable by any small overlay."

So if r6 runs `sft_cli.py` unmodified, it changes THREE things vs r5 at once:

1. **base precision** (4-bit vs bf16) — the change LOCAL_SERVE_READ names;
2. **LoRA module scope** (attention + MoE experts + router, vs attention only)
   — a materially different, plausibly more direct fix for an
   experts-attributed defect, never tested in this program;
3. **LoRA rank** (8 vs 16) — a capacity change nobody has pre-registered.

A clean r6 gate read that passes will not, by itself, tell you which of these
three did the work. See §4 for the two ways to handle that.

## 3. Success criteria

Re-registered **verbatim** from §P9 (`PROGRAM_STAGE1_2026-07.md`), read on
the **native precision** this time (no separate bf16-then-quantize step —
r6's adapter is fused into, and served from, the same 4-bit base it trained
against, so the gate read IS the production-precision read):

1. aggregate(evalA, frozen300) ≥ **0.75**;
2. per-command floor ≥ **0.5** on every measurable evalA family (floor
   sources: `diag_floor4` for `split_clip`, the 210-row evalA core for
   everything else — same post-idfix file, sha `d68ec63696ee…`, per
   `EVAL_RUNBOOK.md` §5.1);
3. §B grounded clean-apply ≥ **85%**.

Plus one new leg this cycle exists specifically to clear, carried in from
LOCAL_SERVE_READ's own numbers as the explicit target to beat:

4. **`add_note` family ≥ 0.5** measured on the artifact actually served
   (the fused 4-bit dir) — the exact leg that failed at 0.000 for both
   quantized serves of r5 (§1). Report the number even if it clears —
   LOCAL_SERVE_READ's own honest-caveats discipline (floor families are
   n=3–6) applies here too.
5. Re-run the latency bench (`EVAL_RUNBOOK.md` §6) against the r6 fused dir
   — **warm median < 2 s** — to confirm nothing about the new recipe (larger
   LoRA-adapted parameter count, if §2.2's scope broadening holds) regressed
   the number LOCAL_SERVE_READ already cleared for r5's shape.

**One clean read, no retry** — the program's standing rule for every cycle
since §P7.4 (`PROGRAM_STAGE1_2026-07.md`). A miss on leg 4 alone (with 1–3
passing) should be reported as a **partial** result, not spun as a pass or
a full HALT — see `R6_FREEZE_MEMO.md`'s honest-caveats section for the exact
disposition rule.

## 4. Known risks

### 4.1 The three-way confound (§2.2) — a decision the owner has to make

- **Option (a) — accept the confound, ship the fastest read.** Run
  `sft_cli.py` unmodified. If the gate (§3) passes, r6 is a good adapter
  regardless of which of the three changes did the work — matches this
  program's historical bias toward shipping a passing checkpoint over
  isolating mechanism (see r3→r4→r5, where root causes were diagnosed
  *after* a HALT, not pre-isolated). Cheapest, fastest, least rigorous.
- **Option (b) — hold scope+rank constant, isolate precision.** Extend
  `sft_cli.py` (or call `mlx_lm lora --config` directly with an explicit
  `lora_parameters: {rank: 16, keys: [...]}` YAML restricted to
  `self_attn.{q,k,v,o}_proj`) so r6's LoRA touches exactly what r5's did.
  This is real engineering work not yet done — `sft_cli.py`'s `train`
  subcommand has no `--rank`/`--lora-parameters`/`--keys` flag today
  (verified: beyond `--data`/`--out`/`--model`, its only recipe-shaping
  flags are `--iters/--batch-size/--num-layers/--lr/--max-seq-length/
  --no-mask-prompt/--no-grad-checkpoint/--resume-adapter-file`,
  `service/sft/sft_cli.py:121-135`). Slower to start, but the only way to
  attribute a pass/fail to precision alone.

This plan does not choose for the owner — it names the fork so the freeze
memo can record whichever choice is made, before training starts.

### 4.2 Wall-clock — the same problem that caused the r4 CUDA cutover

r3's local-MLX pace smokes measured **~16.1–17.1 s/iter at batch 1** on this
Mac (`PROGRAM_STAGE1_2026-07.md` §R2, "Pace smokes"), projecting **≈59.8 h**
for a 12,674-iter epoch. r6's mix is 12,994 rows — essentially the same
scale, so expect **≈61–63 h (2.5–2.6 days)** of unattended wall-clock at the
same recipe shape, by direct analogy (not separately re-measured for this
plan — re-run the pace smoke before committing to the full run, exactly as
§P7.3 requires). **This exact wall-clock is why the original local r4 attempt
was stopped at 5,200/12,889 and cut over to a RunPod CUDA pod
(`LOCAL_R4_STOPPED.md`)** — r6 deliberately re-opens that trade-off, because
the CUDA lane trains **bf16** (or bitsandbytes QLoRA on a *different*
quantization scheme — see §4.3) and so cannot deliver the train/serve
precision match this cycle exists to test. If the owner is not willing to
tie up the Mac's single mlx-capable GPU seat for ~2.5 days (during which
`TRAINING_HANDOFF.md`'s "ONE mlx process at a time" rule blocks any other
local eval/serve/SA3 work), that tension needs to be resolved before
launch, not discovered mid-run.

### 4.3 A CUDA QLoRA path exists but is unverified for this exact goal

`sft_cuda_train.py --4bit` (README.md "Cloud (CUDA) run — RunPod / Vast.ai"
section) does QLoRA on a rented box, which would solve §4.2's wall-clock
problem — but its
4-bit quantization is `bitsandbytes` `Linear4bit` (NF4), a **different**
quantization implementation and grid from mlx-lm's own 4-bit format (the one
`~/AI/models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit` uses, and the one r6
would serve from). A `bitsandbytes`-QLoRA adapter is not guaranteed to fuse
cleanly onto an mlx-quantized base — that would need the same
"shard-hash weight-check" discipline every other cycle in this program uses
(`EVAL_RUNBOOK.md` §2.2) applied specifically to a cross-quantization-scheme
fuse, which has never been attempted or verified in this repo. Do not assume
this shortcut works without that verification step.

### 4.4 No operational scripts exist for a detached r6 run yet

`monitor-r4.sh` / `watchdog-r4.sh` / `launch-r4.sh` / `boot-resume-r4.sh` /
`resume-r4.sh` / `run-gate-r4.sh` are the detached-training + auto-gate
infrastructure this program relies on for a multi-day unattended local run
(`TRAINING_HANDOFF.md`) — every one of them is **hardcoded** to the
`a3b-r4` adapter name and to `SFT_DIR`/`BASE_MODEL` paths from a specific,
now-defunct worktree (`intelligent-banach-25ad5f`, per `run-gate-r4.sh:4-5`).
None of them run for `a3b-r6` as-is. Before launching a ~60 h unattended run,
either copy+rename this set for r6 (mirroring the r4 shape, updating
`SFT_DIR`/`BASE_MODEL`/adapter name/`.done` target) or accept manual
monitoring — both are real setup work this plan does not do (docs-only
ticket).

### 4.5 The pre-existing zero-coverage commands are untouched, on purpose

`SFT_COVERAGE_MATRIX.md` tabulates 20 commands with zero `s2-mix-v5` training
rows (structural named-misses like `get_rhymes`/`load_plugin`/the take-lane
trio, plus 10 commands added after the mix was frozen). None of them were r5
floor misses — r5's gate read cleared every measurable evalA family
(`GATE_READ_a3b-r5-cuda.md`: "every measurable evalA family ≥ 0.5 … All
floors pass," including `set_render_param`, an earlier cycle's named
exception that the §P8 render-routing corrective batch already resolved
before r5). Folding new corrective rows for any of the 20 into the mix this
cycle would reopen the §2.2 confound with a fourth simultaneous change — out
of scope here by design, not an oversight.

## 5. Procedure once launched

1. Pre-register via [`R6_FREEZE_MEMO.md`](R6_FREEZE_MEMO.md) — recipe, data,
   gate, and the §4.1 confound decision, all fixed before the first
   `sft_cli.py train` call.
2. Launch per §2 (detached, per §4.4's caveat).
3. On completion: fuse → weight-check → serve → run the four gate legs, all
   per [`EVAL_RUNBOOK.md`](EVAL_RUNBOOK.md) — reusing the SAME frozen eval
   files r5 was read against (no eval-file changes this cycle).
4. Record the read in `docs/bench/PROGRAM_STAGE1_2026-07.md` §R2 (or a new
   §R3, mirroring how §P7/§P8/§P9 each got their own record), and update
   `R6_FREEZE_MEMO.md`'s status line from DRAFT to the actual PASS/MISS/HALT
   disposition — never edit the pre-registered sections themselves.
