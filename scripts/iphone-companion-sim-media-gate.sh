#!/usr/bin/env bash
#
# Simulator media ladder for the iOS Companion hardware gates.
#
# This is deliberately not a fake "physical iPhone" test. It proves the behavior
# around the four hardware dependencies with deterministic simulator inputs:
#   1. QR payload generation and image decode contract.
#   2. Simulator custom-URL handoff into the app against a local Mac stub server.
#   3. Fixture-backed phone-take chunks through the same recorder/client seam.
#   4. Fixture-backed speech commands and synthetic monitoring metrics.
#
# The real camera optics, real iPhone microphone, Apple on-device Speech stack,
# and real acoustic speaker-to-mic path remain physical-device gates.
#
# Usage:
#   scripts/iphone-companion-sim-media-gate.sh
#   MOSH_IOS_SIM_NAME='iPhone 17 Pro' scripts/iphone-companion-sim-media-gate.sh
#   MOSH_IOS_SIM_UDID='<sim-udid>' scripts/iphone-companion-sim-media-gate.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT/ios/MoshCompanion/MoshCompanion.xcodeproj"
DERIVED="${MOSH_IOS_SIM_MEDIA_DERIVED_DATA:-${TMPDIR:-/tmp}/mosh-ios-sim-media}"
BUNDLE_ID="studio.mosh.companion"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
ARTIFACT_ROOT="${MOSH_IOS_SIM_MEDIA_ARTIFACTS:-$ROOT/_preserved_artifacts/$(date +%Y-%m-%d)-ios-companion-sim-media-gate}"
OUT="$ARTIFACT_ROOT/$RUN_ID"
EVENTS="$OUT/stub-events.jsonl"
SERVER_LOG="$OUT/stub-server.log"
QR_PNG="$OUT/pairing-qr.png"
QR_DECODED_JSON="$OUT/qr-decoded-payload.json"
SUMMARY_JSON="$OUT/summary.json"
SERVER_PID=""

mkdir -p "$OUT"

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required for the iOS companion simulator media gate." >&2
    exit 2
  fi
}

require_tool python3
require_tool xcrun

if ! xcrun -f xcodebuild >/dev/null 2>&1; then
  echo "xcodebuild (full Xcode) is required; Command Line Tools alone cannot build the app." >&2
  exit 2
fi

SIM_DEVICES_JSON="$(xcrun simctl list devices available -j)"
SIM_SELECTION="$(
  SIM_DEVICES_JSON="$SIM_DEVICES_JSON" python3 - <<'PY'
import json
import os

target_udid = os.environ.get("MOSH_IOS_SIM_UDID", "").strip()
target_name = os.environ.get("MOSH_IOS_SIM_NAME", "").strip()
data = json.loads(os.environ["SIM_DEVICES_JSON"])

candidates = []
for runtime, devices in data.get("devices", {}).items():
    for device in devices:
        if not device.get("isAvailable", True):
            continue
        name = device.get("name", "")
        if not name.startswith("iPhone"):
            continue
        candidates.append((device.get("udid", ""), name, runtime))

chosen = None
if target_udid:
    chosen = next((item for item in candidates if item[0] == target_udid), None)
elif target_name:
    matches = [item for item in candidates if item[1] == target_name]
    chosen = matches[0] if matches else None
else:
    for preferred_name in ("iPhone 17", "iPhone 17e", "iPhone 17 Pro"):
        matches = [item for item in candidates if item[1] == preferred_name]
        if matches:
            chosen = matches[0]
            break
    if not chosen:
        chosen = candidates[0] if candidates else None

if not chosen:
    raise SystemExit("No matching available iPhone simulator found.")

print("\t".join(chosen))
PY
)"

IFS=$'\t' read -r SIM_UDID SIM_NAME SIM_RUNTIME <<<"$SIM_SELECTION"
if [[ -z "$SIM_UDID" || -z "$SIM_NAME" ]]; then
  echo "No available iPhone simulator found. Install one via Xcode > Settings > Components." >&2
  exit 3
fi

PORT="$(python3 - <<'PY'
import socket

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
TOKEN="codex-sim-token-$RUN_ID"
PAIRING_URL="$(python3 - "$PORT" "$TOKEN" <<'PY'
import base64
import json
import sys
import urllib.parse

payload = {
    "host": "127.0.0.1",
    "port": int(sys.argv[1]),
    "token": sys.argv[2],
}
encoded = base64.b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8")).decode("ascii")
print("mosh://pair?" + urllib.parse.urlencode({"payload": encoded}))
PY
)"

echo "iOS companion simulator media gate"
echo "  simulator: $SIM_NAME ($SIM_UDID, $SIM_RUNTIME)"
echo "  artifacts: $OUT"
echo "  local stub: http://127.0.0.1:$PORT"

swift - "$PAIRING_URL" "$QR_PNG" "$QR_DECODED_JSON" <<'SWIFT'
import AppKit
import CoreImage
import Foundation
import Vision

let pairingURL = CommandLine.arguments[1]
let pngPath = CommandLine.arguments[2]
let decodedJSONPath = CommandLine.arguments[3]

guard let filter = CIFilter(name: "CIQRCodeGenerator") else {
    fatalError("CIQRCodeGenerator unavailable")
}
filter.setValue(Data(pairingURL.utf8), forKey: "inputMessage")
filter.setValue("M", forKey: "inputCorrectionLevel")
guard let outputImage = filter.outputImage else {
    fatalError("QR filter produced no output image")
}

let scaledImage = outputImage.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
let representation = NSCIImageRep(ciImage: scaledImage)
let nsImage = NSImage(size: representation.size)
nsImage.addRepresentation(representation)
guard let tiff = nsImage.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Failed to encode QR PNG")
}
try png.write(to: URL(fileURLWithPath: pngPath))

let request = VNDetectBarcodesRequest()
let handler = VNImageRequestHandler(url: URL(fileURLWithPath: pngPath))
try handler.perform([request])
guard let decoded = request.results?.compactMap({ $0.payloadStringValue }).first else {
    fatalError("Vision did not decode the generated QR PNG")
}
guard decoded == pairingURL else {
    fatalError("QR decode mismatch: decoded=\(decoded) expected=\(pairingURL)")
}
guard let components = URLComponents(string: decoded),
      components.scheme == "mosh",
      components.host == "pair",
      let payloadBase64 = components.queryItems?.first(where: { $0.name == "payload" })?.value,
      let payloadData = Data(base64Encoded: payloadBase64),
      let payload = try JSONSerialization.jsonObject(with: payloadData) as? [String: Any] else {
    fatalError("Decoded QR is not a mosh pairing URL")
}

let decodedObject: [String: Any] = [
    "decodedURL": decoded,
    "payload": payload,
    "qrPNG": pngPath
]
var json = try JSONSerialization.data(withJSONObject: decodedObject, options: [.prettyPrinted, .sortedKeys])
json.append(0x0a)
try json.write(to: URL(fileURLWithPath: decodedJSONPath))
SWIFT

python3 - "$PORT" "$TOKEN" "$EVENTS" >"$SERVER_LOG" 2>&1 <<'PY' &
import base64
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port = int(sys.argv[1])
token = sys.argv[2]
events_path = sys.argv[3]

def write_event(path, body):
    event = {
        "timeMs": round(time.time() * 1000, 3),
        "path": path,
        "body": body,
    }
    with open(events_path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, sort_keys=True) + "\n")

def make_probe_chunk(sequence):
    frames = 2400
    pcm = bytearray(frames * 2)
    if sequence == 0:
        pcm[0:2] = int(22000).to_bytes(2, byteorder="little", signed=True)
    return base64.b64encode(bytes(pcm)).decode("ascii")

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stdout.write((fmt % args) + "\n")
        sys.stdout.flush()

    def send_json(self, status, payload):
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def envelope(self, data=None, error=None, status=200):
        self.send_json(status, {"ok": error is None, "data": data, "error": error})

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"ok": True, "data": {"status": "ok"}, "error": None})
        else:
            self.envelope(error=f"Unhandled GET {self.path}", status=404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except json.JSONDecodeError as exc:
            self.envelope(error=f"Bad JSON: {exc}", status=400)
            return

        if body.get("token") != token:
            write_event(self.path, {"auth": "bad-token"})
            self.envelope(error="bad token", status=403)
            return

        write_event(self.path, body)
        path = self.path.split("?", 1)[0]

        if path == "/snapshot":
            self.envelope(
                {
                    "tracks": [
                        {
                            "id": "track-1",
                            "index": 0,
                            "name": "Sim Vox",
                            "clips": [
                                {
                                    "id": "clip-1",
                                    "name": "Rendered Lead",
                                    "type": "wave",
                                    "start": 0,
                                    "length": 2.5,
                                    "hasRenderLayer": True,
                                    "renderLayer": {
                                        "id": "layer-1",
                                        "status": "ready",
                                        "adapter": "sim",
                                        "mode": "reimagine",
                                        "seed": 17,
                                        "userKept": False,
                                        "hasArtifact": True,
                                    },
                                }
                            ],
                        }
                    ],
                    "transport": {
                        "playing": False,
                        "recording": False,
                        "position": 0,
                        "looping": False,
                    },
                }
            )
        elif path == "/events":
            self.envelope({"latestSeq": int(body.get("since", 0))})
        elif path == "/command":
            command = body.get("command", {})
            self.envelope({"ok": True, "command": command.get("command"), "error": None})
        elif path == "/take/start":
            self.envelope({"takeId": "sim-take-1"})
        elif path in {"/take/chunk", "/take/finish", "/take/cancel"}:
            self.envelope({})
        elif path == "/monitor/ping":
            phone_time = float(body.get("phoneTimeMs", 0))
            self.envelope({"macTimeMs": phone_time, "phoneTimeMs": phone_time})
        elif path == "/monitor/start":
            self.envelope({"sessionId": "sim-monitor-1", "sampleRate": 48000, "chunkFrames": 2400})
        elif path == "/monitor/chunk":
            sequence = int(body.get("sequence", 0))
            self.envelope(
                {
                    "sequence": sequence,
                    "sampleRate": 48000,
                    "pcm16Base64": make_probe_chunk(sequence),
                    "sentAtMacMs": round(time.time() * 1000, 3),
                }
            )
        elif path == "/monitor/report":
            self.envelope({"reportFile": "/tmp/mosh-sim-monitor-report.json"})
        elif path == "/monitor/stop":
            self.envelope({})
        else:
            self.envelope(error=f"Unhandled POST {path}", status=404)

server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
print(f"stub server listening on 127.0.0.1:{port}", flush=True)
server.serve_forever()
PY
SERVER_PID=$!

python3 - "$PORT" <<'PY'
import socket
import sys
import time

port = int(sys.argv[1])
deadline = time.time() + 10
while time.time() < deadline:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.25):
            raise SystemExit(0)
    except OSError:
        time.sleep(0.1)
raise SystemExit("Timed out waiting for local companion stub server.")
PY

echo "QR contract: generated and decoded $QR_PNG"

MOSH_IOS_SIM_NAME="$SIM_NAME" \
MOSH_IOS_SIM_UDID="$SIM_UDID" \
MOSH_IOS_SIM_DERIVED_DATA="$DERIVED" \
  "$ROOT/scripts/iphone-companion-sim-gate.sh" | tee "$OUT/xcodebuild-test.log"

APP="$DERIVED/Build/Products/Debug-iphonesimulator/MoshCompanion.app"
if [[ ! -d "$APP" ]]; then
  echo "Built simulator app not found at $APP" >&2
  exit 4
fi

xcrun simctl boot "$SIM_UDID" >/dev/null 2>&1 || true
python3 - "$SIM_UDID" "$OUT/sim-boot.log" "${MOSH_IOS_SIM_BOOTSTATUS_TIMEOUT:-60}" <<'PY'
import subprocess
import sys

udid = sys.argv[1]
log_path = sys.argv[2]
timeout = float(sys.argv[3])
process = subprocess.Popen(
    ["xcrun", "simctl", "bootstatus", udid, "-b"],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
)
try:
    output, _ = process.communicate(timeout=timeout)
except subprocess.TimeoutExpired:
    process.terminate()
    try:
        output, _ = process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        output, _ = process.communicate()
    output = output + f"\nTimed out after {timeout:.0f}s waiting for terminal bootstatus; continuing to install/openurl.\n"
    with open(log_path, "w", encoding="utf-8") as handle:
        handle.write(output)
    sys.stdout.write(output)
    raise SystemExit(0)

with open(log_path, "w", encoding="utf-8") as handle:
    handle.write(output)
sys.stdout.write(output)
if process.returncode != 0:
    raise SystemExit(process.returncode)
PY
xcrun simctl install "$SIM_UDID" "$APP" | tee "$OUT/sim-install.log"
xcrun simctl terminate "$SIM_UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl openurl "$SIM_UDID" "$PAIRING_URL" | tee "$OUT/sim-openurl.log"

python3 - "$EVENTS" <<'PY'
import json
import os
import sys
import time

events_path = sys.argv[1]
deadline = time.time() + 25
seen = set()
while time.time() < deadline:
    if os.path.exists(events_path):
        with open(events_path, "r", encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    seen.add(json.loads(line)["path"])
    if "/snapshot" in seen and "/events" in seen:
        raise SystemExit(0)
    time.sleep(0.25)
raise SystemExit(f"Timed out waiting for simulator app to call /snapshot and /events. Seen: {sorted(seen)}")
PY

xcrun simctl openurl "$SIM_UDID" "$PAIRING_URL" | tee "$OUT/sim-openurl-screenshot.log"
sleep 2
xcrun simctl io "$SIM_UDID" screenshot "$OUT/paired-session.png" | tee "$OUT/sim-screenshot.log"

python3 - "$SUMMARY_JSON" "$SIM_NAME" "$SIM_UDID" "$SIM_RUNTIME" "$PAIRING_URL" "$QR_PNG" "$QR_DECODED_JSON" "$EVENTS" "$OUT" "$PROJECT" <<'PY'
from collections import Counter
import json
import os
import sys

summary_path, sim_name, sim_udid, sim_runtime, pairing_url, qr_png, decoded_json, events_path, out_dir, project = sys.argv[1:]

events = []
if os.path.exists(events_path):
    with open(events_path, "r", encoding="utf-8") as handle:
        events = [json.loads(line) for line in handle if line.strip()]
counts = Counter(event["path"] for event in events)

summary = {
    "status": "passed",
    "project": project,
    "simulator": {
        "name": sim_name,
        "udid": sim_udid,
        "runtime": sim_runtime,
    },
    "artifacts": {
        "directory": out_dir,
        "qrPNG": qr_png,
        "qrDecodedPayload": decoded_json,
        "stubEvents": events_path,
        "xcodebuildTestLog": os.path.join(out_dir, "xcodebuild-test.log"),
        "screenshot": os.path.join(out_dir, "paired-session.png"),
    },
    "surfaces": {
        "qr_scan": {
            "proved": [
                "pairing URL rendered as QR PNG",
                "QR PNG decoded back to the same mosh://pair payload",
                "decoded payload parsed into host, port, and token fields",
            ],
            "not_proved": ["iPhone camera focus/exposure/scan UX"],
        },
        "simulator_app_handoff": {
            "proved": [
                "xcrun simctl openurl handed the mosh://pair URL to the installed app",
                "paired app called the local Mac stub /snapshot and /events endpoints",
            ],
            "stub_endpoint_counts": dict(sorted(counts.items())),
        },
        "real_mic_takes": {
            "proved": [
                "CompanionClientTests fixture audio source drove PhoneTakeRecorder start/chunk/finish sequencing",
                "fixture path uses the same PhoneTakeRecorder client calls as AVAudioEngine production input",
            ],
            "not_proved": ["real iPhone microphone permission, hardware input, room noise, or gain behavior"],
        },
        "on_device_speech": {
            "proved": [
                "CompanionClientTests fixture transcript source drove SpeechCommandRecognizer command callbacks",
                "production Apple Speech availability remains the runtime gate",
            ],
            "not_proved": ["Apple on-device Speech assets, recognizer accuracy, or microphone permission behavior"],
        },
        "acoustic_monitoring": {
            "proved": [
                "CompanionClientTests synthetic impulse/chirp samples drove MonitoringDiagnosticRunner report persistence",
                "network median/p95/jitter and acoustic onset metrics are deterministic in simulator tests",
            ],
            "not_proved": ["real iPhone speaker/mic acoustic path or room/audio-routing conditions"],
        },
    },
    "pairingURL": pairing_url,
}

with open(summary_path, "w", encoding="utf-8") as handle:
    json.dump(summary, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY

echo "iOS companion simulator media gate PASSED."
echo "Summary: $SUMMARY_JSON"
