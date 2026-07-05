# r3 gate-read runbook (§P7.4, ONE clean read)

The r3 training run (`.adapters/a3b-r3`, batch 1 × 12,674 iters ≈ 1 epoch) writes
its final adapter on completion. This is the disciplined, trap-proof procedure to
read the **re-registered** exit gate (docs/bench/PROGRAM_STAGE1_2026-07.md §P7.4):

> aggregate §A+§C ≥ 0.75 · per-command floor ≥ 0.5 on the 49 measurable · §B
> grounded clean-apply ≥ 85%. ONE clean read — any miss ⇒ HALT-and-report.

**Serving discipline (permanent, trap #4):** `mlx_lm.server --adapter-path` silently
serves BASE weights. ALWAYS fuse first, weight-check the fused shard, then serve the
fused dir. ONE mlx proc at a time — confirm r3 training has EXITED before serving.

```sh
cd service/sft && source .sft.env
BASE=/Users/emiliosanchez-harris/AI/models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit

# 0. Confirm training done + no mlx proc.
pgrep -fl mlx_lm && echo "WAIT — mlx still running" && exit 1
tail -3 .adapters/a3b-r3.train.log   # expect the final iter + saved adapter

# 1. Fuse.
"$SFT_PY" sft_cli.py fuse --model "$BASE" --adapter .adapters/a3b-r3 --out .fused/a3b-r3

# 2. Weight-check (VALIDATED against r2 fused, 2026-07-05): shard-4 MUST differ from
#    base (the last-16-layer LoRA lands there); shard-1 MUST equal base (untouched).
B4=$(shasum -a 256 "$BASE/model-00004-of-00004.safetensors" | awk '{print $1}')
F4=$(shasum -a 256 .fused/a3b-r3/model-00004-of-00004.safetensors | awk '{print $1}')
B1=$(shasum -a 256 "$BASE/model-00001-of-00004.safetensors" | awk '{print $1}')
F1=$(shasum -a 256 .fused/a3b-r3/model-00001-of-00004.safetensors | awk '{print $1}')
[ "$B4" != "$F4" ] || { echo "FAIL: shard4 == base — fuse produced base weights"; exit 1; }
[ "$B1" = "$F1" ] || echo "NOTE: shard1 != base (unexpected for last-16-layer LoRA — investigate)"
echo "weight-check OK: shard4 tuned, shard1 base"

# 3. Serve the FUSED dir + identity probe (pin by PATH).
"$SFT_PY" -m mlx_lm.server --model "$(pwd)/.fused/a3b-r3" --port 8080 &
SVID=$!; sleep 20
# identity probe — the served model id must be the fused PATH, not an HF-cache entry:
curl -s http://127.0.0.1:8080/v1/models | grep -q "a3b-r3" || { echo "identity probe FAIL"; kill $SVID; exit 1; }
```

Then, in `ui/` with `OPENAI_BASE_URL=http://127.0.0.1:8080/v1` + a dummy key, run the
three legs over the FROZEN files (never edit them — the pre-registration sha holds):

```sh
cd ../../ui
export OPENAI_BASE_URL=http://127.0.0.1:8080/v1 OPENAI_API_KEY=local MOSHI_BRAIN_PROVIDER=openai
# §C — frozen-300 (comparability anchor; cloud 0.875, untrained A3B 0.8808, r1 0.914, r2 0.907)
npm run eval-sft -- --eval ../service/sft/.sft-data/frozen300/test.eval.jsonl --rules plain --no-think --n 300 --tag a3b-r3-C
# §A — per-command floors (evalA sha de1d4cdb…; score VALID items only per the recorded amendment:
#      45 id-bearing items + build_skeleton_from_clip/sketch_beatbox are mock-broken, excluded)
npm run eval-sft -- --eval ../service/sft/.sft-data/eval-v2/evalA.eval.jsonl --rules plain --no-think --tag a3b-r3-A
# §B — grounded execution (real engine applies; sha f415b1f4…; cloud anchor 83.8%/75%)
npx tsx scripts/evalV2Grounded.mts --base http://127.0.0.1:8080/v1 --tag a3b-r3
kill $SVID   # free the mlx slot
```

Gate table (record in §R2, then decide):
- aggregate = mean(§A-valid, §C) ≥ 0.75 ?
- min per-command floor over the 49 measurable (valid §A items) ≥ 0.5 ?  ← the r1/r2 miss leg
  (`undo`/`redo`/`split_clip`/`set_render_param` are the watch-list; r3 gave them 236/236/272/112
  rows at ≥1 epoch vs r2's ~7 exposures — the amendment's whole point.)
- §B grounded clean-apply ≥ 85% ? (negative-defer tracked, not a leg)

**Pass** ⇒ WP-10 RFT rounds (split-provider driver; ⛳ stop <1 pt, max 2, retrain from
base) → close-out. **Miss** ⇒ HALT-and-report; the gate does NOT move (P7.4: one clean
read, no retry this cycle). Either way, record the full table + serving fingerprint in §R2.
