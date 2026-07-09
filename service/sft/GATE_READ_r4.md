# r4 gate-read runbook (§P8, ONE clean read)

The r4 training run (`.adapters/a3b-r4`, batch 1 × 12,889 iters ≈ 1 epoch of
`s2-mix-v4`) writes its final adapter on completion. This is the disciplined,
trap-proof procedure to read the **pre-registered** exit gate
(`docs/bench/PROGRAM_STAGE1_2026-07.md` §P8):

> aggregate §A+§C ≥ 0.75 · per-command floor ≥ 0.5 on the measurable rows after the
> recorded exclusions · §B grounded clean-apply ≥ 85%. ONE clean read — any miss ⇒
> HALT-and-report.

The executable entrypoint is `./run-gate-r4.sh`; it records status in
`.adapters/a3b-r4.gate.status` and appends the raw run log to
`.adapters/a3b-r4.gate.log`.

**Serving discipline (permanent, trap #4):** `mlx_lm.server --adapter-path` silently
serves BASE weights. ALWAYS fuse first, weight-check the fused shard, then serve the
fused dir. ONE mlx proc at a time — confirm r4 training has EXITED before serving.

```sh
cd service/sft
./run-gate-r4.sh
```

Equivalent manual sequence, if you need to inspect a failed step:

```sh
cd service/sft && source .sft.env
BASE=/Users/emiliosanchez-harris/AI/models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit

# 0. Confirm training done + no mlx proc.
pgrep -fl mlx_lm && echo "WAIT — mlx still running" && exit 1
tail -3 .adapters/a3b-r4.train.log

# 1. Fuse.
"$SFT_PY" sft_cli.py fuse --model "$BASE" --adapter .adapters/a3b-r4 --out .fused/a3b-r4

# 2. Weight-check: shard-4 MUST differ from base; shard-1 SHOULD match base.
B4=$(shasum -a 256 "$BASE/model-00004-of-00004.safetensors" | awk '{print $1}')
F4=$(shasum -a 256 .fused/a3b-r4/model-00004-of-00004.safetensors | awk '{print $1}')
B1=$(shasum -a 256 "$BASE/model-00001-of-00004.safetensors" | awk '{print $1}')
F1=$(shasum -a 256 .fused/a3b-r4/model-00001-of-00004.safetensors | awk '{print $1}')
[ "$B4" != "$F4" ] || { echo "FAIL: shard4 == base — fuse produced base weights"; exit 1; }
[ -z "$B1" ] || [ "$B1" = "$F1" ] || echo "NOTE: shard1 != base (unexpected for last-16-layer LoRA — investigate)"
echo "weight-check OK: shard4 tuned, shard1 base"

# 3. Serve the fused dir + identity probe.
"$SFT_PY" -m mlx_lm.server --model "$(pwd)/.fused/a3b-r4" --port 8080 &
SVID=$!; sleep 20
curl -s http://127.0.0.1:8080/v1/models | grep -Fq "$(pwd)/.fused/a3b-r4" || {
  echo "identity probe FAIL"; kill "$SVID"; exit 1;
}
```

Then, in `ui/` with `OPENAI_BASE_URL=http://127.0.0.1:8080/v1` + a dummy key, run the
three legs over the frozen files:

```sh
cd ../../ui
export OPENAI_BASE_URL=http://127.0.0.1:8080/v1 OPENAI_API_KEY=local MOSHI_BRAIN_PROVIDER=openai
npm run eval-sft -- --eval ../service/sft/.sft-data/frozen300/test.eval.jsonl --rules plain --no-think --n 300 --tag a3b-r4-C
npm run eval-sft -- --eval ../service/sft/.sft-data/eval-v2/evalA.eval.jsonl --rules plain --no-think --tag a3b-r4-A
npx tsx scripts/evalV2Grounded.mts --base http://127.0.0.1:8080/v1 --model "$(pwd)/../service/sft/.fused/a3b-r4" --tag a3b-r4 --no-think
kill "$SVID"
```

Gate table (record in §R, then decide):
- aggregate = mean(§A-valid, §C) ≥ 0.75 ?
- min per-command floor over the measurable §A rows ≥ 0.5 ?
- §B grounded clean-apply ≥ 85% ?

**Pass** ⇒ continue the next program step. **Miss** ⇒ HALT-and-report; the gate does
not move (P8: one clean read, no retry this cycle). Either way, record the full table
+ serving fingerprint in `docs/bench/PROGRAM_STAGE1_2026-07.md` §R.
