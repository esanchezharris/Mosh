#!/usr/bin/env bash
# Rung-1 GRPO orchestrator — idempotent: builds the RL prompt data if absent, then
# runs the on-device GRPO trainer (clean-apply reward), then the full-gate DoD compare.
#
#   service/rl/run_grpo.sh                 # defaults (see knobs below)
#   ITERS=100 GROUP=8 service/rl/run_grpo.sh
#
# Artifacts (all gitignored):
#   service/sft/.rl-data/<RL_TAG>/        prompt+gate data (from buildRlPrompts)
#   service/sft/.adapters/<OUT_TAG>/      best RL LoRA + rl_results.json
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root
ROOT="$(pwd)"

# ── knobs ────────────────────────────────────────────────────────────────────
RL_TAG="${RL_TAG:-rl-v1}"
OUT_TAG="${OUT_TAG:-rl-v1}"
SFT_ADAPTER="${SFT_ADAPTER:-service/sft/.adapters/v2}"
GATE="${GATE:-service/sft/.sft-data/v2/test.eval.jsonl}"
ITERS="${ITERS:-60}"; PPS="${PPS:-4}"; GROUP="${GROUP:-6}"; TEMP="${TEMP:-1.0}"
MAXNEW="${MAXNEW:-200}"; LR="${LR:-2e-6}"; BETA="${BETA:-0.04}"
EVAL_EVERY="${EVAL_EVERY:-15}"; GATE_N="${GATE_N:-80}"; SEED="${SEED:-0}"
FULL_GATE_N="${FULL_GATE_N:-300}"   # final DoD compare subsample (0=all 870)
REWARD="${REWARD:-symbolic}"        # symbolic = Rung-1 clean-apply | audio = Rung-2 render→teardown Reward
REWARD_MODE="${REWARD_MODE:-floor}" # floor (no torch) | musical (MERT head + exemplars); only when REWARD=audio
MOSH_BIN="${MOSH_BIN:-/Applications/Mosh.app/Contents/MacOS/Mosh}"

RL_DIR="service/sft/.rl-data/${RL_TAG}"
OUT_DIR="service/sft/.adapters/${OUT_TAG}"

[ -f service/sft/.sft.env ] && source service/sft/.sft.env
PY="${SFT_PY:-service/sft/.venv/bin/python}"

# ── 1. RL prompt data (skip if present) ──────────────────────────────────────
if [ ! -f "${RL_DIR}/rl_train.prompts.jsonl" ]; then
  echo "▶ building RL prompt data → ${RL_DIR}"
  ( cd ui && npm run build-rl-prompts -- \
      --gate "../${GATE}" \
      --pool ../service/sft/.sft-data/v2-daw/test.eval.jsonl \
      --pool ../service/sft/.sft-data/v2-midi/test.eval.jsonl \
      --pool ../service/sft/.sft-data/daw/test.eval.jsonl \
      --pool ../service/sft/.sft-data/midi/test.eval.jsonl \
      --out "../${RL_DIR}" --per-shape 250 --seed "${SEED}" )
else
  echo "▶ RL prompt data present → ${RL_DIR} (set RL_TAG to rebuild)"
fi

# ── 1b. Rung-2 audio reward wiring (render each rollout → teardown Reward) ────
if [ "$REWARD" = "audio" ]; then
  [ -f service/teardown/.teardown.env ] && source service/teardown/.teardown.env
  export MOSH_RL_REWARD=audio MOSH_RL_REWARD_MODE="$REWARD_MODE" MOSH_BIN
  echo "▶ Rung-2 audio reward (${REWARD_MODE}) — MOSH_BIN=${MOSH_BIN}  TEARDOWN_PY=${TEARDOWN_PY:-MISSING (run service/teardown/setup-teardown.sh)}"
fi

# ── 2. GRPO train (offline serving → correct tokenizer) ──────────────────────
echo "▶ GRPO train → ${OUT_DIR}"
HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false "$PY" service/rl/grpo.py \
  --rl-data "${RL_DIR}" --sft-adapter "${SFT_ADAPTER}" --out "${OUT_DIR}" \
  --iters "${ITERS}" --prompts-per-step "${PPS}" --group-size "${GROUP}" --temp "${TEMP}" \
  --max-new-tokens "${MAXNEW}" --lr "${LR}" --beta "${BETA}" \
  --eval-every "${EVAL_EVERY}" --gate-n "${GATE_N}" --seed "${SEED}"

# ── 3. full-gate DoD compare (best RL vs SFT baseline, SAME tool as SFT 0.62) ─
echo "▶ DoD compare (best RL adapter vs SFT baseline) on the frozen gate"
HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false "$PY" service/rl/dod_compare.py \
  --rl-data "${RL_DIR}" --sft-adapter "${SFT_ADAPTER}" --rl-adapter "${OUT_DIR}" \
  --n "${FULL_GATE_N}" --out "${OUT_DIR}/dod.json"

echo "✅ done — see ${OUT_DIR}/rl_results.json and ${OUT_DIR}/dod.json"
