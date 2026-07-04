#!/usr/bin/env bash
# Mac-side driver: push the KS-A handoff to a rented CUDA box over SSH, run the whole
# grid there, pull the results back, and build the local blind-listening page.
#
#   ./run_ksa_remote.sh user@host [-p PORT] [-i KEYFILE] [--handoff DIR] [--stage all|setup|preprocess|render]
#
# Re-runnable: rsync is incremental and remote_run.sh skips completed stages, so a
# dropped connection or dep failure resumes where it left off.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# No baked-in default: the handoff dir is session-specific. Pass --handoff DIR
# (or set KSA_HANDOFF); it must contain scores/ and refs/own-{10s,30s}.wav.
HANDOFF="${KSA_HANDOFF:-}"
PORT=22; KEY=""; STAGE="all"
HOSTSPEC="${1:?usage: run_ksa_remote.sh user@host [-p PORT] [-i KEYFILE] [--handoff DIR] [--stage ...]}"
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p) PORT="$2"; shift 2 ;;
    -i) KEY="$2"; shift 2 ;;
    --handoff) HANDOFF="$2"; shift 2 ;;
    --stage) STAGE="$2"; shift 2 ;;
    *) echo "unknown arg $1"; exit 2 ;;
  esac
done
SSH=(ssh -p "$PORT" -o StrictHostKeyChecking=accept-new)
[[ -n "$KEY" ]] && SSH+=(-i "$KEY")
RS=(rsync -az --info=stats1 -e "${SSH[*]}")

[[ -n "$HANDOFF" ]] || { echo "no handoff dir: pass --handoff DIR (or set KSA_HANDOFF)"; exit 2; }
[[ -d "$HANDOFF/scores" && -f "$HANDOFF/refs/own-30s.wav" && -f "$HANDOFF/refs/own-10s.wav" ]] \
  || { echo "handoff dir incomplete: $HANDOFF (needs scores/ + refs/own-10s.wav + refs/own-30s.wav)"; exit 1; }

echo "== 0/4 remote prerequisites (rsync — RunPod images ship without it)"
"${SSH[@]}" "$HOSTSPEC" "mkdir -p ksa/handoff; command -v rsync >/dev/null || (apt-get update -qq && apt-get install -y -qq rsync git curl)"

echo "== 1/4 push handoff + runner"
"${RS[@]}" "$HANDOFF/" "$HOSTSPEC:ksa/handoff/"
"${RS[@]}" "$HERE/remote_run.sh" "$HOSTSPEC:ksa/remote_run.sh"

echo "== 2/4 run remote stage=$STAGE (long: env+weights first time)"
"${SSH[@]}" "$HOSTSPEC" "bash ksa/remote_run.sh --workdir \$HOME/ksa --stage $STAGE"

echo "== 3/4 pull results"
DEST="$HOME/mosh-fms-ksa-results"
mkdir -p "$DEST"
"${RS[@]}" "$HOSTSPEC:ksa/ksa-out.tar.gz" "$DEST/"
tar -xzf "$DEST/ksa-out.tar.gz" -C "$DEST"

echo "== 4/4 local listening page"
REPO="$(cd "$HERE/../../.." && pwd)"
python3 "$REPO/scripts/fms-killshot/make_listening_page.py" "$DEST/out/renders" \
  --title "FMS kill-shot A — SoulX renders (blind: rate before reading folder names)" || true
echo
echo "results: $DEST/out  (renders/, ref-transcriptions/, svc-probe/, logs/)"
echo "REMINDER: tear the instance down when done — the voice slices live on it until you do."
