#!/usr/bin/env bash
# One-command KS-A on RunPod: provision a CUDA pod -> run the full grid via
# run_ksa_remote.sh -> pull results -> TERMINATE the pod (billing safety).
#
#   ./runpod_ksa.sh up                 # create pod + run everything + terminate on success
#   ./runpod_ksa.sh create|status|terminate|list   # manual controls
#
# API key: $RUNPOD_API_KEY or ~/.runpod_api_key (chmod 600).
# On FAILURE the pod is LEFT RUNNING for resume (re-run `up` — every stage is
# idempotent) — remember it bills until `terminate`.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
API="https://rest.runpod.io/v1"
NAME="mosh-ksa"
IMAGE="runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04"
GPUS='["NVIDIA GeForce RTX 4090","NVIDIA RTX A5000","NVIDIA L40S"]'
CLOUD="${KSA_CLOUD:-SECURE}"          # COMMUNITY is ~half price; SECURE default for voice data
DISK="${KSA_DISK:-60}"
STATE="$HOME/.mosh-ksa-runpod"        # remembers the active pod id

key() {
  if [[ -n "${RUNPOD_API_KEY:-}" ]]; then echo "$RUNPOD_API_KEY";
  elif [[ -f "$HOME/.runpod_api_key" ]]; then tr -d ' \n' < "$HOME/.runpod_api_key";
  else echo "no API key: export RUNPOD_API_KEY or write ~/.runpod_api_key" >&2; exit 2; fi
}
api() { # method path [json-body]
  local m="$1" p="$2" b="${3:-}"
  curl -sS -X "$m" "$API$p" -H "Authorization: Bearer $(key)" \
       -H "Content-Type: application/json" ${b:+-d "$b"}
}

create() {
  local pub
  pub=$(cat "$HOME/.ssh/id_ed25519.pub")
  local body
  body=$(python3 - "$pub" <<'EOF'
import json, sys
print(json.dumps({
  "name": "mosh-ksa",
  "imageName": "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04",
  "gpuTypeIds": ["NVIDIA GeForce RTX 4090", "NVIDIA RTX A5000", "NVIDIA L40S"],
  "gpuCount": 1,
  "containerDiskInGb": 60,
  "volumeInGb": 0,
  "ports": ["22/tcp"],
  "cloudType": __import__("os").environ.get("KSA_CLOUD", "SECURE"),
  "env": {"PUBLIC_KEY": sys.argv[1]},
}))
EOF
)
  local resp id
  resp=$(api POST /pods "$body")
  id=$(echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || true)
  [[ -n "$id" ]] || { echo "create failed: $resp" >&2; exit 1; }
  echo "$id" > "$STATE"
  echo "pod created: $id (cloud=$CLOUD)"
}

pod_id() { [[ -f "$STATE" ]] && cat "$STATE" || { echo "no active pod (run create)" >&2; exit 2; }; }

status() { api GET "/pods/$(pod_id)" | python3 -m json.tool | sed -n '1,40p'; }

ssh_endpoint() { # waits until publicIp + port-22 mapping exist; prints "ip port"
  local id; id=$(pod_id)
  for i in $(seq 1 60); do
    local ep
    ep=$(api GET "/pods/$id" | python3 -c '
import json, sys
p = json.load(sys.stdin)
ip = p.get("publicIp") or ""
port = (p.get("portMappings") or {}).get("22") or ""
print(f"{ip} {port}" if ip and port else "")')
    if [[ -n "${ep// /}" ]]; then echo "$ep"; return 0; fi
    sleep 10
  done
  echo "pod never exposed SSH (10 min)" >&2; return 1
}

terminate() {
  local id; id=$(pod_id)
  api DELETE "/pods/$id" >/dev/null && rm -f "$STATE" && echo "pod $id terminated (billing stopped, voice data gone)"
}

up() {
  [[ -f "$STATE" ]] || create
  echo "waiting for SSH endpoint …"
  read -r IP PORT <<< "$(ssh_endpoint)"
  echo "ssh root@$IP -p $PORT"
  # first boot: give sshd/key-injection a moment
  for i in $(seq 1 12); do
    ssh -p "$PORT" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 "root@$IP" true 2>/dev/null && break
    sleep 10
  done
  if "$HERE/run_ksa_remote.sh" "root@$IP" -p "$PORT"; then
    echo "SUCCESS — terminating pod."
    terminate
  else
    echo "RUN FAILED — pod left up for resume (re-run: $0 up). It BILLS until '$0 terminate'." >&2
    exit 1
  fi
}

case "${1:-}" in
  create) create ;;
  status) status ;;
  ssh) read -r IP PORT <<< "$(ssh_endpoint)"; echo "ssh root@$IP -p $PORT" ;;
  terminate) terminate ;;
  list) api GET /pods | python3 -m json.tool | sed -n '1,60p' ;;
  up) up ;;
  *) echo "usage: $0 up|create|status|ssh|terminate|list"; exit 2 ;;
esac
