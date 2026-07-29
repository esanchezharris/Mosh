#!/usr/bin/env bash
# The Vast.ai FIM-bridge lane (I4 sweeps) — money-safety is the DESIGN, not a habit.
#
# Four independent guards against the 2026-07-19 failure mode (a box billing
# ~61h idle because nothing re-ran after a raced upload):
#   G1  trap-destroy: the instance is destroyed on EXIT, INT, TERM, or ERR of
#       THIS driver — success and failure pay the same cleanup.
#   G2  on-box TTL backstop: the instance powers ITSELF off after --ttl-hours
#       (default 5) even if this Mac sleeps or dies; a stopped box bills
#       storage pennies, and the next audit's assert-empty catches the corpse.
#   G3  preflight audit: refuses to start while ANY instance exists on the
#       account (no silent doubling; --allow-existing to override).
#   G4  postflight assert-empty: after destroy, POLLS `show instances` until
#       the account is empty — destroy is async, and "the command returned 0"
#       is not "the billing stopped".
# Sequencing per NEXT_ATTEMPT.md: every step strictly ordered, nothing
# concurrent with an upload. Run under caffeinate so the Mac can't sleep away
# from guard G1:   caffeinate -is service/lyrics/bench/vast_fim_lane.sh ...
#
# Usage: vast_fim_lane.sh --data <mlx-data dir> --serve-config <adapter_config.json>
#                         --out <local peft-out dir>
#                         [--iters 1500] [--batch 16] [--lr 2e-5]
#                         [--max-dph 0.60] [--ttl-hours 5] [--gpu RTX_A6000]
# GPU note: the dequantized bf16 base is ~28GB — a 24GB 4090 cannot hold
# it, and a 5090 (sm_120) cannot run the torch-2.5.1 image. A6000 (48GB)
# fits both the model and the price cap.
set -euo pipefail

DATA="" SERVE_CFG="" OUT="" ITERS=1500 BATCH=16 LR=2e-5
MAX_DPH=0.60 TTL_HOURS=5 GPU="RTX_A6000" ALLOW_EXISTING=0
while [ $# -gt 0 ]; do
  case "$1" in
    --data) DATA="$2"; shift 2;;
    --serve-config) SERVE_CFG="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    --iters) ITERS="$2"; shift 2;;
    --batch) BATCH="$2"; shift 2;;
    --lr) LR="$2"; shift 2;;
    --max-dph) MAX_DPH="$2"; shift 2;;
    --ttl-hours) TTL_HOURS="$2"; shift 2;;
    --gpu) GPU="$2"; shift 2;;
    --allow-existing) ALLOW_EXISTING=1; shift;;
    *) echo "unknown arg $1" >&2; exit 2;;
  esac
done
[ -n "$DATA" ] && [ -n "$SERVE_CFG" ] && [ -n "$OUT" ] || {
  echo "need --data --serve-config --out" >&2; exit 2; }

export PATH="$HOME/.local/bin:$PATH"
# The account-registered key (vastai show ssh-keys) — the default identity
# is NOT registered, and "Permission denied (publickey)" cost the first run.
VAST_SSH_KEY="${VAST_SSH_KEY:-$HOME/.ssh/mosh_vast}"
[ -f "$VAST_SSH_KEY" ] || { echo "no ssh key at $VAST_SSH_KEY" >&2; exit 2; }
SSH_OPTS="-i $VAST_SSH_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=no"
HERE="$(cd "$(dirname "$0")" && pwd)"
INSTANCE_ID=""
T0=$(date +%s)
DPH="?"

log() { echo "[vast-lane $(date +%H:%M:%S)] $*"; }

destroy() {
  local rc=$?
  set +e
  if [ -n "$INSTANCE_ID" ]; then
    log "G1: destroying instance $INSTANCE_ID (driver exit rc=$rc)"
    # --yes is LOAD-BEARING: without it the CLI prompts, reads EOF as
    # "Aborted", and exits 0 — the 2026-07-28 first run left the box
    # billing behind a swallowed prompt. Errors go to the log, never /dev/null.
    vastai destroy instance "$INSTANCE_ID" --yes 2>&1 | tail -1
    # G4: destroy is async — poll until the account is actually empty.
    for i in $(seq 1 30); do
      left=$(vastai show instances --raw 2>/dev/null | python3 -c \
        "import json,sys;print(len(json.load(sys.stdin)))" 2>/dev/null || echo "?")
      [ "$left" = "0" ] && break
      [ $((i % 5)) -eq 0 ] && vastai destroy instance "$INSTANCE_ID" --yes 2>&1 | tail -1
      sleep 10
    done
    if [ "$left" = "0" ]; then
      log "G4: account empty — billing stopped."
    else
      log "G4 FAILED: $left instance(s) still on the account — DESTROY MANUALLY NOW:"
      vastai show instances 2>/dev/null
    fi
    el=$(( $(date +%s) - T0 ))
    log "lifetime $((el / 60))m — est. cost ~\$$(python3 -c \
      "print(f'{$el/3600*float(\"$DPH\" if \"$DPH\" != \"?\" else 0):.2f}')")"
  fi
  exit $rc
}
trap destroy EXIT INT TERM

# ── G3 preflight: no strays ──────────────────────────────────────────────────────
N_EXIST=$(vastai show instances --raw | python3 -c \
  "import json,sys;print(len(json.load(sys.stdin)))")
if [ "$N_EXIST" != "0" ] && [ "$ALLOW_EXISTING" != "1" ]; then
  echo "REFUSING: $N_EXIST instance(s) already billing on the account:" >&2
  vastai show instances >&2
  exit 3
fi

# ── offer: cheapest matching GPU under the price cap ─────────────────────────────
log "searching offers: $GPU, disk>60GB, dph<=$MAX_DPH"
OFFER=$(vastai search offers \
  "gpu_name=$GPU num_gpus=1 disk_space>60 inet_down>400 rentable=true verified=true dph<=$MAX_DPH" \
  -o dph --raw | python3 -c "
import json, sys
offers = json.load(sys.stdin)
if not offers: sys.exit(4)
o = offers[0]
print(o['id'], o['dph_total'])")
OFFER_ID=$(echo "$OFFER" | cut -d' ' -f1)
DPH=$(echo "$OFFER" | cut -d' ' -f2)
log "offer $OFFER_ID at \$$DPH/hr"

# ── create, with the G2 TTL backstop in onstart ──────────────────────────────────
TTL_S=$((TTL_HOURS * 3600))
CREATE=$(vastai create instance "$OFFER_ID" \
  --image pytorch/pytorch:2.5.1-cuda12.4-cudnn9-devel \
  --disk 60 --ssh --direct --label mosh-fim-bridge \
  --onstart-cmd "nohup sh -c 'sleep $TTL_S; poweroff -f' >/dev/null 2>&1 &" \
  --raw)
INSTANCE_ID=$(echo "$CREATE" | python3 -c \
  "import json,sys;print(json.load(sys.stdin)['new_contract'])")
log "instance $INSTANCE_ID created (TTL backstop ${TTL_HOURS}h)"

# Account keys are NOT auto-attached unless marked default (none is) — both
# 2026-07-28 failures were this. Attach explicitly, per instance.
vastai attach ssh "$INSTANCE_ID" "$(cat "${VAST_SSH_KEY}.pub")" >/dev/null
log "ssh key attached to the instance"

# ── wait for ssh ─────────────────────────────────────────────────────────────────
for i in $(seq 1 60); do
  ST=$(vastai show instance "$INSTANCE_ID" --raw | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(d.get('actual_status') or '?', d.get('ssh_host') or '', d.get('ssh_port') or '')")
  STATUS=$(echo "$ST" | cut -d' ' -f1)
  SSH_HOST=$(echo "$ST" | cut -d' ' -f2)
  SSH_PORT=$(echo "$ST" | cut -d' ' -f3)
  [ "$STATUS" = "running" ] && [ -n "$SSH_HOST" ] && break
  sleep 10
done
[ "$STATUS" = "running" ] || { log "instance never reached running"; exit 5; }
SSH="ssh -p $SSH_PORT $SSH_OPTS -o ConnectTimeout=15 root@$SSH_HOST"
for i in $(seq 1 60); do $SSH true 2>/dev/null && break; sleep 10; done
$SSH true || { log "ssh never came up"; exit 5; }
log "ssh up: $SSH_HOST:$SSH_PORT"

# ── strictly-sequenced steps (the NEXT_ATTEMPT lesson) ───────────────────────────
log "1/6 pip install"
$SSH "pip install -q transformers peft safetensors numpy ml_dtypes huggingface_hub" \
  > /dev/null

log "2/6 upload code + data ($(du -sh "$DATA" | cut -f1)) — sequenced, then verified"
# Remote steps are staged as FILES, never inlined through ssh quoting — the
# `ssh pc` lesson: nested -Command/heredoc quoting corrupts silently.
STAGE=$(mktemp -d)
cat > "$STAGE/vast_dequant.py" <<'PYEOF'
import glob, json, sys
sys.path.insert(0, "/root")
import fim_bridge
snap = glob.glob("/root/.cache/huggingface/hub/models--mlx-community--"
                 "Qwen2.5-14B-Instruct-4bit/snapshots/*")[0]
print(json.dumps(fim_bridge.dequantize_checkpoint(snap, "/root/base-bf16")))
PYEOF
cat > "$STAGE/vast_train.py" <<'PYEOF'
import json, subprocess, sys
sys.path.insert(0, "/root")
import fim_bridge
recipe = fim_bridge.cuda_recipe(json.load(open("/root/adapter_config.json")))
cfg = {"base": "/root/base-bf16", "data": "/root/data", "out": "/root/peft-out",
       "recipe": recipe, "iters": int(sys.argv[1]), "batch": int(sys.argv[2]),
       "lr": float(sys.argv[3]), "seed": 20260728, "maxLength": 384}
sys.exit(subprocess.call(["python", "/root/_cuda_train_fim.py", json.dumps(cfg)]))
PYEOF
scp -q -P "$SSH_PORT" $SSH_OPTS \
  "$HERE/fim_bridge.py" "$HERE/_cuda_train_fim.py" "$SERVE_CFG" \
  "$STAGE/vast_dequant.py" "$STAGE/vast_train.py" \
  "root@$SSH_HOST:/root/"
rm -rf "$STAGE"
$SSH "mkdir -p /root/data"
scp -q -P "$SSH_PORT" $SSH_OPTS \
  "$DATA/train.jsonl" "$DATA/valid.jsonl" "root@$SSH_HOST:/root/data/"
$SSH "wc -l /root/data/train.jsonl /root/data/valid.jsonl"

log "3/6 download 4-bit base from HF (box-side, multi-Gbps)"
$SSH "python -c \"from huggingface_hub import snapshot_download as d; \
  print(d('mlx-community/Qwen2.5-14B-Instruct-4bit'))\"" | tail -1

log "4/6 dequantize on the box"
$SSH "cd /root && python vast_dequant.py"

log "5/6 train ($ITERS iters, batch $BATCH)"
$SSH "cd /root && PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True python vast_train.py $ITERS $BATCH $LR"

log "6/6 fetch the adapter(s)"
mkdir -p "$OUT"
scp -q -P "$SSH_PORT" $SSH_OPTS \
  "root@$SSH_HOST:/root/peft-out/adapter_model.safetensors" \
  "root@$SSH_HOST:/root/peft-out/adapter_config.json" "$OUT/"
# The best-val checkpoint (saved whenever a val block improves) — the first
# run's val minimum was mid-run and lost with the box. Fetch if it exists.
if $SSH "test -d /root/peft-out-best"; then
  mkdir -p "$OUT-best"
  scp -q -P "$SSH_PORT" $SSH_OPTS \
    "root@$SSH_HOST:/root/peft-out-best/adapter_model.safetensors" \
    "root@$SSH_HOST:/root/peft-out-best/adapter_config.json" "$OUT-best/"
  log "best-val adapter at $OUT-best"
fi
log "adapter at $OUT — the trap now destroys the box"
# trap fires here: destroy + assert-empty + cost report
