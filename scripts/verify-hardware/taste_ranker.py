#!/usr/bin/env python3
"""Taste ranker v2 — a TINY regularized model over latent + symbolic + corpus
features, trained on the owner's keep/kill labels (topPick 3×-weighted), honestly
evaluated by leave-one-pack-out, and allowed to COMPOSE packs only if it clears
the pre-registered adoption bar (docs/bench/RANKER_PROMOTION.md; LOPO/prequential
AUC ≥ 0.65). Below the bar it ships in ADVISORY mode automatically (predictions
on cards, zero composition power). It never kills: gates are unchanged, the
ranker only orders what already passed (owner-chosen: "pre-rank + compose").

v2 adds (era-0, the Long Pass):
- CORPUS-SIMILARITY features — the positives-only answer to "my own music as
  taste data": cosine to the owner-corpus centroid (own/), mean top-3 cosine to
  reference tracks (refs/), and cosine to the keep centroid (fold-safe:
  train-fold keeps only, leave-self-out). The keep/kill labels learn the
  weights, so useless similarity regularizes to ~0. ABLATION-GATED: the corpus
  block ships only if LOPO does not degrade vs the v1 feature set.
- AUX HEADS on the idea/mix split verdicts (explicit values only) — the keep
  head remains the sole adoption metric.
- --report: PREQUENTIAL per-pack AUC from the predictedKeep values STAMPED into
  pack.json before the owner heard anything (pre-registered by construction),
  Brier + calibration deciles → docs/bench/RANKER_CALIBRATION.md.

    python3 scripts/verify-hardware/taste_ranker.py --train
    python3 scripts/verify-hardware/taste_ranker.py --report
    python3 scripts/verify-hardware/taste_ranker.py --selfcheck

Model → ~/mosh-beats/labels/taste_ranker.json.
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
REPORT_JSON = BEATS / "labels" / "ranker_report.json"
HERE = Path(__file__).resolve().parent
REPORT_MD = HERE.parent.parent / "docs" / "bench" / "RANKER_CALIBRATION.md"
ADOPTION_AUC = 0.65
PCA_DIMS = 12
TOPPICK_WEIGHT = 3.0
CORPUS_NAMES = ["simOwnCentroid", "simRefTop3", "simKeepCentroid"]
MAX_STORED_REFS = 200


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


def corpus_vectors(view: str = "muq") -> tuple:
    """(own_vecs, ref_vecs) — corpus rows carry a source tag (embed_store --corpus).
    Same-view-only (mixing MuQ beats with CLAP-only corpus rows would compare
    apples to oranges), so a CLAP-only corpus row is simply absent from the MuQ
    similarity features."""
    own, ref = [], []
    if STORE.is_file():
        for line in STORE.read_text().splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            v = r.get(view)
            if not v:
                continue
            if r.get("source") == "own":
                own.append(np.asarray(v, dtype=np.float64))
            elif r.get("source") == "ref":
                ref.append(np.asarray(v, dtype=np.float64))
    return own, ref


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


def _cos(a, b) -> float:
    d = np.linalg.norm(a) * np.linalg.norm(b)
    return float(a @ b / d) if d else 0.0


def _sim_ref_top3(vec, ref_vecs) -> float:
    if not ref_vecs:
        return 0.0
    sims = sorted(_cos(vec, r) for r in ref_vecs)[-3:]
    return float(np.mean(sims))


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


def _keep_sim_col(vecs, y, train_idx: set, rows_idx) -> np.ndarray:
    """simKeepCentroid, FOLD-SAFE: the centroid is built from TRAIN-fold keeps only;
    a train keep sees the centroid WITHOUT itself (leave-self-out) so the feature
    never encodes its own label."""
    keeps = [i for i in train_idx if y[i] == 1.0]
    if not keeps:
        return np.zeros(len(rows_idx))
    ksum = np.sum([vecs[i] for i in keeps], axis=0)
    kn = len(keeps)
    col = []
    for i in rows_idx:
        if i in train_idx and y[i] == 1.0:
            if kn <= 1:
                col.append(0.0)
                continue
            c = (ksum - vecs[i]) / (kn - 1)
        else:
            c = ksum / kn
        col.append(_cos(vecs[i], c))
    return np.asarray(col)


def train(l2_grid=(0.3, 1.0, 3.0), view: str = "muq") -> dict:
    rows = pack_rows()
    embs = load_embeddings(view)
    have = [r for r in rows if wav_path(r) in embs]
    print(f"labeled beats with embeddings: {len(have)}/{len(rows)}")
    if len(have) < 20:
        print("not enough embedded labels — run embed_store --backfill first")
        return {}
    mean, comps = fit_pca(embs)
    base = np.vstack([features_for(r, embs, mean, comps) for r in have])
    vecs = [embs[wav_path(r)] for r in have]
    y = np.array([1.0 if r["value"] == "keep" else 0.0 for r in have])
    w = np.array([TOPPICK_WEIGHT if r.get("topPick") else 1.0 for r in have])
    packs = np.array([r["round"] for r in have])

    own, ref = corpus_vectors(view)
    own_centroid = np.mean(own, axis=0) if own else None
    static = np.array([[(_cos(v, own_centroid) if own_centroid is not None else 0.0),
                        _sim_ref_top3(v, ref)] for v in vecs])

    def fold_X(train_idx: set, rows_idx, with_corpus: bool):
        if not with_corpus:
            return base[rows_idx]
        col = _keep_sim_col(vecs, y, train_idx, rows_idx)
        return np.hstack([base[rows_idx], static[rows_idx], col[:, None]])

    results = {}
    for variant, with_corpus in (("v1", False), ("v2corpus", True)):
        best = None
        for l2 in l2_grid:
            aucs = []
            for pk in sorted(set(packs)):
                tr_idx = np.where(packs != pk)[0]
                te_idx = np.where(packs == pk)[0]
                if len(te_idx) < 3 or len(set(y[te_idx])) < 2:
                    continue
                tset = set(tr_idx.tolist())
                beta = _logistic_fit(fold_X(tset, tr_idx, with_corpus),
                                     y[tr_idx], w[tr_idx], l2=l2)
                aucs.append(_auc(y[te_idx],
                                 _predict(beta, fold_X(tset, te_idx, with_corpus))))
            mean_auc = float(np.mean(aucs)) if aucs else float("nan")
            print(f"  [{variant}] l2={l2}: LOPO per pack "
                  f"{['%.2f' % a for a in aucs]} → mean {mean_auc:.3f}")
            if best is None or mean_auc > best[1]:
                best = (l2, mean_auc, aucs)
        results[variant] = best

    # ablation gate (pre-registered): corpus features ship only if LOPO does not degrade
    use_corpus = results["v2corpus"][1] >= results["v1"][1]
    l2, lopo_auc, aucs = results["v2corpus" if use_corpus else "v1"]
    print(f"corpus-feature ablation: v1 {results['v1'][1]:.3f} vs "
          f"v2corpus {results['v2corpus'][1]:.3f} → "
          f"{'CORPUS FEATURES ON' if use_corpus else 'corpus features off (no lift)'}")

    all_idx = np.arange(len(have))
    tset = set(all_idx.tolist())
    X_full = fold_X(tset, all_idx, use_corpus)
    beta = _logistic_fit(X_full, y, w, l2=l2)               # final fit on ALL labels
    mode = "compose" if lopo_auc >= ADOPTION_AUC else "advisory"

    # aux heads on explicit idea/mix divergence labels (era-0 page v2 data;
    # the keep head above remains the SOLE adoption metric)
    heads = {}
    for key in ("idea", "mix"):
        lab = [(i, 1.0 if have[i].get(key) == "good" else 0.0)
               for i in range(len(have)) if have[i].get(key) in ("good", "bad")]
        if len(lab) >= 10 and len({v for _, v in lab}) == 2:
            idx = np.array([i for i, _ in lab])
            yk = np.array([v for _, v in lab])
            bk = _logistic_fit(X_full[idx], yk, np.ones(len(idx)), l2=3.0)
            heads[key] = {"n": len(lab),
                          "weights": [round(float(v), 6) for v in bk]}

    model = {"version": 2, "view": view, "n": len(have), "l2": l2,
             "lopo": {"perPack": [round(a, 4) for a in aucs], "mean": round(lopo_auc, 4),
                      "adoptionBar": ADOPTION_AUC,
                      "ablation": {"v1": round(results["v1"][1], 4),
                                   "v2corpus": round(results["v2corpus"][1], 4)}},
             "mode": mode,
             "pcaMean": [round(float(v), 6) for v in mean],
             "pcaComps": [[round(float(v), 6) for v in c] for c in comps],
             "weights": [round(float(v), 6) for v in beta],
             "heads": heads,
             "featureSpec": {"latDims": PCA_DIMS, "axes": ["PQ", "CE", "CU", "PC"],
                             "symbolic": SYM_NAMES,
                             "corpus": CORPUS_NAMES if use_corpus else []}}
    if use_corpus:
        keeps = [vecs[i] for i in range(len(have)) if y[i] == 1.0]
        model["keepCentroid"] = [round(float(v), 5) for v in np.mean(keeps, axis=0)]
        model["ownCentroid"] = ([round(float(v), 5) for v in own_centroid]
                                if own_centroid is not None else None)
        model["refVecs"] = [[round(float(v), 4) for v in r]
                            for r in ref[:MAX_STORED_REFS]]
    MODEL.write_text(json.dumps(model))
    print(f"LOPO mean AUC {lopo_auc:.3f} vs bar {ADOPTION_AUC} → mode: {mode.upper()}"
          + (f" · heads: {sorted(heads)}" if heads else ""))
    print(f"model → {MODEL}")
    return model


# ---- factory-side scoring (importable; numpy only) --------------------------------
def load_model() -> dict:
    return json.loads(MODEL.read_text()) if MODEL.is_file() else {}


def _corpus_feats_from_model(model: dict, vec) -> list:
    own = model.get("ownCentroid")
    refs = model.get("refVecs") or []
    keep = model.get("keepCentroid")
    return [(_cos(vec, np.asarray(own)) if own else 0.0),
            _sim_ref_top3(vec, [np.asarray(r) for r in refs]),
            (_cos(vec, np.asarray(keep)) if keep else 0.0)]


def score_candidate(model: dict, clap_vec, axes: dict, sym_row: dict) -> float:
    """predictedKeep in [0,1] for a factory candidate row."""
    mean = np.asarray(model["pcaMean"])
    comps = np.asarray(model["pcaComps"])
    vec = np.asarray(clap_vec, dtype=np.float64)
    lat = ((vec - mean) @ comps.T) / 10.0
    ax = [float((axes or {}).get(k) or 5.0) / 10.0 for k in ("PQ", "CE", "CU", "PC")]
    fake_row = {"features": sym_row, "value": "keep"}
    sym = symbolic_features(fake_row)
    parts = [lat, ax, sym]
    if (model.get("featureSpec") or {}).get("corpus"):
        parts.append(_corpus_feats_from_model(model, vec))
    x = np.concatenate([np.asarray(p, dtype=np.float64) for p in parts])[None, :]
    return float(_predict(np.asarray(model["weights"]), x)[0])


# ---- prequential report (the adoption metric's ledger) ----------------------------
def report() -> int:
    """Per-pack PREQUENTIAL AUC from the predictedKeep values stamped into pack.json
    BEFORE the owner heard anything — the true deployment test, immune to
    retrospective refit. Plus Brier, keep/kill mean p, argmax-vs-topPick, and
    pooled calibration deciles."""
    rows = [r for r in pack_rows()
            if (r["features"].get("predictedKeep")) is not None]
    if not rows:
        print("no stamped predictedKeep in any rated pack yet")
        return 0
    by_pack: dict = {}
    for r in rows:
        by_pack.setdefault(r["round"], []).append(r)
    table = []
    for pk in sorted(by_pack):
        rs = by_pack[pk]
        y = np.array([1.0 if r["value"] == "keep" else 0.0 for r in rs])
        p = np.array([float(r["features"]["predictedKeep"]) for r in rs])
        auc = _auc(y, p) if len(set(y)) == 2 else float("nan")
        brier = float(np.mean((p - y) ** 2))
        argmax_f = rs[int(np.argmax(p))]["file"]
        top = next((r["file"] for r in rs if r.get("topPick")), None)
        table.append({"pack": pk, "n": len(rs), "keeps": int(y.sum()),
                      "prequentialAuc": round(float(auc), 4),
                      "brier": round(brier, 4),
                      "meanPKeeps": round(float(p[y == 1].mean()), 4) if y.sum() else None,
                      "meanPKills": round(float(p[y == 0].mean()), 4) if (y == 0).sum() else None,
                      "argmaxIsTopPick": bool(top and argmax_f == top),
                      "rankerMode": rs[0]["features"].get("rankerMode")})
    ally = np.array([1.0 if r["value"] == "keep" else 0.0 for r in rows])
    allp = np.array([float(r["features"]["predictedKeep"]) for r in rows])
    deciles = []
    for lo in np.arange(0.0, 1.0, 0.1):
        m = (allp >= lo) & (allp < lo + 0.1 + (1e-9 if lo >= 0.9 else 0))
        if m.sum():
            deciles.append({"bucket": f"{lo:.1f}–{lo + 0.1:.1f}", "n": int(m.sum()),
                            "meanP": round(float(allp[m].mean()), 3),
                            "keepRate": round(float(ally[m].mean()), 3)})
    aucs = [t["prequentialAuc"] for t in table if not np.isnan(t["prequentialAuc"])]
    out = {"packs": table, "calibrationDeciles": deciles,
           "prequentialMean": round(float(np.mean(aucs)), 4) if aucs else None,
           "adoptionBar": ADOPTION_AUC}
    REPORT_JSON.write_text(json.dumps(out, indent=1))

    lines = ["# Taste-ranker calibration (prequential)", "",
             "*predictedKeep values were STAMPED into pack.json before the owner",
             "heard anything — pre-registered by construction. Regenerated by",
             "`taste_ranker.py --report` at every era boundary.*", "",
             f"**Prequential mean AUC: {out['prequentialMean']}**"
             f" (adoption bar {ADOPTION_AUC} — see docs/bench/RANKER_PROMOTION.md)", "",
             "| pack | n | keeps | prequential AUC | Brier | p̄(keeps) | p̄(kills) |"
             " argmax = top pick | mode |", "|---|---|---|---|---|---|---|---|---|"]
    for t in table:
        lines.append(f"| {t['pack']} | {t['n']} | {t['keeps']} | {t['prequentialAuc']}"
                     f" | {t['brier']} | {t['meanPKeeps']} | {t['meanPKills']}"
                     f" | {'✓' if t['argmaxIsTopPick'] else '—'}"
                     f" | {t['rankerMode'] or '—'} |")
    lines += ["", "## Calibration (pooled deciles)", "",
              "| predictedKeep | n | mean p | realized keep-rate |", "|---|---|---|---|"]
    for d in deciles:
        lines.append(f"| {d['bucket']} | {d['n']} | {d['meanP']} | {d['keepRate']} |")
    REPORT_MD.parent.mkdir(parents=True, exist_ok=True)
    REPORT_MD.write_text("\n".join(lines) + "\n")
    print(f"prequential report → {REPORT_MD}\njson → {REPORT_JSON}")
    return 0


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
    # fold-safety pin: a train keep's simKeepCentroid must EXCLUDE itself —
    # with 2 identical keep vectors, leave-self-out sees the OTHER vector (cos 1.0
    # here since they're identical), and a kill sees the plain centroid.
    vecs = [np.array([1.0, 0.0]), np.array([1.0, 0.0]), np.array([0.0, 1.0])]
    yk = np.array([1.0, 1.0, 0.0])
    col = _keep_sim_col(vecs, yk, {0, 1}, np.array([0, 1, 2]))
    assert abs(col[0] - 1.0) < 1e-9 and abs(col[2] - 0.0) < 1e-9, col
    single = _keep_sim_col(vecs, yk, {0}, np.array([0]))
    assert single[0] == 0.0, single  # lone keep has no leave-self-out centroid
    print(f"selfcheck OK: separable AUC {a:.3f}, shuffle-null held-out AUC {a2:.3f}, "
          "keep-sim fold-safety pinned")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", action="store_true")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--selfcheck", action="store_true")
    args = ap.parse_args(argv)
    if args.selfcheck:
        return selfcheck()
    if args.report:
        return report()
    if args.train:
        return 0 if train() else 1
    ap.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
