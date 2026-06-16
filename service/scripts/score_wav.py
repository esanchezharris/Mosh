#!/usr/bin/env python3
"""Score one or more WAVs and print a JSON array (one object per wav).

  hygiene    -> service/quality_readout.py  (clipping/loudness/dynamics/spectral; always on)
  perceptual -> service/sa3/qa.py            (Audiobox Aesthetics PQ via the judges venv; best-effort)

Batched on purpose: the perceptual judge loads its model once and scores every path
in a single sidecar round-trip, so pass ALL the arena's wavs in one call.

  score_wav.py out_R0.wav out_R1.wav ...
"""
import sys, os, json

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)
sys.path.insert(0, os.path.join(SERVICE, "sa3"))

import quality_readout as qr  # noqa: E402

paths = [p for p in sys.argv[1:] if p]

hygiene = {}
for p in paths:
    try:
        hygiene[p] = qr.analyze_wav(p)
    except Exception as e:  # noqa: BLE001
        hygiene[p] = {"error": f"hygiene_failed: {e}"}

# Perceptual is optional — degrade cleanly if the judges venv / model is absent.
perceptual = {}
perc_err = None
try:
    import qa  # service/sa3/qa.py
    perceptual = qa._pq(paths) or {}
except Exception as e:  # noqa: BLE001
    perc_err = str(e)

out = []
for p in paths:
    h = hygiene.get(p, {})
    flags = list(h.get("flags", []))
    pq_perc = perceptual.get(p) if isinstance(perceptual, dict) else None
    if pq_perc is None:
        flags.append("perceptual_unavailable" + (f": {perc_err}" if perc_err else ""))
    if "error" in h:
        flags.append(h["error"])
    out.append({
        "file": p,
        "pq_hygiene": h.get("pq"),
        "pq_perceptual": pq_perc,
        "metrics": h.get("metrics"),
        "flags": flags,
    })

print(json.dumps(out))
