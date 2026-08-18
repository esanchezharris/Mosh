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

### 2.1 Refresh the embedded system prompt — ✅ DONE (2026-08-17, `claude/r7-prep`)

Ran exactly as prescribed:

```sh
cd ui && npx tsx scripts/build_assist_sft.mts
# → wrote 35 verified assist demonstrations (0 skipped) → service/sft/assist_demonstrations.jsonl
cd ../service/sft && python3 validate_system_prompt_drift.py
```

The drift check did **not** go straight to OK. It still reported "2
command(s) in the embedded system prompt no longer exist in the current
catalog: `['set_clip_fade', 'set_clip_loop']`" — but this was a **false
positive**, not real staleness: both commands are very much still in
`ui/src/agent/commands.ts` (lines 102/107). Root cause: `sft_catalog.py`'s
`_COMMAND_LINE_RE` used `re.M` without `re.S`, so it silently dropped any
`AGENT_COMMANDS` entry whose `args: [...]` wraps onto a second source line
(`set_clip_fade`/`set_clip_loop` are the only two that do) — `load_catalog()`
returned 155 of the real 157 entries with no error. Fixed by adding `re.S`
to the regex flags (see `sft_catalog.py`'s inline comment for the full
explanation). After the fix, `load_catalog()` returns all 157 commands and:

```
$ python3 validate_system_prompt_drift.py
OK: no known drift between the embedded system prompt and the current catalog/rules.
```

`build_r7_coverage_sft.py`'s `SYSTEM` constant needed no change (it already
loads `assist_demonstrations.jsonl` row 0 at runtime, as this file
predicted) — re-ran:

```sh
python3 build_r7_coverage_sft.py
# → wrote 119 validated rows, sha256 392262600bc922b17fa863cdd5b26362f38fb24daa0b57ed3f57ac06ccb60150
python3 validate_sft_rows.py r7_coverage_demonstrations.jsonl
# → OK: 119 row(s) across 1 file(s), 0 violations (157 commands / 8 intents cross-checked)
python3 -m pytest validate_sft_rows_test.py -q
# → 16 passed
```

New sha256 (`392262600bc9…`) differs from the committed one
(`c596ba5ee760…`) — confirmed, per this file's own prediction.

### 2.2 Build the candidate mix — ✅ DONE (2026-08-17, owner's Mac)

One deviation from the illustrative command below: `.sft-data/s2-mix-v5/`
does not exist on disk under that literal name — the real dir is
`.sft-data/s2-mix-v5-prep/` (the same "prep while the prior cycle runs"
naming `prepare_r5_prep.py` uses; it was never renamed after freezing).
Verified byte-identical to `R6_FREEZE_MEMO.md` §3's frozen v5 shas before
using it as the base, so this is genuinely v5's content, not a lookalike.
`.sft.env` also does not currently exist on disk in either checkout
(gitignored, machine-local, apparently not regenerated since the last
`setup-sft.sh` run) — invoked the venv interpreter directly
(`~/Library/Mosh/venvs/sft/bin/python3`) instead of sourcing it.

```sh
OUT=.sft-data/s2-mix-v6-prep
mkdir -p "$OUT"
cp .sft-data/s2-mix-v5-prep/train.jsonl "$OUT/train.jsonl"   # sha 3c4e2e8b… matches frozen v5
cp .sft-data/s2-mix-v5-prep/valid.jsonl "$OUT/valid.jsonl"   # sha 9047ab96… matches frozen v5
cat r7_coverage_demonstrations.jsonl >> "$OUT/train.jsonl"    # 12,994 + 119 = 13,113
~/Library/Mosh/venvs/sft/bin/python3 filter_by_length.py \
  --model ~/AI/models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit --data "$OUT" --max-seq 4096
# → train.jsonl: 13113 -> 13113 (over-max 0, no-completion-room 0)
# → valid.jsonl: 1650 -> 1650 (over-max 0, no-completion-room 0)
```

Final: train **13,113 rows**, sha256
`9e8853344d2ac111ae6da5f239b71017b97815f394d6335fae94a9aa4549dbaf`; valid
**1,650 rows**, sha256
`9047ab96fd7e8f7f2155d6acc9c9b391c7989ed6205d119c46be764dfa4f3638`
(unchanged from v5 — valid split not touched by the append). Full build
record: `.sft-data/s2-mix-v6-prep/manifest.json`.

(A proper `prepare_r7_prep.py` mirroring `prepare_r5_prep.py` — audit-gated,
manifest-hashed, refusing to run if the target it's building on doesn't match
what it expects — is still the more disciplined version of the above; still
not built, same reasoning this file already gave.)

### 2.3 Pre-register before training on it — FROZEN 2026-08-18, launch under way

`R7_TRAINING_PLAN.md` / `R7_FREEZE_MEMO.md` now exist (2026-08-17,
`claude/r7-prep`), mirroring `R6_TRAINING_PLAN.md`/`R6_FREEZE_MEMO.md`'s
shape, naming: the mix's row count/sha256 (§2.2 above), the recipe
(`a3b-r5-cuda`'s CUDA/trl+peft lane, reused verbatim — **not** r6's
untested local-MLX lane, so no confound with r6's still-open experiment),
and the gate (the standing §P9 legs plus a new novice-jam-suite leg reading
against r5's own 16/25 bar with the three named misses tracked
individually). **Status: FROZEN 2026-08-18 — the owner resolved
`R7_FREEZE_MEMO.md` §1 to base (a) `Qwen/Qwen3-30B-A3B-Instruct-2507` (clean
single-variable read) and the memo is frozen (checkbox + status line +
commit). Launch is under way on a recorded lane deviation — local MLX rather
than the frozen §2a cloud lane, after provider failures; see the memo's
post-freeze deviation notes (incl. the max_seq_length NaN incident and its
fix). Remaining:**

1. Complete the launch per `R7_TRAINING_PLAN.md` §2.1 as deviated.
2. Gate per `R7_TRAINING_PLAN.md` §3 / `R7_FREEZE_MEMO.md` §5, using
   `EVAL_RUNBOOK.md` for the standing legs and the novice-jam suite for the
   new one.

None of r6's own files (`R6_TRAINING_PLAN.md`/`R6_FREEZE_MEMO.md`/
`s2-mix-v5`) are touched by anything in this section — r6 remains exactly
as §1 above describes it, untouched and separately gated.
