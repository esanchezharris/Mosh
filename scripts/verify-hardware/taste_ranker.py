#!/usr/bin/env python3
"""Taste ranker v1 — a TINY regularized model over latent + symbolic features,
trained on the owner's keep/kill labels (topPick 3×-weighted), honestly evaluated
by leave-one-pack-out, and allowed to COMPOSE packs only if it clears the
pre-registered adoption bar (LOPO AUC ≥ 0.65). Below the bar it ships in ADVISORY
mode automatically (predictions on cards, zero composition power) — the fallback
is pre-declared, not judged after the fact. It never kills: gates are unchanged,
the ranker only orders what already passed (owner-chosen: "pre-rank + compose").

    python3 scripts/verify-hardware/taste_ranker.py --train     # LOPO eval + persist model
    python3 scripts/verify-hardware/taste_ranker.py --selfcheck # synthetic AUC pins

Model → ~/mosh-beats/labels/taste_ranker.json {featureSpec, pca, weights, lopo, mode}.
Features: CLAP PCA (fit unsupervised on every stored embedding) + Audiobox axes +
symbolic ledger features. n=56 ⇒ everything stays small and L2-regularized.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np

BEATS = Path(os.path.expanduser("~/mosh-beats"))
LEDGER = BEATS / "labels" / "labels.jsonl"
STORE = BEATS / "labels" / "embeddings" / "index.jsonl"
MODEL = BEATS / "labels" / "taste_ranker.json"
ADOPTION_AUC = 0.65
PCA_DIMS = 12
TOPPICK_WEIGHT = 3.0


def load_embeddings(view: str = "muq") -> dict:
    """path → embedding (embed_store rows). Default view = MuQ: music-specific, and the
    better LOPO of the two stored views (0.52 vs CLAP 0.42 at n=54 — both ADVISORY)."""
    out = {}
    if STORE.is_file():
        for line in STORE.read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                v = r.get(view) or r.get("clap")
                if v:
                    out[r["path"]] = np.asarray(v, dtype=np.float64)
    return out


def pack_rows() -> list:
    rows = [json.loads(l) for l in LEDGER.read_text().splitlines() if l.strip()]
    return [r for r in rows if r.get("kind") == "keep"
            and r.get("value") in ("keep", "kill") and r.get("features")]


def wav_path(row) -> str:
    return str(BEATS / row["round"] / row["file"])


def symbolic_features(row) -> list:
    f = row["features"]
    g = f.get("gate") or {}
    d = f.get("density") or {}
    return [float(g.get("subRatio") or 0.0),
            float(g.get("keyRank") or 0.0) / 23.0,
            float(f.get("rmsDb") or -20.0) / 20.0,
            float(f.get("tailEnergyDb") or 0.0) / 10.0,
            float(sum(d.values()) / max(1, len(d))) / 60.0,
            1.0 if (f.get("fx") or {}).get("applied") else 0.0,
            1.0 if f.get("form") else 0.0]


SYM_NAMES = ["subRatio", "keyRank", "rmsDb", "tailEnergy", "meanDensity", "fx", "form"]


def fit_pca(embs: dict, dims: int = PCA_DIMS):
    """Unsupervised PCA over EVERY stored embedding (labeled + unlabeled is fair)."""
    X = np.vstack(list(embs.values()))
    mean = X.mean(axis=0)
    Xc = X - mean
    _, _, vt = np.linalg.svd(Xc, full_matrices=False)
    comps = vt[:dims]
    return mean, comps


def features_for(row, embs, mean, comps):
    e = embs.get(wav_path(row))
    if e is None:
        return None
    lat = (e - mean) @ comps.T
    ax = (row["features"].get("axes") or {})
    axes = [float(ax.get(k) or 5.0) / 10.0 for k in ("PQ", "CE", "CU", "PC")]
    return np.concatenate([lat / 10.0, axes, symbolic_features(row)])


def _logistic_fit(X, y, w, l2=1.0, iters=500, lr=0.5):
    """Tiny L2 logistic (numpy — no sklearn dependency in the render path)."""
    Xb = np.hstack([X, np.ones((len(X), 1))])
    beta = np.zeros(Xb.shape[1])
    for _ in range(iters):
        p = 1.0 / (1.0 + np.exp(-(Xb @ beta)))
        grad = Xb.T @ (w * (p - y)) / len(y) + l2 * np.r_[beta[:-1], 0.0] / len(y)
        beta -= lr * grad
    return beta


def _predict(beta, X):
    Xb = np.hstack([X, np.ones((len(X), 1))])
    return 1.0 / (1.0 + np.exp(-(Xb @ beta)))


def _auc(y, s):
    order = np.argsort(s)
    ranks = np.empty(len(s), dtype=float)
    ranks[order] = np.arange(1, len(s) + 1)
    # average ties
    for v in np.unique(s):
        m = s == v
        ranks[m] = ranks[m].mean()
    n1 = int(y.sum())
    n0 = len(y) - n1
    if n1 == 0 or n0 == 0:
        return float("nan")
    return (ranks[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


def train(l2_grid=(0.3, 1.0, 3.0), view: str = "muq") -> dict:
    rows = pack_rows()
    embs = load_embeddings(view)
    have = [r for r in rows if wav_path(r) in embs]
    print(f"labeled beats with embeddings: {len(have)}/{len(rows)}")
    if len(have) < 20:
        print("not enough embedded labels — run embed_store --backfill first")
        return {}
    mean, comps = fit_pca(embs)
    X = np.vstack([features_for(r, embs, mean, comps) for r in have])
    y = np.array([1.0 if r["value"] == "keep" else 0.0 for r in have])
    w = np.array([TOPPICK_WEIGHT if r.get("topPick") else 1.0 for r in have])
    packs = np.array([r["round"] for r in have])

    best = None
    for l2 in l2_grid:
        aucs = []
        for pk in sorted(set(packs)):
            tr, te = packs != pk, packs == pk
            if te.sum() < 3 or len(set(y[te])) < 2:
                continue
            beta = _logistic_fit(X[tr], y[tr], w[tr], l2=l2)
            aucs.append(_auc(y[te], _predict(beta, X[te])))
        mean_auc = float(np.mean(aucs)) if aucs else float("nan")
        print(f"  l2={l2}: LOPO AUC per pack {['%.2f' % a for a in aucs]} → mean {mean_auc:.3f}")
        if best is None or mean_auc > best[1]:
            best = (l2, mean_auc, aucs)
    l2, lopo_auc, aucs = best
    beta = _logistic_fit(X, y, w, l2=l2)                    # final fit on ALL labels
    mode = "compose" if lopo_auc >= ADOPTION_AUC else "advisory"
    model = {"version": 1, "view": view, "n": len(have), "l2": l2,
             "lopo": {"perPack": [round(a, 4) for a in aucs], "mean": round(lopo_auc, 4),
                      "adoptionBar": ADOPTION_AUC},
             "mode": mode,
             "pcaMean": [round(float(v), 6) for v in mean],
             "pcaComps": [[round(float(v), 6) for v in c] for c in comps],
             "weights": [round(float(v), 6) for v in beta],
             "featureSpec": {"latDims": PCA_DIMS, "axes": ["PQ", "CE", "CU", "PC"],
                             "symbolic": SYM_NAMES}}
    MODEL.write_text(json.dumps(model))
    print(f"LOPO mean AUC {lopo_auc:.3f} vs bar {ADOPTION_AUC} → mode: {mode.upper()}")
    print(f"model → {MODEL}")
    return model


# ---- factory-side scoring (importable; numpy only) --------------------------------
def load_model() -> dict:
    return json.loads(MODEL.read_text()) if MODEL.is_file() else {}


def score_candidate(model: dict, clap_vec, axes: dict, sym_row: dict) -> float:
    """predictedKeep in [0,1] for a factory candidate row."""
    mean = np.asarray(model["pcaMean"])
    comps = np.asarray(model["pcaComps"])
    lat = ((np.asarray(clap_vec, dtype=np.float64) - mean) @ comps.T) / 10.0
    ax = [float((axes or {}).get(k) or 5.0) / 10.0 for k in ("PQ", "CE", "CU", "PC")]
    fake_row = {"features": sym_row, "value": "keep"}
    sym = symbolic_features(fake_row)
    x = np.concatenate([lat, ax, sym])[None, :]
    return float(_predict(np.asarray(model["weights"]), x)[0])


def selfcheck() -> int:
    rng = np.random.default_rng(7)
    X = rng.normal(size=(60, 8))
    y = (X[:, 0] > 0).astype(float)               # perfectly separable on dim 0
    w = np.ones(60)
    beta = _logistic_fit(X, y, w, l2=0.1)
    a = _auc(y, _predict(beta, X))
    assert a > 0.99, a
    ys = rng.permutation(y)                        # label-shuffle null
    beta2 = _logistic_fit(X[:40], ys[:40], w[:40], l2=0.1)
    a2 = _auc(ys[40:], _predict(beta2, X[40:]))
    assert 0.2 < a2 < 0.8, a2
    print(f"selfcheck OK: separable AUC {a:.3f}, shuffle-null held-out AUC {a2:.3f}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", action="store_true")
    ap.add_argument("--selfcheck", action="store_true")
    args = ap.parse_args(argv)
    if args.selfcheck:
        return selfcheck()
    if args.train:
        return 0 if train() else 1
    ap.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
