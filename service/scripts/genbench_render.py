#!/usr/bin/env python3
"""Generative techniques bench — the render half.

Drives the REAL SA3 adapter (text-to-audio + audio-to-audio + colour steering)
directly, loading the MLX engine ONCE and running a whole spec of techniques. This
isolates the variable the owner cares about right now — the *generation* itself
(prompt phrasing, t2a vs a2a-from-real-audio, colour steering, seeds) — with the DAW
held constant. No agent loop, no HTTP service: just the engine.

Must run under `$SA3_MLX_DIR/.venv/bin/python` (needs mlx + the SA3 model code). The
duration (8s) and STEPS are pinned at engine load from SA3_SECONDS / SA3_STEPS, so the
TS orchestrator runs a second process with a different SA3_STEPS for the steps variant.

Usage:  genbench_render.py <spec.json>
  spec.json = [{ "id", "out", "prompt", "seed", "method"?, "source"?, "nl"?,
                 "colors"?:[{name,value}], "lab"? }, ...]
Emits one `@@GB@@ {json}` progress line per render to stderr, and a final JSON array
of {id, out, ok, manifest|error} to stdout.
"""
from __future__ import annotations

import json
import os
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)                    # service/ on the path for adapters/sa3/colors


def _log(obj):
    sys.stderr.write("@@GB@@ " + json.dumps(obj) + "\n")
    sys.stderr.flush()


def _normalize_peak(path, target_dbfs=-1.0):
    """Peak-normalize a 16-bit PCM WAV to target_dbfs in place (stdlib wave + numpy).

    SA3's raw output isn't peak-bounded (it can graze full scale). For an honest A/B,
    loudness is a confound — match the peak across every render so the ear judges
    timbre/content, not which one happened to be louder. Best-effort: any failure
    leaves the original untouched."""
    try:
        import wave as _w
        import numpy as _np
        with _w.open(path, "rb") as r:
            n, ch, sw, fr = r.getnframes(), r.getnchannels(), r.getsampwidth(), r.getframerate()
            raw = r.readframes(n)
        if sw != 2:
            return False
        a = _np.frombuffer(raw, dtype=_np.int16).astype(_np.float32)
        peak = float(_np.max(_np.abs(a))) or 1.0
        target = (10.0 ** (target_dbfs / 20.0)) * 32767.0
        a = _np.clip(a * (target / peak), -32768, 32767).astype(_np.int16)
        with _w.open(path, "wb") as w:
            w.setnchannels(ch); w.setsampwidth(sw); w.setframerate(fr)
            w.writeframes(a.tobytes())
        return True
    except Exception:  # noqa: BLE001
        return False


def main():
    spec_path = sys.argv[1]
    with open(spec_path) as f:
        spec = json.load(f)

    # Lazy heavy import (only here, under the MLX venv).
    from adapters import stable_audio3_adapter as A

    if not A.available():
        _log({"fatal": "stable_audio3 unavailable — is SA3_MLX_DIR set + the MLX venv active?"})
        print(json.dumps([{"id": s.get("id"), "ok": False, "error": "sa3_unavailable"} for s in spec]))
        return 2

    _log({"backend": A.backend_name(), "count": len(spec),
          "steps": os.environ.get("SA3_STEPS", "8")})

    results = []
    for i, s in enumerate(spec):
        sid = s.get("id", f"t{i}")
        out = os.path.abspath(s["out"])
        os.makedirs(os.path.dirname(out), exist_ok=True)
        params = {
            "prompt": s.get("prompt", ""),
            "seed": int(s.get("seed", 0)),
            "colors": s.get("colors", []),
            "lab": bool(s.get("lab", False)),
        }
        method = s.get("method", "t2a")
        src = s.get("source")
        if method == "a2a" and src:
            params["nl"] = float(s.get("nl", 0.4))     # a2a needs nl → audio_to_audio path
            input_wav = os.path.abspath(src)
        else:
            input_wav = ""                              # t2a: no source → generate() from noise
        _log({"i": i + 1, "of": len(spec), "id": sid, "method": method,
              "prompt": params["prompt"][:80], "colors": params["colors"]})
        try:
            manifest = A.render(input_wav, out, params)
            normalized = _normalize_peak(out)                 # loudness-match for honest A/B
            manifest["peak_normalized"] = normalized
            results.append({"id": sid, "out": out, "ok": True, "manifest": manifest})
            _log({"done": sid, "pq": manifest.get("pq"), "mode": manifest.get("mode"), "norm": normalized})
        except Exception as e:  # noqa: BLE001
            results.append({"id": sid, "out": out, "ok": False, "error": str(e)[:200]})
            _log({"error": sid, "msg": str(e)[:200], "tb": traceback.format_exc()[-400:]})

    print(json.dumps(results))
    return 0


if __name__ == "__main__":
    sys.exit(main())
