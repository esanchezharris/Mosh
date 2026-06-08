#!/usr/bin/env python3
"""mosh_judge_server.py — persistent Audiobox-Aesthetics judge sidecar for Mosh.

Loads Meta's Audiobox-Aesthetics model ONCE (via the producer-lab repo's
`AudioboxJudge`), then scores rendered WAVs on demand so Mosh gets a LEARNED
production-quality (PQ) score instead of its heuristic DSP proxy.

Protocol (line-oriented over stdin/stdout):
  * On startup, prints one handshake line: {"ready": true}  (or {"ready": false, "error": ...}).
  * Then reads one request per line on stdin — a bare WAV path or {"wav": "<path>"} —
    and writes one JSON result per line on stdout:
        {"PQ": .., "PC": .., "CE": .., "CU": ..}   each roughly 1-10
    or {"error": "..."} on a per-request failure.
  * "__quit__" (or EOF) shuts it down.

Run with the PRODUCER-LAB venv python (`MOSH_JUDGE_PYTHON`) — that venv has
`audiobox_aesthetics` + torch. This script imports the producer-lab package
`mosh_producer_lab.audio_aesthetics` by adding `<MOSH_JUDGE_PRODUCER_LAB>/src` to
sys.path, so it lives in the Mosh repo while reusing producer-lab's judge code.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# Run Audiobox on the CPU by default so it never contends for VRAM with the SA3 model
# (which peaks near a 12 GB card's limit during a generate). The judge runs once per
# render, so ~1-2 s on CPU is fine. Set MOSH_JUDGE_GPU=1 to use the GPU instead. Must
# happen BEFORE torch is imported (torch reads CUDA_VISIBLE_DEVICES at import time).
if os.environ.get("MOSH_JUDGE_GPU", "0") != "1":
    os.environ["CUDA_VISIBLE_DEVICES"] = ""

# Locate the producer-lab package (its src-layout) so `mosh_producer_lab` imports.
_PRODUCER_LAB = os.environ.get("MOSH_JUDGE_PRODUCER_LAB", r"C:\Users\dawha\MonsterDAWW\producer-lab")
_PL_SRC = os.path.join(_PRODUCER_LAB, "src")
if os.path.isdir(_PL_SRC) and _PL_SRC not in sys.path:
    sys.path.insert(0, _PL_SRC)


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> int:
    try:
        from mosh_producer_lab.audio_aesthetics import AudioboxJudge
    except Exception as exc:  # noqa: BLE001
        _emit({"ready": False, "error": f"import failed: {exc!r}"})
        return 2

    try:
        judge = AudioboxJudge()  # loads the model (downloads the ckpt on first use)
    except Exception as exc:  # noqa: BLE001
        _emit({"ready": False, "error": f"model load failed: {exc!r}"})
        return 2

    _emit({"ready": True})  # handshake — the client unblocks once this arrives

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        if line in ("__quit__", "quit"):
            break
        wav = line
        if line.startswith("{"):
            try:
                wav = str(json.loads(line).get("wav", ""))
            except Exception:  # noqa: BLE001
                wav = ""
        try:
            if not wav or not os.path.isfile(wav):
                _emit({"error": f"no such wav: {wav}"})
                continue
            scores = judge.score_files([wav])
            _emit(scores[0] if scores else {"error": "no score"})
        except Exception as exc:  # noqa: BLE001
            _emit({"error": f"score failed: {exc!r}"})

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
