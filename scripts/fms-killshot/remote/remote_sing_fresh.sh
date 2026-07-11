#!/usr/bin/env bash
# One-score SoulX render with a FRESH (un-transcribed) reference — the KS-A setup +
# preprocess (remote_run.sh, proven) trimmed to a SINGLE ref (own-30s) and a SINGLE
# render (no grid tool). Used when the original ref .json is gone and the pella slice
# must be transcribed on the pod. Idempotent; sentinels for unattended tmux polling.
#
#   bash remote_sing_fresh.sh   # inputs at ~/ksa/handoff: scores/target_score.json, refs/own-30s.wav
set -uo pipefail
WORKDIR="$HOME/ksa"
HANDOFF="$WORKDIR/handoff"
SOULX="$WORKDIR/SoulX-Singer"
OUT="$WORKDIR/out"
LOG="$WORKDIR/logs"
ENVDIR="$WORKDIR/env"
ENVPRE="$WORKDIR/env-pre"
mkdir -p "$WORKDIR" "$OUT" "$LOG"
rm -f "$WORKDIR/DONE" "$WORKDIR/FAILED"
say() { echo "[sing $(date +%H:%M:%S)] $*"; }
die() { echo "[sing] FATAL: $*" >&2; touch "$WORKDIR/FAILED"; exit 1; }

[[ -f "$HANDOFF/scores/target_score.json" ]] || die "no target score"
[[ -f "$HANDOFF/refs/own-30s.wav" ]] || die "no own-30s.wav ref"
command -v nvidia-smi >/dev/null || die "no GPU"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | tee "$LOG/gpu.txt"

if command -v conda >/dev/null; then CONDA=conda; else
  export MAMBA_ROOT_PREFIX="$WORKDIR/micromamba"
  if [[ ! -x "$WORKDIR/bin/micromamba" ]]; then
    say "bootstrapping micromamba …"; mkdir -p "$WORKDIR/bin"
    curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xj -C "$WORKDIR" bin/micromamba || die "micromamba bootstrap failed"
  fi
  CONDA="$WORKDIR/bin/micromamba"
fi

# ── setup: inference env + preprocess env (NeMo) + weights + preprocess models ──
[[ -d "$SOULX" ]] || git clone -q https://github.com/Soul-AILab/SoulX-Singer "$SOULX" || die "clone failed"
PY="$ENVDIR/bin/python"
if [[ ! -x "$PY" ]]; then
  say "creating inference env (py3.10) …"
  "$CONDA" create -y -p "$ENVDIR" -c conda-forge python=3.10 >"$LOG/env.log" 2>&1 || die "env create failed"
fi
if ! "$PY" -c "import soundfile" >/dev/null 2>&1; then
  say "installing inference requirements (slow — logs/pip.log) …"
  "$PY" -m pip install -q "setuptools<82" >"$LOG/pip.log" 2>&1
  "$PY" -m pip install -q -r "$SOULX/requirements.txt" >>"$LOG/pip.log" 2>&1 || die "pip failed (logs/pip.log)"
  "$PY" -m pip install -q "huggingface_hub[cli]" >>"$LOG/pip.log" 2>&1
fi
PYPRE="$ENVPRE/bin/python"
if ! "$PYPRE" -c "import nemo.collections.asr" >/dev/null 2>&1; then
  say "building preprocess env (NeMo; heavy — logs/pip-pre.log) …"
  [[ -x "$PYPRE" ]] || "$CONDA" create -y -p "$ENVPRE" -c conda-forge python=3.10 >"$LOG/env-pre.log" 2>&1 || die "env-pre create failed"
  "$PYPRE" -m pip install -q -r "$SOULX/requirements.txt" >"$LOG/pip-pre.log" 2>&1 || die "env-pre requirements failed (logs/pip-pre.log)"
  "$PYPRE" -m pip install -q -U "nemo_toolkit[asr]" >>"$LOG/pip-pre.log" 2>&1 || die "env-pre NeMo failed (logs/pip-pre.log)"
  "$PYPRE" -m pip install -q "torch==2.6.0" "torchaudio==2.6.0" --index-url https://download.pytorch.org/whl/cu124 >>"$LOG/pip-pre.log" 2>&1 || die "env-pre torch cu124 pin failed"
  "$PYPRE" -m nltk.downloader -q averaged_perceptron_tagger averaged_perceptron_tagger_eng cmudict >>"$LOG/pip-pre.log" 2>&1 || true
  "$PYPRE" - >>"$LOG/pip-pre.log" 2>&1 <<'PYCHK' || die "env-pre validation failed (logs/pip-pre.log)"
import torch, torchaudio, nemo.collections.asr
assert torch.cuda.is_available(), "no CUDA in env-pre"
PYCHK
fi
if [[ ! -f "$SOULX/pretrained_models/SoulX-Singer/model.pt" ]]; then
  say "downloading weights (~6 GB) …"
  "$PY" -m huggingface_hub.commands.huggingface_cli download Soul-AILab/SoulX-Singer --local-dir "$SOULX/pretrained_models/SoulX-Singer" >"$LOG/hf.log" 2>&1 \
    || "$ENVDIR/bin/hf" download Soul-AILab/SoulX-Singer --local-dir "$SOULX/pretrained_models/SoulX-Singer" >"$LOG/hf.log" 2>&1 || die "weights download failed (logs/hf.log)"
fi
if [[ ! -d "$SOULX/pretrained_models/SoulX-Singer-Preprocess" ]]; then
  say "downloading preprocess models …"
  "$ENVDIR/bin/hf" download Soul-AILab/SoulX-Singer-Preprocess --local-dir "$SOULX/pretrained_models/SoulX-Singer-Preprocess" >"$LOG/hf2.log" 2>&1 \
    || "$PY" -m huggingface_hub.commands.huggingface_cli download Soul-AILab/SoulX-Singer-Preprocess --local-dir "$SOULX/pretrained_models/SoulX-Singer-Preprocess" >"$LOG/hf2.log" 2>&1 || die "preprocess models download failed (logs/hf2.log)"
fi

# ── install smoke: their bundled example (isolates broken-stack from broken-input) ──
if [[ ! -f "$OUT/_smoke/done" ]]; then
  say "install smoke (their example) …"
  ( cd "$SOULX" && PYTHONPATH="$SOULX" "$PY" -m cli.inference --device cuda \
      --model_path pretrained_models/SoulX-Singer/model.pt --config soulxsinger/config/soulxsinger.yaml \
      --prompt_wav_path example/audio/zh_prompt.mp3 --prompt_metadata_path example/audio/zh_prompt.json \
      --target_metadata_path example/audio/en_target.json --phoneset_path soulxsinger/utils/phoneme/phone_set.json \
      --control score --auto_shift --pitch_shift 0 --fp16 --save_dir "$OUT/_smoke" ) >"$LOG/smoke.log" 2>&1 || die "install smoke failed (logs/smoke.log)"
  touch "$OUT/_smoke/done"
fi

# ── preprocess the FRESH reference (own-30s) → its metadata JSON ──
if [[ ! -f "$HANDOFF/refs/own-30s.json" ]]; then
  say "transcribing reference own-30s (English, vocal_sep) …"
  ( cd "$SOULX" && PYTHONPATH="$SOULX" "$PYPRE" -m preprocess.pipeline \
      --audio_path "$HANDOFF/refs/own-30s.wav" --save_dir "$WORKDIR/transcriptions/own-30s" \
      --language English --device cuda --vocal_sep True --max_merge_duration 30000 --midi_transcribe True ) >"$LOG/pre-own-30s.log" 2>&1 || die "preprocess failed (logs/pre-own-30s.log)"
  meta=$(find "$WORKDIR/transcriptions/own-30s" -name "*.json" | head -1)
  [[ -n "$meta" ]] || die "preprocess produced no metadata JSON"
  cp "$meta" "$HANDOFF/refs/own-30s.json"
fi
mkdir -p "$OUT/ref-transcriptions" && cp "$HANDOFF/refs/own-30s.json" "$OUT/ref-transcriptions/"

# ── render: the fixed score in the pella voice ──
SCORE_SIG="$(sha256sum "$HANDOFF/scores/target_score.json" | cut -d' ' -f1)"
if [[ "$(cat "$OUT/renders/own-30s/done" 2>/dev/null)" != "$SCORE_SIG" ]]; then
  say "rendering fixed score with own-30s reference …"
  mkdir -p "$OUT/renders/own-30s"
  ( cd "$SOULX" && PYTHONPATH="$SOULX" "$PY" -m cli.inference --device cuda \
      --model_path pretrained_models/SoulX-Singer/model.pt --config soulxsinger/config/soulxsinger.yaml \
      --prompt_wav_path "$HANDOFF/refs/own-30s.wav" --prompt_metadata_path "$HANDOFF/refs/own-30s.json" \
      --target_metadata_path "$HANDOFF/scores/target_score.json" --phoneset_path soulxsinger/utils/phoneme/phone_set.json \
      --control score --pitch_shift 0 --fp16 --save_dir "$OUT/renders/own-30s" ) >"$LOG/render-own-30s.log" 2>&1 || die "render failed (logs/render-own-30s.log)"
  echo "$SCORE_SIG" > "$OUT/renders/own-30s/done"
fi

say "packing results …"
cp -r "$LOG" "$OUT/logs" 2>/dev/null || true
tar -czf "$WORKDIR/sing-out.tar.gz" -C "$WORKDIR" out || die "tar failed"
touch "$WORKDIR/DONE"
say "ALL DONE -> $WORKDIR/sing-out.tar.gz"
