#!/usr/bin/env bash
# FMS Phase-3 Stage 3 (owner decision 2026-07-04): render a SoulX sing job on the
# OWNER'S PC over SSH — voice data never leaves his own hardware; $0/render; no
# spin-up. Called by adapters/soulx_adapter.py when the real backend is configured
# (MOSH_SOULX_SSH_HOST + an enrolled voice). Bring-up: service/soulx/PC_RUNBOOK.md.
#
#   pc_render.sh <target_score.json> <voice_reference.wav> <output.wav>
#
# Env:
#   MOSH_SOULX_SSH_HOST    required — ssh target (an ~/.ssh/config alias recommended)
#   MOSH_SOULX_REMOTE_DIR  remote dir under $HOME holding SoulX-Singer/ + env/
#                          (default: mosh-soulx)
#
# The enrolled reference needs its SoulX prompt metadata SIBLING (<ref>.json —
# produced ONCE during enrollment, see the runbook): the model must know what the
# reference itself sings. The inference invocation is byte-for-byte the KS-A-proven
# one (grid renders rated 6/6 by the owner). The remote job dir is REMOVED after the
# pull — no voice data accumulates on the PC beyond the enrollment itself.
set -euo pipefail

SCORE="${1:?usage: pc_render.sh <target_score.json> <voice_ref.wav> <output.wav>}"
REF="${2:?missing voice reference}"
OUT="${3:?missing output path}"
HOST="${MOSH_SOULX_SSH_HOST:?MOSH_SOULX_SSH_HOST not set (see PC_RUNBOOK.md)}"
RDIR="${MOSH_SOULX_REMOTE_DIR:-mosh-soulx}"

REFMETA="${REF%.wav}.json"
if [[ ! -f "$REFMETA" ]]; then
  echo "enrollment metadata missing: $REFMETA — run the one-time enrollment preprocess" \
       "on the PC (PC_RUNBOOK.md §3) and copy the json back next to the reference" >&2
  exit 2
fi

JOB="sing-$$-$(python3 -c 'import time; print(int(time.time()))')"
SSHOPTS=(-o BatchMode=yes -o ConnectTimeout=10)

ssh "${SSHOPTS[@]}" "$HOST" "mkdir -p \$HOME/$RDIR/jobs/$JOB"
scp -q "${SSHOPTS[@]}" "$SCORE"   "$HOST:$RDIR/jobs/$JOB/target.json"
scp -q "${SSHOPTS[@]}" "$REF"     "$HOST:$RDIR/jobs/$JOB/prompt.wav"
scp -q "${SSHOPTS[@]}" "$REFMETA" "$HOST:$RDIR/jobs/$JOB/prompt.json"

ssh "${SSHOPTS[@]}" "$HOST" bash -s <<EOF
set -euo pipefail
cd "\$HOME/$RDIR/SoulX-Singer"
PYTHONPATH=. "\$HOME/$RDIR/env/bin/python" -m cli.inference --device cuda \
  --model_path pretrained_models/SoulX-Singer/model.pt \
  --config soulxsinger/config/soulxsinger.yaml \
  --prompt_wav_path "\$HOME/$RDIR/jobs/$JOB/prompt.wav" \
  --prompt_metadata_path "\$HOME/$RDIR/jobs/$JOB/prompt.json" \
  --target_metadata_path "\$HOME/$RDIR/jobs/$JOB/target.json" \
  --phoneset_path soulxsinger/utils/phoneme/phone_set.json \
  --control score --auto_shift --pitch_shift 0 --fp16 \
  --save_dir "\$HOME/$RDIR/jobs/$JOB/out"
EOF

# Pull the (single) rendered clip back, then remove the remote job dir (voice hygiene).
scp -q "${SSHOPTS[@]}" "$HOST:$RDIR/jobs/$JOB/out/*.wav" "$OUT"
ssh "${SSHOPTS[@]}" "$HOST" "rm -rf \$HOME/$RDIR/jobs/$JOB"
[[ -s "$OUT" ]] || { echo "render pulled but output is empty" >&2; exit 1; }
