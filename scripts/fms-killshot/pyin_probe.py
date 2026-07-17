#!/usr/bin/env python3
"""pyin voicing probe (mechanism-verify V0) — the PRIMARY vowel-landmark instrument.

librosa.pyin gives a real voiced/unvoiced decision per frame (its HMM), unlike FCPE at the
shipped 0.006 threshold (KS-B: "voicing always-on — unusable as segmentation evidence").
nsf_cli.py already trusts pyin on exactly this material. 10ms hop, native sample rate.

Run under the nsf venv (librosa + soundfile live there):
  ~/Library/Mosh/venvs/nsf/bin/python3 pyin_probe.py <in.wav> [--fmin 65 --fmax 1000]

Output (one JSON line on stdout):
  {"ok": true, "backend": "pyin", "hop_s": 0.01,
   "frames": [[t_sec, hz, voiced01], ...]}      # every frame; hz==0 where unvoiced
"""
import argparse
import json
import sys

_OUT = sys.stdout
sys.stdout = sys.stderr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("--fmin", type=float, default=65.0)
    ap.add_argument("--fmax", type=float, default=1000.0)
    args = ap.parse_args()

    try:
        import librosa
        import numpy as np
        import soundfile as sf
    except Exception as e:  # noqa: BLE001
        _OUT.write(json.dumps({"ok": False, "error": f"librosa stack not importable: {e}"}))
        return 1

    y, sr = sf.read(args.wav)
    if getattr(y, "ndim", 1) > 1:
        y = y.mean(axis=1)
    y = y.astype("float32")
    if not len(y):
        _OUT.write(json.dumps({"ok": True, "backend": "pyin", "hop_s": 0.01, "frames": []}))
        return 0

    hop = max(1, int(round(sr * 0.01)))
    f0, voiced, _ = librosa.pyin(y, sr=sr, fmin=args.fmin, fmax=args.fmax,
                                 frame_length=2048, hop_length=hop, center=True)
    f0 = np.nan_to_num(f0, nan=0.0)
    f0[~voiced] = 0.0
    hop_s = hop / float(sr)
    frames = [[round(i * hop_s, 4), round(float(h), 3), 1 if v else 0]
              for i, (h, v) in enumerate(zip(f0, voiced))]
    _OUT.write(json.dumps({"ok": True, "backend": "pyin", "hop_s": hop_s, "frames": frames}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
