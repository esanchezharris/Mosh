#!/usr/bin/env bash
# Pod-side bootstrap for the Mosh on-demand LoRA training server (Lane C).
#
# Runs ON a RunPod pod. Installs the proven SA3 training deps ONCE (mirrors
# ~/mosh-loras/work/pod_run_sa3.sh stage S0), patches the gated T5Gemma text encoder if
# a local copy was uploaded, then launches service/training/runpod_server.py — the plain-HTTP
# server that answers the Mosh `_remote_train` client (POST/GET /training/jobs).
#
# Layout it expects on the pod (upload like pod_run_sa3.sh does):
#   /workspace/stable-audio-3      the SA3 code tree (scripts/pre_encode_dataset.py + train_lora.py)
#   /workspace/mosh-service        this repo's service/ dir (for runpod_server.py + loras/install.py + sa3/lora_merge.py)
#   /workspace/t5gemma-b-b-ul2     (optional) the gated text encoder + /workspace/patch_t5gemma.py
#
# Usage:
#   nohup bash /workspace/mosh-service/training/runpod_serve.sh > /workspace/train-server.log 2>&1 &
#   tail -f /workspace/train-server.log        # wait for "listening on 0.0.0.0:8799"
#
# Then from the Mac, tunnel the port and point Mosh at it (see RUNPOD_RUNBOOK.md):
#   ssh -N -L 8799:localhost:8799 <pod>        # in one terminal
#   export MOSH_TRAINING_BACKEND=remote_http MOSH_TRAINING_REMOTE_URL=http://localhost:8799
set -uo pipefail
cd /workspace
PORT="${MOSH_TRAINER_PORT:-8799}"
export SA3_TRAIN_DIR="${SA3_TRAIN_DIR:-/workspace/stable-audio-3}"
MOSH_SERVICE="${MOSH_SERVICE_DIR:-/workspace/mosh-service}"

if [[ ! -d "$SA3_TRAIN_DIR" ]]; then echo "FATAL: SA3 code tree not at $SA3_TRAIN_DIR"; exit 1; fi
if [[ ! -f "$MOSH_SERVICE/training/runpod_server.py" ]]; then
  echo "FATAL: mosh service tree not at $MOSH_SERVICE (need training/runpod_server.py)"; exit 1
fi

if [[ ! -f .s0-serve-deps ]]; then
  echo "=== [$(date -u +%F' '%T)] installing SA3 training deps (once) ==="
  # some hosts ship broken DNS — repoint before any network use (from pod_run_sa3.sh)
  getent hosts pypi.org >/dev/null 2>&1 || printf "nameserver 8.8.8.8\nnameserver 1.1.1.1\n" > /etc/resolv.conf
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y -qq ffmpeg >/dev/null 2>&1 || true
  pip install -q -e "$SA3_TRAIN_DIR" || { echo "FATAL deps"; exit 1; }
  # undeclared deps + the torchvision ABI clash workaround (proven on the r1..r5 runs)
  pip install -q dill pytorch_lightning wandb matplotlib pillow tqdm safetensors || { echo "FATAL extras"; exit 1; }
  pip uninstall -q -y torchvision 2>/dev/null || true
  TORCH_V=$(python -c "import torch; print(torch.__version__.split('+')[0])")
  pip install -q "torchaudio==${TORCH_V}" || { echo "FATAL torchaudio"; exit 1; }
  touch .s0-serve-deps
fi

# T5Gemma is the one GATED piece — patch the locally-uploaded copy (mirrors pod_run_sa3.sh S1.5).
if [[ -d /workspace/t5gemma-b-b-ul2 && -f /workspace/patch_t5gemma.py && ! -f .s1-t5gemma ]]; then
  echo "=== patching T5Gemma ==="
  if python /workspace/patch_t5gemma.py 2>&1 | tail -3 | grep -q "T5GEMMA-VALIDATED"; then
    touch .s1-t5gemma
  else
    echo "WARN: T5Gemma patch did not validate — training may fail until it is fixed"
  fi
fi

echo "=== [$(date -u +%F' '%T)] launching Mosh training server on :$PORT (real SA3 backend) ==="
exec python3 "$MOSH_SERVICE/training/runpod_server.py" --port "$PORT" --host 0.0.0.0
