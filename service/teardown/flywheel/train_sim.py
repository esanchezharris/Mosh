"""Reward-head training scaffold — learn a per-dimension weighting that PRESERVES the
ablation engine's known triplet ordering better than the raw encoder (the keystone result:
beat raw cosine at ordering original < one-swap < two-swap). v1 learns diagonal weights via
triplet-hinge gradient descent on a stand-in encoder; the real head fine-tunes MuQ/MERT
(music-native) on real anchors — gated.
"""
from __future__ import annotations

import numpy as np


def _dw(a: np.ndarray, b: np.ndarray, w: np.ndarray) -> float:
    d = a - b
    return float(np.sqrt(np.sum(w * d * d)) + 1e-9)


def ordering_accuracy(triplets, w: np.ndarray | None = None) -> float:
    """Fraction of (ref, near, far) where d(ref,near) < d(ref,far) — the known ordering."""
    if not triplets:
        return 0.0
    if w is None:
        w = np.ones(len(triplets[0][0]))
    ok = sum(1 for r, p, n in triplets if _dw(r, p, w) < _dw(r, n, w))
    return round(ok / len(triplets), 4)


def train_reward_head(triplets, epochs: int = 300, lr: float = 0.5, margin: float = 0.1,
                      seed: int = 0) -> np.ndarray:
    """Learn diagonal weights w ≥ 0 minimizing hinge(margin + d_w(r,near) − d_w(r,far))."""
    if not triplets:
        return np.ones(1)
    D = len(triplets[0][0])
    w = np.ones(D)
    for _ in range(epochs):
        grad = np.zeros(D)
        for r, p, n in triplets:
            dp, dn = (r - p) ** 2, (r - n) ** 2
            Dp = np.sqrt(np.sum(w * dp)) + 1e-9
            Dn = np.sqrt(np.sum(w * dn)) + 1e-9
            if margin + Dp - Dn > 0:                       # violated triplet
                grad += dp / (2 * Dp) - dn / (2 * Dn)
        w = np.clip(w - lr * grad / len(triplets), 0.0, None)
    s = float(w.sum())
    return (w / s * D) if s > 0 else np.ones(D)            # keep overall scale ~1 per dim
