#!/usr/bin/env python3
"""Gold candidates — the owner's OWN beats (the ground-truth "fire" anchor).

`~/Downloads/beatsnprojects` holds ~1296 wav exports of the owner's beats. We curate a diverse
subset, slice the fullest ~10s window (max sustained energy → skip intros/outros), and resample to
mono 44.1k (matching the Oracle-rendered candidates). These are AUDIO candidates (no program to
render) — build_pack2 scores the WAV directly. The key sub-question they answer: does the §12
reward rank the owner's own finished beats ABOVE the auto/degraded material?
"""
from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

import numpy as np
import soundfile as sf

SRC = Path(os.path.expanduser("~/Downloads/beatsnprojects"))
ASSET_DIR = Path(__file__).resolve().parent / ".assets" / "gold"
SR = 44100
WINDOW_S = 10.0
DUP = re.compile(r"\s*\(\d+\)$")


def _dedup_diverse(n: int) -> list[Path]:
    """Dedup '(1)/(2)' copies, keep real beats (≥18s), pick n evenly across the sorted set."""
    seen, picks = {}, []
    for f in sorted(SRC.glob("*.wav")):
        base = DUP.sub("", f.stem).lower()
        if base in seen:
            continue
        try:
            info = sf.info(str(f))
            dur = info.frames / info.samplerate
        except Exception:
            continue
        if dur < 18.0 or dur > 600:
            continue
        seen[base] = f
        picks.append(f)
    if len(picks) <= n:
        return picks
    step = len(picks) / n
    return [picks[int(i * step)] for i in range(n)]


def _best_window(y: np.ndarray, sr: int) -> np.ndarray:
    """Return the WINDOW_S slice with the highest mean |amp| (the fullest part of the beat)."""
    w = int(WINDOW_S * sr)
    if y.shape[0] <= w:
        return y
    env = np.abs(y)
    step = sr  # 1s hops
    best_i, best_e = 0, -1.0
    for i in range(0, y.shape[0] - w, step):
        e = float(env[i:i + w].mean())
        if e > best_e:
            best_e, best_i = e, i
    return y[best_i:best_i + w]


def build_gold(n_target: int = 18) -> list[dict]:
    if not SRC.is_dir():
        print(f"  [gold] {SRC} not found — no gold candidates")
        return []
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for f in _dedup_diverse(n_target):
        try:
            y, sr = sf.read(str(f), always_2d=True, dtype="float32")
        except Exception:
            continue
        y = y.mean(axis=1)  # mono (match Oracle renders)
        if sr != SR:
            n = int(round(y.shape[0] * SR / sr))
            y = np.interp(np.linspace(0, y.shape[0] - 1, n), np.arange(y.shape[0]), y).astype(np.float32)
        seg = _best_window(y, SR)
        if seg.size == 0 or float(np.sqrt((seg ** 2).mean())) < 1e-3:
            continue
        key = hashlib.sha1(str(f).encode()).hexdigest()[:12]
        dst = ASSET_DIR / f"{key}.wav"
        sf.write(str(dst), seg.astype(np.float32), SR, subtype="PCM_16")
        out.append({"cand_id": f"gold_{f.stem[:18]}", "group": f"gold_{key}", "label": "gold",
                    "intent": "gold", "kind": "audio", "wav": str(dst), "meta": {"src": f.name}})
    return out


if __name__ == "__main__":
    g = build_gold()
    print(f"{len(g)} gold candidates:")
    for c in g[:20]:
        print(f"  {c['cand_id']:26s} ← {c['meta']['src']}")
