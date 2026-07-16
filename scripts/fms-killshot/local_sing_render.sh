#!/usr/bin/env bash
# LOCAL SoulX sing render — the $0, fully-on-this-Mac replacement for the Vast lane.
# Uses the MLX-converted SoulX-Singer at ~/AI/soulx-mac (bf16 safetensors through the
# official PyTorch bridge on MPS — the lane asserted_proof_runtime.py proved; measured
# 2026-07-16 on the M1 Max: a 12.5s chunk renders in ~44s wall incl. model load).
#
# Renders EVERY staged chunk score in sing-handoff/scores/ and lands each at
# asserted-proof/voice-soulx-<name>.wav — byte-for-byte the Vast pull contract, so
# finish.py's assemble/snap path works unchanged.
#
#   ./local_sing_render.sh            # render all staged scores
#   SOULX_MAC_DIR=... ./local_sing_render.sh
set -euo pipefail

MAC="${SOULX_MAC_DIR:-$HOME/AI/soulx-mac}"
BRIDGE="$MAC/SoulX-Singer-MLX"
PY="$MAC/venv/bin/python"
HANDOFF="$HOME/mosh-fms-ksb/used2/asserted-proof/back-half/sing-handoff"
SERVE="$HOME/mosh-fms-ksb/used2/asserted-proof"

[[ -x "$PY" && -d "$BRIDGE/models/SoulX-Singer-bf16" ]] || { echo "no local SoulX at $MAC"; exit 1; }
[[ -f "$HANDOFF/refs/own-30s.wav" && -f "$HANDOFF/refs/own-30s.json" ]] || { echo "no enrolled ref in $HANDOFF/refs"; exit 1; }
ls "$HANDOFF"/scores/*.json >/dev/null 2>&1 || { echo "no staged scores in $HANDOFF/scores"; exit 1; }

T0=$SECONDS
for S in "$HANDOFF"/scores/*.json; do
  NAME="$(basename "$S" .json)"
  OUTD="$MAC/renders/$NAME"
  mkdir -p "$OUTD"
  echo "== $NAME ($(date +%H:%M:%S))"
  (cd "$BRIDGE" && PYTHONPATH="$BRIDGE" PYTORCH_ENABLE_MPS_FALLBACK=1 \
     "$PY" scripts/inference_mlx_bridge.py \
       --model models/SoulX-Singer-bf16 --component svs --control score --device mps \
       --prompt_wav_path "$HANDOFF/refs/own-30s.wav" \
       --prompt_metadata_path "$HANDOFF/refs/own-30s.json" \
       --target_metadata_path "$S" \
       --phoneset_path soulxsinger/utils/phoneme/phone_set.json \
       --n_steps 32 --cfg 3.0 --pitch_shift 0 --save_dir "$OUTD") >"$OUTD/render.log" 2>&1 \
    || { echo "FAILED — tail of $OUTD/render.log:"; tail -5 "$OUTD/render.log"; exit 1; }
  ffmpeg -y -i "$OUTD/generated.wav" "$SERVE/voice-soulx-$NAME.wav" >/dev/null 2>&1
  echo "   -> $SERVE/voice-soulx-$NAME.wav"
done
echo "done: $(ls "$HANDOFF"/scores/*.json | wc -l | tr -d ' ') chunks in $((SECONDS - T0))s, \$0, no instance to destroy"
