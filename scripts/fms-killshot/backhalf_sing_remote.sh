#!/usr/bin/env bash
# Mac-side driver: render the B-verse target score in the OWNER'S VOICE on a rented RunPod
# GPU via the proven remote_sing_fresh.sh lane (fresh ref -> pod transcribes -> SoulX sings
# the exact score), then pull the WAV and TERMINATE.
#
#   ./backhalf_sing_remote.sh up          # create pod + run + pull + terminate
#   ./backhalf_sing_remote.sh status|terminate
#
# Key: $RUNPOD_API_KEY or ~/.runpod_api_key (chmod 600) — same as runpod_ksa.sh.
# Safety: the pod is TERMINATED on success AND on failure (logs pulled first); set
# KEEP_POD=1 to keep a failed pod up for manual resume (it BILLS until terminate).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
KSA="$HERE/remote/runpod_ksa.sh"
# default single-score lane; SING_SCRIPT=remote/remote_sing_multi.sh renders EVERY scores/*.json
FRESH="${SING_SCRIPT:-$HERE/remote/remote_sing_fresh.sh}"
HANDOFF="$HOME/mosh-fms-ksb/used2/asserted-proof/back-half/sing-handoff"
SERVE="$HOME/mosh-fms-ksb/used2/asserted-proof"
PULL="$HANDOFF/pull"
POLL_S=60
MAX_POLLS=100                       # ~100 min ceiling; env+weights ~25 min first run

endpoint() { "$KSA" ssh | tail -1 | sed -E 's/^ssh root@([0-9a-zA-Z.\-]+) -p ([0-9]+)$/\1 \2/'; }

case "${1:-up}" in
  status)    "$KSA" status; exit 0 ;;
  terminate) "$KSA" terminate; exit 0 ;;
  up) ;;
  *) echo "usage: $0 up|status|terminate"; exit 2 ;;
esac

ls "$HANDOFF"/scores/*.json >/dev/null 2>&1 && [[ -f "$HANDOFF/refs/own-30s.wav" ]] \
  || { echo "handoff incomplete: $HANDOFF (run backhalf_sing_handoff.py / backhalf_sing_demos.py first)"; exit 1; }
[[ -f "$HOME/.ssh/id_ed25519.pub" ]] || { echo "no ~/.ssh/id_ed25519.pub (pod key injection needs it)"; exit 1; }

[[ -f "$HOME/.mosh-ksa-runpod" ]] || "$KSA" create
echo "== waiting for SSH endpoint"
IP=""; PORT=""
for i in $(seq 1 30); do
  read -r IP PORT <<< "$(endpoint 2>/dev/null || true)"
  [[ -n "${IP:-}" && -n "${PORT:-}" ]] && break
  sleep 10
done
[[ -n "${IP:-}" && -n "${PORT:-}" ]] || { echo "no SSH endpoint — pod may still be provisioning (re-run '$0 up'; it BILLS until terminate)"; exit 1; }
SSH=(ssh -p "$PORT" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "root@$IP")
echo "== pod: root@$IP:$PORT"
for i in $(seq 1 18); do "${SSH[@]}" true 2>/dev/null && break; sleep 10; done
"${SSH[@]}" true || { echo "ssh never came up — pod left provisioning (re-run '$0 up')"; exit 1; }

echo "== push handoff + runner"
"${SSH[@]}" "mkdir -p ksa/handoff; command -v rsync >/dev/null || (apt-get update -qq && apt-get install -y -qq rsync)"
rsync -az --info=stats1 -e "ssh -p $PORT" "$HANDOFF/scores" "$HANDOFF/refs" "root@$IP:ksa/handoff/"
rsync -az -e "ssh -p $PORT" "$FRESH" "root@$IP:ksa/remote_sing_fresh.sh"

echo "== launch (unattended on the pod; ~25-40 min first run)"
"${SSH[@]}" "rm -f ksa/DONE ksa/FAILED; nohup bash ksa/remote_sing_fresh.sh > ksa/run.log 2>&1 & echo launched"

echo "== polling every ${POLL_S}s"
STATUS="timeout"
for i in $(seq 1 "$MAX_POLLS"); do
  sleep "$POLL_S"
  line=$("${SSH[@]}" "tail -1 ksa/run.log 2>/dev/null; ls ksa/DONE ksa/FAILED 2>/dev/null" 2>/dev/null || echo "<ssh blip>")
  echo "[poll $i] $line"
  if echo "$line" | grep -q "ksa/DONE"; then STATUS="done"; break; fi
  if echo "$line" | grep -q "ksa/FAILED"; then STATUS="failed"; break; fi
done

mkdir -p "$PULL"
if [[ "$STATUS" == "done" ]]; then
  echo "== pulling results"
  rsync -az -e "ssh -p $PORT" "root@$IP:ksa/sing-out.tar.gz" "$PULL/"
  tar -xzf "$PULL/sing-out.tar.gz" -C "$PULL"
  for D in "$PULL"/out/renders/*/; do
    NAME="$(basename "$D")"
    WAV=$(find "$D" -name "*.wav" | head -1)
    [[ -z "$WAV" ]] && continue
    if [[ "$NAME" == "own-30s" ]]; then OUTNAME="voice-soulx.wav"; else OUTNAME="voice-soulx-$NAME.wav"; fi
    ffmpeg -y -i "$WAV" "$SERVE/$OUTNAME" >/dev/null 2>&1 && echo "render -> $SERVE/$OUTNAME"
  done
else
  echo "== $STATUS — pulling logs for the post-mortem"
  rsync -az -e "ssh -p $PORT" "root@$IP:ksa/run.log" "root@$IP:ksa/logs" "$PULL/" 2>/dev/null || true
fi

if [[ "${KEEP_POD:-0}" == "1" && "$STATUS" != "done" ]]; then
  echo "KEEP_POD=1 — pod LEFT UP for resume (it BILLS until '$0 terminate')"
else
  echo "== terminating pod (voice data destroyed, billing stopped)"
  "$KSA" terminate
fi
[[ "$STATUS" == "done" ]]
