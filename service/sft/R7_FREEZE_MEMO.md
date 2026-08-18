# r7 pre-registration / freeze memo

**Status: FROZEN 2026-08-18.** Following this program's own discipline
(every prior cycle — §P1/§P7/§P8/§P9 in `docs/bench/PROGRAM_STAGE1_2026-07.md`,
and `R6_FREEZE_MEMO.md`'s own instance of this same rule — registers
recipe/data/gate **before** the run and never edits them afterward), this
memo freezes the moment the owner picks §1's open decision and the first
`sft_cuda_train.py --out .adapters/a3b-r7 …` invocation runs. Until then it
is a proposal, elaborated in [`R7_TRAINING_PLAN.md`](R7_TRAINING_PLAN.md) —
this file is the short, signable version of that plan, in the shape every
previous cycle's pre-registration used (`R6_FREEZE_MEMO.md` most directly).

**To freeze this memo:** fill in the `‹TBD›` fields in §1, change the status
line above to `FROZEN <date>`, and commit. Nothing below §1 may change after
that commit lands — a change of mind at that point is a new cycle
(§P8-precedent, re-quoted in `R6_FREEZE_MEMO.md`: "this is a FRESH
pre-registration with its own single clean read").

**Not a substitute for r6.** This memo does not freeze, unfreeze, or alter
`R6_FREEZE_MEMO.md` in any way. r6 remains a live, separately-pre-registered
cycle with its own open decision (its own §1) and its own gate. See
`R7_TRAINING_PLAN.md` §0.

---

## §1 — Open decision (must be resolved before freeze)

`R7_TRAINING_PLAN.md` §4.1 names a fork this memo cannot pre-decide — which
base model r7 trains against:

- [x] **(a) `Qwen/Qwen3-30B-A3B-Instruct-2507`** — the same base
      r4/r5/r6 all use. Single-variable change vs the last passing gate
      (`a3b-r5-cuda`): data only. Conservative; directly comparable to every
      existing gate read.
- [ ] **(b) `Qwen3.6-35B-A3B`** — a second, deliberate variable. Zero-shot
      already the strongest local entrant on the ladder (13/25 = 52%
      acceptable, `scoreboard.p3-novice-jam-qwen36-nothink-cal2.md`), but
      needs (i) the bf16 HF base sourced (only a 4-bit MLX conversion —
      `mlx-community/Qwen3.6-35B-A3B-4bit` — is on this Mac today) and (ii)
      a NEW, unverified MLX-conversion + attn-overlay-fuse path for its
      `qwen3_5_moe` architecture (40 hidden layers, not 48 — `--last-layers
      16` would map to layers 24–39, not 32–47) before any gate read can be
      trusted.

Chosen: **(a) Qwen/Qwen3-30B-A3B-Instruct-2507** — single-variable discipline: the r7 read isolates the DATA change (119 coverage rows + regenerated prompt); the Qwen3.6 base question stays a separately registrable cycle.
Chosen by / date: owner ("sounds good go for it"), 2026-08-18.

## §2 — Adapter identity

- **Adapter id:** `a3b-r7`
- **Base model:** `Qwen/Qwen3-30B-A3B-Instruct-2507` per §1.
- **Trainer:** `service/sft/sft_cuda_train.py` (trl + peft, rented CUDA —
  **not** `sft_cli.py`/mlx-lm; this is r5's CUDA lane, not r6's local-MLX
  lane — see `R7_TRAINING_PLAN.md` §2 for why).
- **Lane:** rented CUDA, 80GB card, bf16 LoRA (`--4bit` NOT set — omit it;
  matches `a3b-r5-cuda`'s recorded `qlora_4bit: false`).


### §2a — Lane amendment at freeze time (budget-fitted, recorded before launch)

The plan's default 80GB bf16 lane is replaced, at freeze, by:

- **Card:** rented RTX 5090 32GB (Vast offer 47364955, ~$0.374/hr, 881Mbps) —
  the owner's balance ($6.24) makes the 80GB bf16 lane a ~2% margin bet; the
  QLoRA lane costs ~$2.5 and preserves a second attempt.
- **Recipe:** `sft_cuda_train.py --4bit` — bitsandbytes NF4 QLoRA; all other
  recipe-shaping flags exactly as §2 records (rank 16, attn-only q/k/v/o via
  the same layer-restricted discovery that produced `a3b-r5-cuda`,
  `--save-steps 1000` so an SSH drop cannot lose the run).
- **Gate serve (this cycle):** `serve_openai.py` ON THE BOX — the NF4-trained
  adapter served against the same NF4 base it trained on (self-consistent;
  the train/serve precision rule honored WITHIN the cycle). The Mac benches
  over the network with the standing novice-jam recipe.
- **Explicitly out of scope for the gate:** fusing this NF4 adapter onto the
  Mac's mlx-4-bit base. That is the known-unverified cross-quantization step
  (R6_TRAINING_PLAN §4.3); if attempted after a passing gate it gets its own
  verification read and does not retroactively change this cycle's result.

## §3 — Data: `s2-mix-v6-prep`

Built 2026-08-17 per `RUN_NEXT.md` §2.2's illustrative recipe, run from the
`claude/r7-prep` worktree against the main checkout's gitignored
`.sft-data/` tree:

- **Base:** `s2-mix-v5` verbatim — 12,994 train / 1,650 valid rows. (On-disk
  dir name is `s2-mix-v5-prep`; verified byte-identical to
  `R6_FREEZE_MEMO.md` §3's frozen v5 shas — train
  `3c4e2e8b2ecc3562404fb824aa0b7dd131bd908e936c946cc8d3507adbf071eb`, valid
  `9047ab96fd7e8f7f2155d6acc9c9b391c7989ed6205d119c46be764dfa4f3638` — before
  use, so this is genuinely v5, not a lookalike.)
- **Added:** `r7_coverage_demonstrations.jsonl`, 119 rows, sha256
  `392262600bc922b17fa863cdd5b26362f38fb24daa0b57ed3f57ac06ccb60150` —
  **regenerated 2026-08-17** (this cycle) against current
  `ui/src/agent/commands.ts` / `ui/src/agent/musicalTime.ts` HEAD via `cd ui
  && npx tsx scripts/build_assist_sft.mts`, then `build_r7_coverage_sft.py`
  re-run pointed at the fresh row. `validate_system_prompt_drift.py` reports
  **OK** (no drift) against this row — the prior committed sha
  `c596ba5ee760559df79563dda0380a3e722453d78ed63ddddb9c1a0bf7407a8f` embedded
  a STALE prompt (33 missing / 2 falsely-flagged-stale commands, the latter
  a `sft_catalog.py` multi-line-entry parser bug fixed this cycle, not a
  real catalog drift — see `RUN_NEXT.md` §2.1 and this cycle's own commit).
  `validate_sft_rows.py`: 0 violations, 119/119 rows, cross-checked against
  157 commands. `validate_sft_rows_test.py`: 16/16 pass.
- **Appended train (pre-filter):** 12,994 + 119 = 13,113 rows.
- **Length filter** (`filter_by_length.py`, model
  `~/AI/models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit` tokenizer, max-seq
  4096): **0 dropped** — train 13,113 → 13,113 (0 over-max, 0
  no-completion-room); valid 1,650 → 1,650 (unchanged, not touched by the
  append).
- **Final:**
  - Train: **13,113 rows**, sha256
    `9e8853344d2ac111ae6da5f239b71017b97815f394d6335fae94a9aa4549dbaf`
  - Valid: **1,650 rows**, sha256
    `9047ab96fd7e8f7f2155d6acc9c9b391c7989ed6205d119c46be764dfa4f3638`
    (= s2-mix-v5's valid split, verbatim, unchanged — same file carried
    forward since s2-mix-v4 per `R6_FREEZE_MEMO.md` §3)
- **Location:** `.sft-data/s2-mix-v6-prep/` on the owner's Mac (gitignored,
  machine-local — not present in any worktree checkout; see
  `.sft-data/s2-mix-v6-prep/manifest.json` for the full build record).

## §4 — Recipe (fixed before launch)

```
batch 1 · max-steps 13113 (1.0 epoch of the new mix) · lr 1e-5 · lora-r 16
(alpha 32 = r×2, dropout 0.05 — sft_cuda_train.py defaults) · last-16-layers
(auto-discovers attention-only target_modules — verified against a3b-r5-cuda's
actual adapter_config.json: q/k/v/o proj only, no MoE expert/router keys) ·
seq 4096 · assistant-only loss ON · bf16 (no --4bit) · from base (fresh
adapter, no --resume-from-checkpoint) → .adapters/a3b-r7
```

Layer indices are base-dependent — if §1 chose (b), re-derive the last-16
range against that model's actual `num_hidden_layers` (40 for
`qwen3_5_moe`, i.e. layers 24–39) before launch; do not assume 32–47.

Pace smoke required before the full launch (same rule as every prior cycle,
`PROGRAM_STAGE1_2026-07.md` §P7.3, `R6_FREEZE_MEMO.md` §4): a short
(12–25 step) run at this recipe on the chosen base and box, to confirm
no-NaN and get a fresh steps/sec reading before committing to the full run.

Projected wall-clock: **≈6 h**, by direct analogy to `a3b-r5-cuda`'s
measured `21,479 s` (5h 59m) for 12,994 steps at this identical recipe on an
80GB card (`sft_run.json`) — r7's mix is only +0.9% more rows. **Not a fresh
measurement for the actual box rented this cycle**; the pace smoke above
supersedes this estimate before committing to the full run. Cost envelope:
**≈$10–25** (r5's own full cycle cost ≈$8.6, `GATE_READ_a3b-r5-cuda.md`
Disposition; r7's slightly higher envelope allows for the gate-read serve
time and margin if option (b) needs extra download/conversion work).

## §5 — Gate (re-registered verbatim from §P9, plus the novice-jam leg this
cycle exists to move)

**One clean read. No retry — a miss on any leg is reported honestly, not
re-tried inside this cycle** (this program's standing rule since §P7.4,
re-registered by every cycle including r6).

Standing legs, read per `EVAL_RUNBOOK.md` §4 (same frozen eval files r5/r6
use — no eval-file changes this cycle):

1. aggregate(evalA, frozen300) ≥ **0.75**
2. per-command floor ≥ **0.5** on every measurable evalA family (floor
   sources: `diag_floor4` for `split_clip`, evalA 210-row core post-idfix
   sha `d68ec63696ee…` for the rest)
3. §B grounded clean-apply ≥ **85%**

New this cycle:

4. **novice-jam suite acceptable ≥ 16/25 = 64%** — r5's own standing bar
   (`LADDER-p1-p3-2026-08-17.md`, `LADDER-cal2-2026-08-18.md`), read with
   `--runner loop` against the same 25-task suite, same acceptability
   rubric, tagged `a3b-r7` (never overwriting the `-r5`/`-r5-cal2` files —
   per `LADDER-cal2-2026-08-18.md`'s own standing rule: "the v1-vs-cal2
   delta per model IS the experiment; overwriting the baseline destroys the
   comparison").
5. **The three named misses, tracked individually** (context/diagnostic,
   folded into leg 4's task list, not a separate pass/fail number):
   `compose-drums` category (`nj-drums-groove`, `nj-hats-more` — both 0/2 on
   the two r5 reads on file), `nj-amb-empty-middle` (the `create_section`
   ambiguity violation — failed both r5 reads), and lyric multi-step
   follow-through (named in `LADDER-cal2-2026-08-18.md` "Lessons with legs"
   §2; no single isolated novice-jam task failed this in the two r5 reads
   on file, so report the `lyrics` category result plus any multi-step ask
   elsewhere in the suite that exercises it).

Per `R6_FREEZE_MEMO.md` §5's own note (carried forward here verbatim):
**evalA floor families remain n=3–6** — one row flips a floor; report with
counts, not just rates.

## §6 — Honest caveats (registered up front, per this program's habit)

1. **The base-model choice (§1) is not neutral.** If option (b) is chosen,
   a miss on any leg could be the base swap, the brand-new MLX
   conversion/fuse path, or the data — three simultaneous unknowns, not
   one. Option (a) is the only choice that isolates data as the sole
   variable vs `a3b-r5-cuda`'s last passing gate.
2. **119 rows is 0.9% of the 13,113-row mix.** If leg 4/5 still misses after
   this fold-in, that's meaningful signal per `R7_TRAINING_PLAN.md` §4.3 —
   diagnose (dosage vs. competing-pattern dilution vs. a precision defect
   like the one `LOCAL_SERVE_READ_a3b-r5-mlx.md` found for `add_note`)
   before assuming a bigger corrective batch is the fix.
3. **No detached-run tooling exists for `a3b-r7` yet** on the CUDA side —
   `runpod_r4.py`/`launch-r4-cuda.sh` are r4-named; either rename/adapt them
   or drive `sft_cuda_train.py` directly and monitor manually.
4. **evalA floor families remain n=3–6** (carried forward from every prior
   cycle's caveat list, still true).
5. **This memo does not add a second corrective data batch.** If leg 4/5
   misses, diagnose first (§6.2) — any further corrective rows are a
   **new** cycle's pre-registration, not a silent edit to this one, per the
   same standing rule `R6_FREEZE_MEMO.md` §6.5 states for its own cycle.
6. **`s2-mix-v6-prep` is a candidate mix, not a frozen artifact until this
   memo freezes.** Per this program's own precedent (`README.md` "R5 prep
   while r4 runs"), building it now does not obligate training on it — if
   the owner instead wants r6's result first, or wants to fold these rows
   onto a *different* future base, this memo simply never gets its §1 boxes
   checked and `a3b-r7` never launches; the data and this plan still stand
   as documented prep, same as `s2-mix-v5-prep` did for r5 before it froze.

---

## Disposition (fill in after the read; do not edit §1–§6 above)

- Adapter sha256: ‹TBD›
- Training completion: ‹TBD› (steps / wall-clock actual vs §4 projection)
- Gate read date: ‹TBD›
- Result: ‹TBD — PASS / MISS (name the leg) / HALT / incomplete-run›
- Disposition: ‹TBD›
