#!/usr/bin/env bash
# One-score SoulX render on a rented CUDA pod (lean fork of the proven KS-A
# remote_run.sh: inference env + weights ONLY — refs arrive PRE-TRANSCRIBED so the
# heavy NeMo preprocess env is skipped entirely). Idempotent; runs inside tmux.
# Inputs at ~/sing/handoff: scores/target_score.json, refs/own-{10s,30s}.{wav,json}
set -uo pipefail
WORKDIR="$HOME/sing"
HANDOFF="$WORKDIR/handoff"
SOULX="$WORKDIR/SoulX-Singer"
OUT="$WORKDIR/out"
LOG="$WORKDIR/logs"
mkdir -p "$OUT" "$LOG"
say() { echo "[sing $(date +%H:%M:%S)] $*"; }
die() { echo "[sing] FATAL: $*" >&2; touch "$WORKDIR/FAILED"; exit 1; }

[[ -f "$HANDOFF/scores/target_score.json" ]] || die "no target score"
[[ -f "$HANDOFF/refs/own-30s.wav" && -f "$HANDOFF/refs/own-30s.json" ]] || die "refs incomplete"
command -v nvidia-smi >/dev/null || die "no GPU"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | tee "$LOG/gpu.txt"

if command -v conda >/dev/null; then CONDA=conda; else
  export MAMBA_ROOT_PREFIX="$WORKDIR/micromamba"
  if [[ ! -x "$WORKDIR/bin/micromamba" ]]; then
    say "bootstrapping micromamba …"
    mkdir -p "$WORKDIR/bin"
    curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest \
      | tar -xj -C "$WORKDIR" bin/micromamba || die "micromamba bootstrap failed"
  fi
  CONDA="$WORKDIR/bin/micromamba"
fi
ENVDIR="$WORKDIR/env"
PY="$ENVDIR/bin/python"

# ── setup (KS-A-proven inference recipe verbatim; ~15-25 min first run) ──
[[ -d "$SOULX" ]] || git clone -q https://github.com/Soul-AILab/SoulX-Singer "$SOULX" || die "clone failed"
if [[ ! -x "$PY" ]]; then
  say "creating python 3.10 env …"
  "$CONDA" create -y -p "$ENVDIR" -c conda-forge python=3.10 >"$LOG/env.log" 2>&1 || die "env create failed"
fi
if ! "$PY" -c "import soundfile" >/dev/null 2>&1; then
  say "installing requirements (slow step — logs/pip.log) …"
  "$PY" -m pip install -q "setuptools<82" >"$LOG/pip.log" 2>&1
  "$PY" -m pip install -q -r "$SOULX/requirements.txt" >>"$LOG/pip.log" 2>&1 || die "pip failed (logs/pip.log)"
  "$PY" -m pip install -q "huggingface_hub[cli]" >>"$LOG/pip.log" 2>&1
fi
if [[ ! -f "$SOULX/pretrained_models/SoulX-Singer/model.pt" ]]; then
  say "downloading weights (~6 GB) …"
  "$PY" -m huggingface_hub.commands.huggingface_cli download Soul-AILab/SoulX-Singer \
    --local-dir "$SOULX/pretrained_models/SoulX-Singer" >"$LOG/hf.log" 2>&1 \
    || "$ENVDIR/bin/hf" download Soul-AILab/SoulX-Singer --local-dir "$SOULX/pretrained_models/SoulX-Singer" >"$LOG/hf.log" 2>&1 \
    || die "weights download failed (logs/hf.log)"
fi

# install smoke: their bundled example (isolates broken-stack from broken-score)
if [[ ! -f "$OUT/_smoke/done" ]]; then
  say "install smoke (their example) …"
  ( cd "$SOULX" && PYTHONPATH="$SOULX" "$PY" -m cli.inference --device cuda \
      --model_path pretrained_models/SoulX-Singer/model.pt \
      --config soulxsinger/config/soulxsinger.yaml \
      --prompt_wav_path example/audio/zh_prompt.mp3 \
      --prompt_metadata_path example/audio/zh_prompt.json \
      --target_metadata_path example/audio/en_target.json \
      --phoneset_path soulxsinger/utils/phoneme/phone_set.json \
      --control score --auto_shift --pitch_shift 0 --fp16 \
      --save_dir "$OUT/_smoke" ) >"$LOG/smoke.log" 2>&1 || die "install smoke failed (logs/smoke.log)"
  touch "$OUT/_smoke/done"
fi

# ── render: the owner's score, both references ──
for ref in own-30s own-10s; do
  if [[ ! -f "$OUT/renders/$ref/done" ]]; then
    say "rendering with $ref reference …"
    mkdir -p "$OUT/renders/$ref"
    ( cd "$SOULX" && PYTHONPATH="$SOULX" "$PY" -m cli.inference --device cuda \
        --model_path pretrained_models/SoulX-Singer/model.pt \
        --config soulxsinger/config/soulxsinger.yaml \
        --prompt_wav_path "$HANDOFF/refs/$ref.wav" \
        --prompt_metadata_path "$HANDOFF/refs/$ref.json" \
        --target_metadata_path "$HANDOFF/scores/target_score.json" \
        --phoneset_path soulxsinger/utils/phoneme/phone_set.json \
        --control score --auto_shift --pitch_shift 0 --fp16 \
        --save_dir "$OUT/renders/$ref" ) >"$LOG/render-$ref.log" 2>&1 || die "render $ref failed (logs/render-$ref.log)"
    touch "$OUT/renders/$ref/done"
  fi
done

say "packing results …"
tar -czf "$WORKDIR/sing-out.tar.gz" -C "$WORKDIR" out/renders logs || die "tar failed"
touch "$WORKDIR/DONE"
say "ALL DONE"
