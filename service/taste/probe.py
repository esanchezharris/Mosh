"""Deterministic logistic probe + temporal-split AUC (charter Q1).

Pure stdlib on purpose: the probe must be bit-identical across machines and runs so the
AUC table is a golden artifact, and the archive is tiny (tens-to-hundreds of labels) so
closed-form speed is irrelevant. Full-batch gradient descent with fixed iterations, fixed
learning rate, and in-fit standardization; no randomness anywhere.

Honesty contract: a family that cannot produce a meaningful AUC (missing class on either
side of the temporal split, or no labels at all) reports a status and auc=None — it never
fabricates 0.5.
"""
from __future__ import annotations

import math

TRUST_BAR = 0.7  # charter: below this a judge stays advisory


def auc(scores, labels):
    """Tie-aware Mann-Whitney AUC. None when a class is absent."""
    pos = [s for s, y in zip(scores, labels) if y == 1]
    neg = [s for s, y in zip(scores, labels) if y == 0]
    if not pos or not neg:
        return None
    wins = 0.0
    for p in pos:
        for n in neg:
            if p > n:
                wins += 1.0
            elif p == n:
                wins += 0.5
    return wins / (len(pos) * len(neg))


def temporal_split(rows, eval_frac=0.25):
    """Sort by ts ascending; the newest eval_frac goes to eval (taste drifts — the
    probe must predict FORWARD in time, never interpolate seed variants)."""
    ordered = sorted(rows, key=lambda r: r["ts"])
    n_eval = max(1, int(round(len(ordered) * eval_frac))) if ordered else 0
    return ordered[:len(ordered) - n_eval], ordered[len(ordered) - n_eval:]


def _standardize(xs):
    dim = len(xs[0])
    mean = [sum(x[j] for x in xs) / len(xs) for j in range(dim)]
    var = [sum((x[j] - mean[j]) ** 2 for x in xs) / len(xs) for j in range(dim)]
    std = [math.sqrt(v) if v > 1e-12 else 1.0 for v in var]
    return mean, std


def _apply(x, mean, std):
    return [(x[j] - mean[j]) / std[j] for j in range(len(x))]


def fit_logistic(xs, ys, l2=1e-2, iters=400, lr=0.5):
    """Deterministic full-batch GD. Returns (weights, bias, mean, std)."""
    mean, std = _standardize(xs)
    zs = [_apply(x, mean, std) for x in xs]
    dim = len(zs[0])
    w = [0.0] * dim
    b = 0.0
    n = float(len(zs))
    for _ in range(iters):
        gw = [l2 * w[j] for j in range(dim)]
        gb = 0.0
        for z, y in zip(zs, ys):
            m = b + sum(w[j] * z[j] for j in range(dim))
            p = 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, m))))
            err = p - y
            for j in range(dim):
                gw[j] += err * z[j] / n
            gb += err / n
        for j in range(dim):
            w[j] -= lr * gw[j]
        b -= lr * gb
    return w, b, mean, std


def score(x, model):
    w, b, mean, std = model
    z = _apply(x, mean, std)
    m = b + sum(w[j] * z[j] for j in range(len(w)))
    return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, m))))


def evaluate(rows, eval_frac=0.25):
    """Fit on the temporal-train side, report AUC on the temporal-eval side.

    rows: [{"ts": int, "y": 0|1, "x": [float, ...]}, ...]
    """
    result = {"n": len(rows), "n_train": 0, "n_eval": 0, "auc": None,
              "status": "no_labels", "clears_trust_bar": False}
    if not rows:
        return result
    dims = {len(r["x"]) for r in rows}
    if len(dims) != 1:
        raise ValueError(f"mixed feature dimensions: {sorted(dims)}")
    train, ev = temporal_split(rows, eval_frac=eval_frac)
    result["n_train"], result["n_eval"] = len(train), len(ev)
    train_classes = {r["y"] for r in train}
    eval_classes = {r["y"] for r in ev}
    if train_classes != {0, 1} or eval_classes != {0, 1}:
        result["status"] = "insufficient_labels"
        return result
    model = fit_logistic([r["x"] for r in train], [r["y"] for r in train])
    scores = [score(r["x"], model) for r in ev]
    a = auc(scores, [r["y"] for r in ev])
    result["auc"] = None if a is None else round(a, 4)
    result["status"] = "ok"
    result["clears_trust_bar"] = a is not None and a >= TRUST_BAR
    return result
