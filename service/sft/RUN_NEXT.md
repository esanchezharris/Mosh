# RUN_NEXT — after this pass

Two separate things. Read [`R6_COVERAGE_PREP_NOTE.md`](R6_COVERAGE_PREP_NOTE.md)
first if you haven't — it explains why they're separate.

## 1. r6 itself — unaffected, still exactly as pre-registered

Nothing in this pass changes `R6_TRAINING_PLAN.md` / `R6_FREEZE_MEMO.md` /
`s2-mix-v5`. Before launching, still resolve `R6_FREEZE_MEMO.md` §1's open
decision (option (a) accept the confound / (b) isolate precision — an
engineering task on `sft_cli.py` not yet done for (b)) and fill in / freeze
the memo per its own instructions. Then, per `R6_TRAINING_PLAN.md` §2
(cribbed verbatim, only the shell context added):

```sh
cd service/sft && source .sft.env
BASE=~/AI/models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit

"$SFT_PY" sft_cli.py train \
  --data .sft-data/s2-mix-v5 \
  --out .adapters/a3b-r6 \
  --model "$BASE" \
  --iters 12994 \
  --batch-size 1 \
  --num-layers 16 \
  --lr 1e-5 \
  --max-seq-length 4096
```

Run the §4 pace smoke first (12–25 iters) per the plan's own requirement
before committing to the full ~61–63h run. Gate per `R6_TRAINING_PLAN.md` §3 /
`R6_FREEZE_MEMO.md` §5, using `EVAL_RUNBOOK.md`. None of this pass's files are
inputs to any of the above.

## 2. Folding `r7_coverage_demonstrations.jsonl` into a future cycle

**Not yet done. Requires, in order:**

### 2.1 Refresh the embedded system prompt (mandatory — see the drift finding)

```sh
cd ui && npx tsx scripts/build_assist_sft.mts   # regenerates assist_demonstrations.jsonl against current HEAD
cd ../service/sft && python3 validate_system_prompt_drift.py   # should now report OK
```

Then re-point `build_r7_coverage_sft.py`'s `SYSTEM` constant at the freshly
regenerated row (it already loads it from `assist_demonstrations.jsonl` row 0
at runtime — no other code change needed) and re-run:

```sh
python3 build_r7_coverage_sft.py
python3 validate_sft_rows.py r7_coverage_demonstrations.jsonl
python3 -m pytest validate_sft_rows_test.py -q
```

Confirm the new sha256 in `r7_coverage_demonstrations.manifest.json` differs
from the one in this pass's commit (it should — the embedded prompt changed).

### 2.2 Build the candidate mix (once a base target exists to build on)

This step needs the actual `.sft-data/` tree, which is gitignored and not
present in a fresh worktree (same fact `EVAL_FIXTURE_AUDIT.md` and
`SFT_COVERAGE_MATRIX.md` both already document) — run it on a machine that
has it, i.e. the owner's Mac, mirroring `prepare_r5_prep.py`'s exact shape:

```sh
cd service/sft
# once a3b-r6 has landed (or whatever the base-mix target actually is —
# this is illustrative, NOT a command to run blind):
OUT=.sft-data/s2-mix-v6-prep
mkdir -p "$OUT"
cp .sft-data/s2-mix-v5/train.jsonl "$OUT/train.jsonl"
cp .sft-data/s2-mix-v5/valid.jsonl "$OUT/valid.jsonl"
cat r7_coverage_demonstrations.jsonl >> "$OUT/train.jsonl"
"$SFT_PY" filter_by_length.py --model ~/AI/models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit --data "$OUT" --max-seq 4096
```

(A proper `prepare_r7_prep.py` mirroring `prepare_r5_prep.py` — audit-gated,
manifest-hashed, refusing to run if the target it's building on doesn't match
what it expects — is the more disciplined version of the above; not built
here since there is no live "r6 is running, prep the next one" state to audit
against yet, unlike the r4→r5 case that script was built for.)

### 2.3 Pre-register before training on it

Per this program's own standing rule (quoted throughout
`R6_COVERAGE_PREP_NOTE.md`): **do not** silently train `a3b-r6` (or fold this
into any currently-frozen memo). Write a new `R7_TRAINING_PLAN.md` /
`R7_FREEZE_MEMO.md` pair (or whatever the next adapter id actually is —
decided after r6's own result is known) naming: the new mix's row count and
sha256 (from the regenerated manifest above), which base/precision it trains
against, and the gate it's read against — mirroring the shape
`R6_TRAINING_PLAN.md`/`R6_FREEZE_MEMO.md` already use. Then, and only then,
launch.
