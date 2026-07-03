#!/usr/bin/env python3
"""Latent-space lanes for the factory (all ADVISORY-safe):
- predictedKeep from the taste ranker model (advisory mode: card info only)
- more-like-top-pick: cosine similarity to the owner's beloved pack-004 #14
- style centroids from HIS confirmed exemplars → multi-tag "sounds like" labels

Everything reads the persistent embed store; missing data degrades to no-ops.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np

BEATS = Path(os.path.expanduser("~/mosh-beats"))
STORE = BEATS / "labels" / "embeddings" / "index.jsonl"
LEDGER = BEATS / "labels" / "labels.jsonl"
TOP_PICK = ("pack-004", "14_dark_140_Fminor.wav")   # owner: "I love it"
CENTROID_MIN_COS = 0.45                              # multi-tag threshold (calibrate)

# style exemplars = beats HE confirmed (notes/chips), not our requested tags.
# dark-menacing: his dark keeps MINUS the ones he flagged "not dark" (p3-06/11/14
# stayed unflagged; p4-03 "close to happy", p4-07 kill, p4-14 "not exactly dark" excluded).
STYLE_EXEMPLARS = {
    "melodic-heartfelt": [("pack-004", "11_emotional_148_Aminor.wav"),
                          ("pack-004", "05_emotional_148_Gminor.wav")],
    "club-swag": [("pack-003", "02_chill_132_Csminor.wav"),
                  ("pack-004", "01_chill_132_Csminor.wav")],
    "disrespectful": [("pack-003", "03_aggressive_152_Csminor.wav"),
                      ("pack-004", "06_aggressive_152_Dminor.wav")],
    "dark-menacing": [("pack-003", "06_dark_140_Csminor.wav"),
                      ("pack-003", "11_dark_140_Aminor.wav"),
                      ("pack-003", "14_dark_140_Csminor.wav"),
                      ("pack-004", "12_dark_140_Csminor.wav")],
}


def load_store(view: str = "muq") -> dict:
    out = {}
    if STORE.is_file():
        for line in STORE.read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                v = r.get(view) or r.get("clap")
                if v:
                    out[r["path"]] = np.asarray(v, dtype=np.float64)
    return out


def _cos(a, b) -> float:
    d = np.linalg.norm(a) * np.linalg.norm(b)
    return float(a @ b / d) if d else 0.0


def embed_candidates(paths: list) -> None:
    """Embed new candidate WAVs into the store (judges venv subprocess; advisory)."""
    here = os.path.dirname(os.path.abspath(__file__))
    try:
        subprocess.run([sys.executable, os.path.join(here, "embed_store.py"),
                        "--wavs"] + paths, timeout=1800, check=False)
    except Exception as e:  # noqa: BLE001
        print(f"  (candidate embedding skipped: {e})", file=sys.stderr)


def top_pick_vec(store: dict):
    p = str(BEATS / TOP_PICK[0] / TOP_PICK[1])
    return store.get(p)


def style_centroids(store: dict) -> dict:
    cents = {}
    for style, refs in STYLE_EXEMPLARS.items():
        vecs = [store[str(BEATS / r / f)] for r, f in refs if str(BEATS / r / f) in store]
        if vecs:
            cents[style] = np.mean(vecs, axis=0)
    return cents


def annotate_rows(rows: list, view: str = "muq") -> None:
    """Attach predictedKeep (advisory), simTopPick, soundsLike to passing rows in place."""
    store = load_store(view)
    tp = top_pick_vec(store)
    cents = style_centroids(store)
    model = {}
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import taste_ranker as T
        model = T.load_model()
    except Exception:  # noqa: BLE001
        pass
    for r in rows:
        vec = store.get(r["file"])
        if vec is None:
            continue
        if tp is not None:
            r["simTopPick"] = round(_cos(vec, tp), 4)
        tags = sorted([(round(_cos(vec, c), 3), s) for s, c in cents.items()
                       if _cos(vec, c) >= CENTROID_MIN_COS], reverse=True)
        r["soundsLike"] = [s for _, s in tags[:3]]
        if model:
            try:
                r["predictedKeep"] = round(T.score_candidate(
                    model, vec, r.get("axes") or {},
                    {k: r.get(k) for k in ("gate", "density", "rmsDb", "tailEnergyDb",
                                           "fx", "form")}), 4)
                r["rankerMode"] = model.get("mode", "advisory")
            except Exception as e:  # noqa: BLE001
                print(f"  (ranker score failed on {r['id']}: {str(e)[:80]})", file=sys.stderr)
