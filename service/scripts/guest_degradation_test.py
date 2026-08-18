#!/usr/bin/env python3
"""Guest-Mac graceful-degradation smoke test — no venvs, no SA3 weights, no RAVE
models, no training backend configured (a fresh `git clone` + `npm ci`, nothing
owner-specific run yet). Spins up the real server.py HTTP service (like
fake_adapter_test.py) but FORCES every per-feature venv/model lookup to miss by
pointing MOSH_VENVS_DIR/MOSH_MODELS_DIR at empty temp dirs and clearing the
per-feature .env-style overrides BEFORE importing server — this Mac (the owner's
dev machine) actually has every venv installed, so without the override this test
would silently exercise the wrong (fully-equipped) state.

Proves the specific guest-degradation fixes:
  1. /skeleton_spec tells a "transcription isn't installed" truth apart from a
     genuine "no melody in this take" verdict (both used to collapse into the
     same no_melody_detected string — see server.py's /skeleton_spec handler).
  2. /transform_targets carries the honest capabilities summary the frontend
     loads LAZILY (ui/src/store.ts loadCapabilities, triggered on first
     clip-menu/Gen-drawer open — never at app init, which must stay free of any
     command that can spawn the generative service) to gate/label the clip-menu
     + transform + training UI.
  3. /capabilities reports skeleton + phonology (parity with /health).

Run:  python3 service/scripts/guest_degradation_test.py     (exit 0 = all pass)
"""
import json
import math
import os
import struct
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import wave
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

# ── Force the guest posture BEFORE importing server ─────────────────────────────
_GUEST_TMP = tempfile.mkdtemp(prefix="mosh-guest-sim-")
os.environ["MOSH_VENVS_DIR"] = os.path.join(_GUEST_TMP, "venvs")       # empty: no venvs
os.environ["MOSH_MODELS_DIR"] = os.path.join(_GUEST_TMP, "models")     # empty: no RAVE models
os.environ["MOSH_ENABLE_SA3"] = "0"        # skip SA3 probing entirely (unrelated to this pass)
os.environ["MOSH_ENABLE_TRANSFORM"] = "1"  # let availability fall out of the (empty) model dir
for _env in ("BASIC_PITCH_PY", "WHISPER_PY", "SKELETON_PY", "PHONOLOGY_PY", "TRANSFORM_PY",
             "RAVE_MODEL_DIR", "MOSH_TRAINING_REMOTE_URL", "MOSH_TRAINING_BACKEND"):
    os.environ.pop(_env, None)
# The local trainer auto-detects when its binary AND the SA3 base checkpoint are
# present. This dev Mac HAS the checkpoint, so without these overrides the guest
# pass would see a real "local_pmetal" backend and fail on a machine difference
# rather than on a code change — point both at the empty guest tmp.
os.environ["MOSH_TRAINER_BIN"] = os.path.join(_GUEST_TMP, "no-trainer", "pmetal")
os.environ["MOSH_SA3_BASE_DIT"] = os.path.join(_GUEST_TMP, "no-trainer", "dit.safetensors")

import server  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def write_sine_wav(path, seconds=0.2, sr=44100, freq=220.0, channels=1):
    n = int(seconds * sr)
    frames = [int(0.5 * 32767 * math.sin(2 * math.pi * freq * i / sr)) for i in range(n)]
    body = struct.pack("<%dh" % len(frames), *frames)
    with wave.open(path, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(body)


def get_json(base, path):
    try:
        with urllib.request.urlopen(base + path, timeout=5) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())


def post_json(base, path, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(base + path, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())


def main():
    # Sanity: the forced-guest lookups really do miss on THIS (fully-equipped) dev Mac.
    check("sanity: transcribe reports unavailable under the forced-guest env",
          server._transcribe_available() is False)
    check("sanity: transform reports unavailable under the forced-guest env",
          server._guest_capability_summary()["transformReal"] is False)

    threading.Thread(target=server._worker_loop, daemon=True).start()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    try:
        # ── /capabilities: skeleton + phonology now reported (parity with /health) ──
        caps = get_json(base, "/capabilities")
        check("/capabilities reports skeleton", "skeleton" in caps and caps["skeleton"]["available"] is False,
              str(caps.get("skeleton")))
        check("/capabilities reports phonology", "phonology" in caps, str(caps.get("phonology")))

        # ── /transform_targets: the honest capabilities carrier ─────────────────────
        xf = get_json(base, "/transform_targets")
        check("/transform_targets ok", xf.get("ok") is True)
        check("/transform_targets freeText:true under fake transform", xf.get("freeText") is True)
        check("/transform_targets has no dead top-level 'real' field", "real" not in xf, str(xf.keys()))
        guest_caps = xf.get("capabilities", {})
        check("capabilities.transcribe false", guest_caps.get("transcribe") is False, str(guest_caps))
        check("capabilities.skeleton false", guest_caps.get("skeleton") is False, str(guest_caps))
        check("capabilities.whisper false", guest_caps.get("whisper") is False, str(guest_caps))
        check("capabilities.phonology is a bool", isinstance(guest_caps.get("phonology"), bool), str(guest_caps))
        check("capabilities.transformReal false", guest_caps.get("transformReal") is False, str(guest_caps))
        check("capabilities.trainingBackend is 'fake' with no remote URL and no local trainer assets",
              guest_caps.get("trainingBackend") == "fake", str(guest_caps.get("trainingBackend")))
        check("capabilities.trainingBlockers is a list", isinstance(guest_caps.get("trainingBlockers"), list),
              str(guest_caps.get("trainingBlockers")))

        # ── /skeleton_spec: honest "not installed" vs "no melody" ───────────────────
        with tempfile.TemporaryDirectory() as d:
            wav = os.path.join(d, "take.wav")
            write_sine_wav(wav)
            spec = post_json(base, "/skeleton_spec", {"inputWav": wav, "bpm": 120, "timeSig": [4, 4]})
            check("skeleton_spec ok:false under a missing transcribe venv", spec.get("ok") is False)
            err = str(spec.get("error", ""))
            check("skeleton_spec error is NOT the generic no_melody_detected", err != "no_melody_detected", err)
            check("skeleton_spec error names the real cause (transcription not installed)",
                  "not installed" in err or "isn't installed" in err, err)
            check("skeleton_spec error points at the fix (setup-guest.sh)", "setup-guest.sh" in err, err)

            missing = post_json(base, "/skeleton_spec", {"inputWav": os.path.join(d, "nope.wav")})
            check("skeleton_spec 400s on a genuinely missing file (unrelated to this fix)",
                  missing.get("ok") is False and "inputWav" in str(missing.get("error", "")))
    finally:
        httpd.shutdown()

    print(f"\n{len(fails)} failing check(s)" if fails else "\nAll checks passed.")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
