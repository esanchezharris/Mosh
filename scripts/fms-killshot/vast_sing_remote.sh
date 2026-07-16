#!/usr/bin/env bash
# Vast.ai driver for the SoulX sing render — the robust replacement for the RunPod lane
# (backhalf_sing_remote.sh). Vast returns only offers that ACTUALLY EXIST + are rentable, so
# there is NO capacity-retry roulette: search -> pick cheapest available 4090 -> create ->
# push scores+ref -> render (remote_sing_multi.sh, flash-attn fix included) -> pull -> DESTROY.
# The render runs detached (nohup) on the instance, so an SSH drop never kills it.
#
#   ./vast_sing_remote.sh search        # dry-run: show the offer it would pick (no spend)
#   ./vast_sing_remote.sh up            # create + render + pull + DESTROY
#   ./vast_sing_remote.sh destroy       # destroy any instance recorded in the state file
#
# Key: vastai reads ~/.vast_api_key. SSH: ~/.ssh/mosh_vast (registered on the account).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RUNNER="${SING_SCRIPT:-$HERE/remote/remote_sing_multi.sh}"
HANDOFF="$HOME/mosh-fms-ksb/used2/asserted-proof/back-half/sing-handoff"
SERVE="$HOME/mosh-fms-ksb/used2/asserted-proof"
PULL="$HANDOFF/pull-vast"
KEY="$HOME/.ssh/mosh_vast"
STATE="$HOME/.mosh-vast-instance"
IMAGE="${VAST_IMAGE:-pytorch/pytorch:2.4.0-cuda12.4-cudnn9-devel}"
DISK="${VAST_DISK:-75}"
# verified + rentable + a direct SSH port + enough disk/net; cheapest by $/hr.
# disk_bw floor: a cheap HDD-class box spent 38 min on pip alone (2026-07-16) — env setup
# is small-file IO-bound, so require NVMe-class disk (typical listings are 1000+ MB/s).
QUERY="${VAST_QUERY:-gpu_name=RTX_4090 num_gpus=1 verified=true rentable=true cuda_vers>=12.4 disk_space>=${DISK} direct_port_count>=1 inet_down>=200 disk_bw>=500}"

pick_offer() {   # -> "OFFER_ID DPH" (cheapest available; VAST_EXCLUDE skips flaky offer/machine ids)
  vastai search offers "$QUERY" -o 'dph' --raw 2>/dev/null | python3 -c '
import json,os,sys
ex=set(os.environ.get("VAST_EXCLUDE","").split())
offers=[o for o in json.load(sys.stdin)
        if str(o.get("id")) not in ex and str(o.get("machine_id")) not in ex]
if not offers: print("NONE 0"); sys.exit(0)
o=offers[0]
print(o["id"], round(float(o.get("dph_total",0)),3))'
}

ssh_endpoint() {   # -> "host port"  (empty until the instance is running)
  local id="$1"
  vastai show instances --raw 2>/dev/null | python3 -c '
import json,sys
iid=int(sys.argv[1])
for m in json.load(sys.stdin):
    if int(m.get("id",-1))==iid and m.get("actual_status")=="running" and m.get("ssh_host"):
        print(m["ssh_host"], m["ssh_port"]); break' "$id"
}

destroy() { [[ -f "$STATE" ]] && { id=$(cat "$STATE"); echo "== destroying vast instance $id"; vastai destroy instance "$id" -y >/dev/null 2>&1 || true; rm -f "$STATE"; }; }

case "${1:-up}" in
  search)  read -r OID DPH <<< "$(pick_offer)"; echo "cheapest available 4090: offer $OID at \$$DPH/hr"; exit 0 ;;
  destroy) destroy; exit 0 ;;
  up) ;;
  *) echo "usage: $0 search|up|destroy"; exit 2 ;;
esac

ls "$HANDOFF"/scores/*.json >/dev/null 2>&1 && [[ -f "$HANDOFF/refs/own-30s.wav" ]] \
  || { echo "handoff incomplete: $HANDOFF/{scores,refs}"; exit 1; }
[[ -f "$KEY" ]] || { echo "no $KEY (the registered Vast SSH key)"; exit 1; }

read -r OID DPH <<< "$(pick_offer)"
[[ "$OID" != "NONE" && -n "$OID" ]] || { echo "no rentable 4090 offer matched — loosen VAST_QUERY"; exit 1; }
echo "== renting offer $OID (\$$DPH/hr, image $IMAGE, ${DISK}GB)"
CID=$(vastai create instance "$OID" --image "$IMAGE" --disk "$DISK" --ssh --direct --raw 2>/dev/null \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("new_contract") or "")')
[[ -n "$CID" ]] || { echo "create failed"; exit 1; }
echo "$CID" > "$STATE"
trap destroy EXIT                                  # DESTROY on any exit (success/failure/interrupt)
echo "== instance $CID created; waiting for SSH …"

boot_state() {   # one line of boot diagnostics per poll (why "not ready" — pull? scheduling?)
  vastai show instances --raw 2>/dev/null | python3 -c '
import json,sys
iid=int(sys.argv[1])
for m in json.load(sys.stdin):
    if int(m.get("id",-1))==iid:
        msg=str(m.get("status_msg") or "").strip().replace("\n"," ")[:90]
        print(f"status={m.get(\"actual_status\")} ssh_host={m.get(\"ssh_host\")} msg={msg}")
        break' "$1" || true
}

IP=""; PORT=""
for i in $(seq 1 60); do
  read -r IP PORT <<< "$(ssh_endpoint "$CID" || true)"
  [[ -n "${IP:-}" && -n "${PORT:-}" ]] && break
  (( i % 4 == 0 )) && echo "[boot $((i*15))s] $(boot_state "$CID")"
  sleep 15
done
[[ -n "${IP:-}" && -n "${PORT:-}" ]] || { echo "instance never became SSH-ready — last state: $(boot_state "$CID")"; exit 1; }
SSH=(ssh -p "$PORT" -i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=12 "root@$IP")
echo "== instance: root@$IP:$PORT"
for i in $(seq 1 24); do "${SSH[@]}" true 2>/dev/null && break; sleep 10; done
"${SSH[@]}" true || { echo "ssh never came up"; exit 1; }

echo "== push handoff + runner"
"${SSH[@]}" "mkdir -p ksa/handoff; command -v rsync >/dev/null || (apt-get update -qq && apt-get install -y -qq rsync git curl)"
rsync -az -e "ssh -p $PORT -i $KEY" "$HANDOFF/scores" "$HANDOFF/refs" "root@$IP:ksa/handoff/"
rsync -az -e "ssh -p $PORT -i $KEY" "$RUNNER" "root@$IP:ksa/remote_sing_fresh.sh"

echo "== launch (detached — survives SSH drops; ~25-40 min first run)"
"${SSH[@]}" "rm -f ksa/DONE ksa/FAILED; cd ~ && setsid -f bash ksa/remote_sing_fresh.sh </dev/null > ksa/run.log 2>&1; echo launched"

# Poll budget: 180 min. A slow-disk box spent 100 min in env setup ALONE (2026-07-16) and
# the old 100-poll cap destroyed a healthy, progressing instance — the cap must comfortably
# exceed worst-case setup + render, not the happy path.
STATUS="timeout"
for i in $(seq 1 "${VAST_POLLS:-180}"); do
  sleep 60
  line=$("${SSH[@]}" "tail -1 ksa/run.log 2>/dev/null; ls ksa/DONE ksa/FAILED 2>/dev/null" 2>/dev/null || echo "<ssh blip>")
  echo "[poll $i] $line"
  echo "$line" | grep -q "ksa/DONE"   && { STATUS="done";   break; }
  echo "$line" | grep -q "ksa/FAILED" && { STATUS="failed"; break; }
done

mkdir -p "$PULL"
if [[ "$STATUS" == "done" ]]; then
  echo "== pulling results"
  rsync -az -e "ssh -p $PORT -i $KEY" "root@$IP:ksa/sing-out.tar.gz" "$PULL/"
  tar -xzf "$PULL/sing-out.tar.gz" -C "$PULL"
  for D in "$PULL"/out/renders/*/; do
    NAME="$(basename "$D")"; WAV=$(find "$D" -name "*.wav" | head -1); [[ -z "$WAV" ]] && continue
    ffmpeg -y -i "$WAV" "$SERVE/voice-soulx-$NAME.wav" >/dev/null 2>&1 && echo "render -> $SERVE/voice-soulx-$NAME.wav"
  done
else
  echo "== $STATUS — pulling logs"
  rsync -az -e "ssh -p $PORT -i $KEY" "root@$IP:ksa/run.log" "root@$IP:ksa/logs" "$PULL/" 2>/dev/null || true
fi
# trap destroys the instance on exit
[[ "$STATUS" == "done" ]]
