#!/usr/bin/env bash
# Autonomous SFT loop — one command: corpus → dataset (+brain back-translation) →
# LoRA train → fuse → serve → eval (local finetuned vs cloud baseline). Each stage is
# idempotent (skips when its artifact exists; FORCE=1 to redo). The reward is the
# deterministic verifier (clean-apply × gold-command recall) — no human, no audio.
#
#   service/training/autotrain.sh                 # run the whole loop
#   FORCE_DATA=1 service/training/autotrain.sh     # rebuild dataset, reuse the rest
#   ITERS=2500 BATCH=4 service/training/autotrain.sh
#
# Prereqs (one-time): service/flp/setup-flp.sh, service/sft/setup-sft.sh, and a brain
# key in ui/.env.local (for back-translation + the cloud baseline eval).
set -euo pipefail
cd "$(dirname "$0")/../.."          # repo root
ROOT="$(pwd)"

CORPUS="${CORPUS:-$HOME/mosh-corpus}"
TAG="${TAG:-sft-v1}"
DATA="$ROOT/service/sft/.sft-data/$TAG"
ADAPTER="$ROOT/service/sft/.adapters/$TAG"
FUSED="$ROOT/service/sft/.fused/$TAG"
PORT="${PORT:-8080}"
# knobs
ITERS="${ITERS:-1600}"; BATCH="${BATCH:-2}"; LAYERS="${LAYERS:-16}"
MIDI_SAMPLE="${MIDI_SAMPLE:-1500}"; MIDI_LIMIT="${MIDI_LIMIT:-16000}"
DAW_LIMIT="${DAW_LIMIT:-9000}"; BT_VARIANTS="${BT_VARIANTS:-4}"; BT_BUDGET="${BT_BUDGET:-60}"
EVAL_N="${EVAL_N:-300}"

say() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
[ -f service/sft/.sft.env ] || { echo "run service/sft/setup-sft.sh first"; exit 1; }
source service/sft/.sft.env   # SFT_PY

# ── 1. corpus ────────────────────────────────────────────────────────────────────
say "1/6 corpus → $CORPUS"
midi_n=$(find "$CORPUS" -type f -iname '*.mid' 2>/dev/null | wc -l | tr -d ' ')
if [ "${FORCE_CORPUS:-0}" = 1 ] || [ "$midi_n" -lt 1000 ]; then
  bash service/corpus/get_datasets.sh || true
  python3 service/corpus/scrape_packs.py || true
fi
echo "  midi=$(find "$CORPUS" -type f -iname '*.mid' | wc -l | tr -d ' ')  flp/als/rpp=$(find "$CORPUS" -type f \( -iname '*.flp' -o -iname '*.als' -o -iname '*.rpp' \) | wc -l | tr -d ' ')"

# ── 2. dataset (DAW + MIDI, brain back-translation, merged) ───────────────────────
say "2/6 dataset → $DATA"
if [ "${FORCE_DATA:-0}" = 1 ] || [ ! -f "$DATA/train.jsonl" ]; then
  ( cd ui
    # DAW projects (mixer/key/structure): every corpus subdir except midi/
    typeset -a DAW_ARGS
    for d in "$CORPUS"/*/; do [[ "$d" == */midi/ ]] || DAW_ARGS+=(--corpus "$d"); done
    npm run build-sft -- "${DAW_ARGS[@]}" --max 300 --limit "$DAW_LIMIT" \
      --backtranslate "$BT_BUDGET" --bt-variants "$BT_VARIANTS" --seed 7 --out "../service/sft/.sft-data/$TAG-daw"
    # MIDI bulk (note-population); reuse the DAW back-translation cache
    mkdir -p "../service/sft/.sft-data/$TAG-midi"
    cp -f "../service/sft/.sft-data/$TAG-daw/bt_cache.json" "../service/sft/.sft-data/$TAG-midi/bt_cache.json" 2>/dev/null || true
    npm run build-sft -- --corpus "$CORPUS/midi" --sample "$MIDI_SAMPLE" --limit "$MIDI_LIMIT" \
      --backtranslate "$BT_BUDGET" --bt-variants "$BT_VARIANTS" --seed 7 --out "../service/sft/.sft-data/$TAG-midi"
  )
  # merge (each half is source-grouped + leak-free; sources are disjoint)
  mkdir -p "$DATA"
  for f in train valid test test.eval; do cat "$DATA-daw/$f.jsonl" "$DATA-midi/$f.jsonl" > "$DATA/$f.jsonl"; done
  python3 - "$DATA" <<'PY'
import json, os, sys
d = sys.argv[1]
c = {s: sum(1 for _ in open(f"{d}/{s}.jsonl")) for s in ("train", "valid", "test", "test.eval")}
json.dump({"datasetVersion": "autotrain-merged", "counts": c}, open(f"{d}/manifest.json", "w"), indent=2)
print("  merged:", c)
PY
else echo "  exists — skip (FORCE_DATA=1 to rebuild)"; fi

# ── 3. train LoRA ────────────────────────────────────────────────────────────────
say "3/6 train LoRA → $ADAPTER  (iters=$ITERS batch=$BATCH layers=$LAYERS)"
if [ "${FORCE_TRAIN:-0}" = 1 ] || [ ! -f "$ADAPTER/adapters.safetensors" ]; then
  "$SFT_PY" service/sft/sft_cli.py train --data "$DATA" --out "$ADAPTER" \
    --iters "$ITERS" --batch-size "$BATCH" --num-layers "$LAYERS" --no-grad-checkpoint
else echo "  adapter exists — skip (FORCE_TRAIN=1 to retrain)"; fi

# ── 4. fuse ──────────────────────────────────────────────────────────────────────
say "4/6 fuse → $FUSED"
if [ "${FORCE_FUSE:-0}" = 1 ] || [ ! -d "$FUSED" ]; then
  "$SFT_PY" service/sft/sft_cli.py fuse --adapter "$ADAPTER" --out "$FUSED"
else echo "  fused model exists — skip"; fi

# ── 5. serve + 6. eval (finetuned local vs cloud baseline) ───────────────────────
say "5/6 serve fused model on :$PORT"
# HF_HUB_OFFLINE=1 pins the LOCAL model+tokenizer — without it mlx_lm.server can
# online-resolve a similarly-named HF repo and silently use ITS chat template,
# inflating eval scores (the documented false-0.89 artifact).
HF_HUB_OFFLINE=1 "$SFT_PY" -m mlx_lm server --model "$FUSED" --port "$PORT" >/tmp/mlx_server.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
until curl -s "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1; do sleep 1; done
SERVED_ID=$(curl -s "http://127.0.0.1:$PORT/v1/models" | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"][0]["id"])')
echo "  served id: $SERVED_ID"

say "6/6 eval (n=$EVAL_N) — baseline=cloud brain, finetuned=local"
( cd ui
  npm run eval-sft -- --eval "$DATA/test.eval.jsonl" --tag baseline --n "$EVAL_N" || true
  MOSHI_BRAIN_PROVIDER=openai OPENAI_BASE_URL="http://127.0.0.1:$PORT/v1" OPENAI_MODEL="$SERVED_ID" OPENAI_API_KEY=local \
    npm run eval-sft -- --eval "$DATA/test.eval.jsonl" --tag finetuned --n "$EVAL_N" --model "$SERVED_ID" || true
)
echo
echo "================= AUTOTRAIN RESULT ================="
python3 - "$DATA" <<'PY'
import json, os, sys
d = sys.argv[1]
for tag in ("baseline", "finetuned"):
    p = f"{d}/eval_results.{tag}.json"
    if os.path.isfile(p):
        r = json.load(open(p))
        print(f"  {tag:10} clean-apply {r['cleanApply']:.3f}  ({r.get('deferrals',0)} defer / {r['examples']})")
print(f"\n  artifacts: adapter={os.path.basename(d)}  fused, eval_results.*.json in {d}")
PY
