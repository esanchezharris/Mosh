#!/usr/bin/env python3
"""Diagnostic: within-layer pairwise angles of the shipped colour steering axes.

Steers only compose linearly when they share a `peak_layer`, so only SAME-LAYER
pairs can be de-correlated by orthogonalization (`colors/ortho.py`). This prints,
per shared layer, the cosine/angle between every colour pair — the "measure first"
artifact behind the orthogonalization work. Run it whenever the rack changes.

Run:  python3 service/colors/analyze_axes.py
"""
from __future__ import annotations

import json
import math
import os
from collections import defaultdict

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "COLORRACK_DATA")


def _angle(a, b):
    c = float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))
    return c, math.degrees(math.acos(max(-1.0, min(1.0, c))))


def main() -> int:
    reg = json.load(open(os.path.join(DATA, "colors.json")))["colors"]
    vecs = {n: np.load(os.path.join(DATA, e["vec_path"])).astype(np.float32) for n, e in reg.items()}

    by_layer = defaultdict(list)
    for n, e in reg.items():
        by_layer[int(e["peak_layer"])].append(n)

    print("Colour steering axes — within-layer pairwise angles")
    print("(only same-layer pairs compose linearly → only these are orthogonalizable)\n")
    for layer in sorted(by_layer):
        names = sorted(by_layer[layer])
        if len(names) < 2:
            print(f"  layer {layer:>2}: {names[0]}  (solo — nothing to orthogonalize)")
            continue
        print(f"  layer {layer:>2}: {', '.join(names)}")
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                cos, deg = _angle(vecs[names[i]], vecs[names[j]])
                flag = "  <-- correlated" if deg < 80.0 else ""
                print(f"      {names[i]:>14} ↔ {names[j]:<14}  {deg:5.1f}°  (cos {cos:+.3f}){flag}")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
