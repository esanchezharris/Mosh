#!/usr/bin/env bash
# KS-A on a rented CUDA box (Linux). Runs ON the remote; driven by run_ksa_remote.sh.
# Idempotent: re-running skips completed stages (clone/env/weights/preprocess/renders).
#
#   bash remote_run.sh [--workdir ~/ksa] [--skip-preprocess] [--stage all|setup|preprocess|render]
#
# Expects the handoff payload rsynced to $WORKDIR/handoff/ (scores/, refs/own-10s.wav,
# refs/own-30s.wav, tools/render_grid.py). Products land in $WORKDIR/out/ and are tarred
# to $WORKDIR/ksa-out.tar.gz (renders + the auto-generated reference transcriptions +
# logs, so the Mac side can audit the metadata quality).
set -uo pipefail

WORKDIR="$HOME/ksa"
STAGE="all"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --workdir) WORKDIR="$2"; shift 2 ;;
    --stage) STAGE="$2"; shift 2 ;;
    *) echo "unknown arg $1"; exit 2 ;;
  esac
done
HANDOFF="$WORKDIR/handoff"
SOULX="$WORKDIR/SoulX-Singer"
OUT="$WORKDIR/out"
LOG="$WORKDIR/logs"
mkdir -p "$WORKDIR" "$OUT" "$LOG"
say() { echo "[ksa] $*"; }
die() { echo "[ksa] FATAL: $*" >&2; exit 1; }

[[ -d "$HANDOFF/scores" ]] || die "handoff payload missing at $HANDOFF (rsync it first)"
command -v nvidia-smi >/dev/null || die "no nvidia-smi — wrong instance?"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | tee "$LOG/gpu.txt"

# ---- conda/micromamba (GPU templates usually ship conda; bootstrap micromamba if not)
if command -v conda >/dev/null; then
  CONDA=conda
else
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

setup() {
  [[ -d "$SOULX" ]] || git clone https://github.com/Soul-AILab/SoulX-Singer "$SOULX"
  if [[ ! -x "$ENVDIR/bin/python" ]]; then
    say "creating python 3.10 env …"
    "$CONDA" create -y -p "$ENVDIR" -c conda-forge python=3.10 >"$LOG/env.log" 2>&1 || die "env create failed (logs/env.log)"
  fi
  PY="$ENVDIR/bin/python"
  say "installing requirements (this is the slow, fragile step — logs/pip.log) …"
  "$PY" -m pip install -q "setuptools<82" >"$LOG/pip.log" 2>&1
  "$PY" -m pip install -q -r "$SOULX/requirements.txt" >>"$LOG/pip.log" 2>&1 || die "pip install failed (logs/pip.log; known: NeMo/transformers pins — see KSA_RUNBOOK §1)"
  "$PY" -m pip install -q "huggingface_hub[cli]" >>"$LOG/pip.log" 2>&1
  # English lyric ASR (Parakeet) needs NeMo, which requirements.txt does NOT install
  # (SoulX issues #10/#9) and whose deps (torch>=2.3, transformers 4.5x, numpy 2) are
  # INCOMPATIBLE with SoulX's inference pins (torch 2.2 / transformers 4.41 / numpy<2).
  # So preprocessing gets a DEDICATED env; the proven inference env stays untouched.
  ENVPRE="$WORKDIR/env-pre"
  if ! "$ENVPRE/bin/python" -c "import nemo.collections.asr" >/dev/null 2>&1; then
    say "building dedicated preprocess env (requirements + NeMo; heavy — logs/pip-pre.log) …"
    [[ -x "$ENVPRE/bin/python" ]] || "$CONDA" create -y -p "$ENVPRE" -c conda-forge python=3.10 >"$LOG/env-pre.log" 2>&1 || die "env-pre create failed"
    "$ENVPRE/bin/python" -m pip install -q -r "$SOULX/requirements.txt" >"$LOG/pip-pre.log" 2>&1 || die "env-pre requirements failed (logs/pip-pre.log)"
    "$ENVPRE/bin/python" -m pip install -q -U "nemo_toolkit[asr]" >>"$LOG/pip-pre.log" 2>&1 || die "env-pre NeMo install failed (logs/pip-pre.log)"
    # NeMo drags in the newest torch (cu130 wheels — no GPU on CUDA-12.4 drivers) and
    # leaves torchaudio's 2.2 native lib behind (ABI break). Force a matched cu124 pair:
    # newest the cu124 index carries, and >=2.3 which NeMo needs (SequenceParallel).
    "$ENVPRE/bin/python" -m pip install -q "torch==2.6.0" "torchaudio==2.6.0" \
      --index-url https://download.pytorch.org/whl/cu124 >>"$LOG/pip-pre.log" 2>&1 || die "env-pre torch cu124 pin failed"
    # g2p's POS tagging needs nltk data at runtime (same requirement as Mosh's phonology venv)
    "$ENVPRE/bin/python" -m nltk.downloader -q averaged_perceptron_tagger averaged_perceptron_tagger_eng cmudict >>"$LOG/pip-pre.log" 2>&1 || true
    "$ENVPRE/bin/python" - >>"$LOG/pip-pre.log" 2>&1 <<'PYCHK' || die "env-pre validation failed (logs/pip-pre.log)"
import torch, torchaudio
assert torch.cuda.is_available(), "no CUDA in env-pre"
import nemo.collections.asr
PYCHK
  fi
  if [[ ! -f "$SOULX/pretrained_models/SoulX-Singer/model.pt" ]]; then
    say "downloading weights (~6 GB) …"
    "$PY" -m huggingface_hub.commands.huggingface_cli download Soul-AILab/SoulX-Singer \
      --local-dir "$SOULX/pretrained_models/SoulX-Singer" >"$LOG/hf.log" 2>&1 \
      || "$ENVDIR/bin/hf" download Soul-AILab/SoulX-Singer --local-dir "$SOULX/pretrained_models/SoulX-Singer" >"$LOG/hf.log" 2>&1 \
      || die "weights download failed (logs/hf.log)"
  fi
  if [[ ! -d "$SOULX/pretrained_models/SoulX-Singer-Preprocess" ]]; then
    say "downloading preprocess models …"
    "$ENVDIR/bin/hf" download Soul-AILab/SoulX-Singer-Preprocess \
      --local-dir "$SOULX/pretrained_models/SoulX-Singer-Preprocess" >"$LOG/hf2.log" 2>&1 \
      || "$PY" -m huggingface_hub.commands.huggingface_cli download Soul-AILab/SoulX-Singer-Preprocess --local-dir "$SOULX/pretrained_models/SoulX-Singer-Preprocess" >"$LOG/hf2.log" 2>&1 \
      || die "preprocess models download failed (logs/hf2.log)"
  fi
  # install smoke: their shipped example (proves the whole stack before our inputs)
  if [[ ! -f "$OUT/_smoke/done" ]]; then
    say "install smoke: rendering their example …"
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
  say "setup complete."
}

preprocess_refs() {
  PY="$WORKDIR/env-pre/bin/python"
  [[ -x "$PY" ]] || die "preprocess env missing — run --stage setup first"
  for ref in own-10s own-30s; do
    [[ -f "$HANDOFF/refs/$ref.wav" ]] || die "missing $HANDOFF/refs/$ref.wav"
    if [[ ! -f "$HANDOFF/refs/$ref.json" ]]; then
      say "transcribing reference $ref (English, vocal_sep on) …"
      ( cd "$SOULX" && PYTHONPATH="$SOULX" "$PY" -m preprocess.pipeline \
          --audio_path "$HANDOFF/refs/$ref.wav" \
          --save_dir "$WORKDIR/transcriptions/$ref" \
          --language English --device cuda --vocal_sep True \
          --max_merge_duration 30000 --midi_transcribe True ) >"$LOG/pre-$ref.log" 2>&1 \
        || die "preprocess failed for $ref (logs/pre-$ref.log)"
      meta=$(find "$WORKDIR/transcriptions/$ref" -name "*.json" | head -1)
      [[ -n "$meta" ]] || die "preprocess produced no metadata JSON for $ref"
      cp "$meta" "$HANDOFF/refs/$ref.json"
    fi
    mkdir -p "$OUT/ref-transcriptions" && cp "$HANDOFF/refs/$ref.json" "$OUT/ref-transcriptions/"
  done
  say "reference metadata ready."
}

render() {
  PY="$ENVDIR/bin/python"
  say "render grid …"
  "$PY" "$HANDOFF/tools/render_grid.py" --soulx "$SOULX" --handoff "$HANDOFF" \
    --out "$OUT/renders" 2>&1 | tee "$LOG/render.log"
  [[ "${PIPESTATUS[0]}" -eq 0 ]] || die "render_grid failed (logs/render.log)"
  # SVC bonus probe (cli.inference_svc — needs F0 .npy for prompt AND target, per
  # example/infer_svc.sh; the preprocess pipeline emits them, midi_transcribe=False)
  if [[ -f "$HANDOFF/refs/svc-target.wav" && ! -d "$OUT/svc-probe" ]]; then
    say "SVC bonus probe …"
    (
      set -e
      PYPRE="$WORKDIR/env-pre/bin/python"
      for w in own-30s svc-target; do
        if ! find "$WORKDIR/transcriptions/$w" -name "*.npy" 2>/dev/null | grep -q .; then
          ( cd "$SOULX" && PYTHONPATH="$SOULX" "$PYPRE" -m preprocess.pipeline \
              --audio_path "$HANDOFF/refs/$w.wav" --save_dir "$WORKDIR/transcriptions/$w" \
              --language English --device cuda --vocal_sep True \
              --max_merge_duration 30000 --midi_transcribe False )
        fi
      done
      PF0=$(find "$WORKDIR/transcriptions/own-30s" -name "*.npy" | head -1)
      TF0=$(find "$WORKDIR/transcriptions/svc-target" -name "*.npy" | head -1)
      [[ -n "$PF0" && -n "$TF0" ]]
      cd "$SOULX" && PYTHONPATH="$SOULX" "$PY" -m cli.inference_svc --device cuda \
        --model_path pretrained_models/SoulX-Singer/model-svc.pt \
        --config soulxsinger/config/soulxsinger.yaml \
        --prompt_wav_path "$HANDOFF/refs/own-30s.wav" \
        --target_wav_path "$HANDOFF/refs/svc-target.wav" \
        --prompt_f0_path "$PF0" --target_f0_path "$TF0" \
        --auto_shift --pitch_shift 0 --fp16 \
        --save_dir "$OUT/svc-probe"
    ) >"$LOG/svc.log" 2>&1 \
      || say "SVC probe failed (non-fatal, bonus only — logs/svc.log)"
  fi
  cp -r "$LOG" "$OUT/logs"
  tar -czf "$WORKDIR/ksa-out.tar.gz" -C "$WORKDIR" out
  say "DONE -> $WORKDIR/ksa-out.tar.gz"
}

case "$STAGE" in
  setup) setup ;;
  preprocess) preprocess_refs ;;
  render) render ;;
  all) setup && preprocess_refs && render ;;
  *) die "unknown --stage $STAGE" ;;
esac
