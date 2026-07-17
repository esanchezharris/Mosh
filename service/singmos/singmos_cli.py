#!/usr/bin/env python3
"""SingMOS-Pro singing MOS for one wav -> {"ok": true, "mos": float}.

Requires the singmos venv (service/singmos/setup-singmos.sh). SingMOS is an SSL-based
singing MOS predictor (CC-BY 4.0). Any failure prints {"ok": false, "error": ...} so the
caller (bench_naturalness.singmos_score) degrades to None rather than crashing a benchmark.

Usage:  singmos_cli.py <wav>
"""
import json
import sys


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: singmos_cli.py <wav>"}))
        return
    wav = sys.argv[1]
    try:
        import librosa
        import torch
        # SingMOS ships as a torch.hub model; 16 kHz mono in, a single MOS out.
        predictor = torch.hub.load("South-Twilight/SingMOS:v0.2.0",
                                    "singing_ssl_mos", trust_repo=True)
        wave, _sr = librosa.load(wav, sr=16000, mono=True)
        x = torch.from_numpy(wave).unsqueeze(0)
        length = torch.tensor([x.shape[1]])
        score = float(predictor(x, length).item())
        print(json.dumps({"ok": True, "mos": round(score, 4)}))
    except Exception as e:  # noqa: BLE001 — never crash the caller; degrade to None
        print(json.dumps({"ok": False, "error": str(e)[:200]}))


if __name__ == "__main__":
    main()
