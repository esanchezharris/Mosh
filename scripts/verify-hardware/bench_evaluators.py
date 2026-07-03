#!/usr/bin/env python3
"""Evaluator bench: do external audio-quality signals predict the OWNER's keep/kill?

A cumulative scoreboard, not a verdict (2026-07 program rule: metrics are filters,
never unchecked judges). Reads the label ledger + attached Audiobox axes, computes
CLAP scores via the judges venv, and reports per-signal AUC with EXACT permutation
p-values, Hanley–McNeil CIs, and a max-statistic multiple-comparison correction.
At n=14 (7/7) only AUC ≥ 0.776 clears one-sided α=0.05 — verdicts are limited to
prioritize / deprioritize / insufficient. The pre-registered adoption bar
(AUC ≥ 0.65, docs/bench/MUSIC_EVAL_RESEARCH.md) fires only under leave-one-pack-out
once ≥2 rated packs exist.

    python3 scripts/verify-hardware/bench_evaluators.py [--no-clap] [--selfcheck]

Regenerates docs/bench/EVALUATOR_BENCH_R1.md + ~/mosh-beats/labels/bench-r1.json
reproducibly from the ledger alone.
"""
from __future__ import annotations

import argparse
import itertools
import json
import math
import os
import random
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BEATS = os.path.expanduser("~/mosh-beats")
LEDGER = os.path.join(BEATS, "labels", "labels.jsonl")
AXES_BACKFILL = os.path.join(BEATS, "labels", "axes-backfill.json")
JUDGES_PY = os.path.expanduser("~/AI/judges_venv/bin/python")
CLAP_CKPT = os.path.expanduser("~/AI/clap_ckpt/630k-audioset-best.pt")
DOC_OUT = os.path.join(REPO, "docs", "bench", "EVALUATOR_BENCH_R1.md")
JSON_OUT = os.path.join(BEATS, "labels", "bench-r1.json")

# Old audition rounds: round id → wav dir (relative to ~/mosh-beats). A/B rounds
# compare the round's own renders against the PREVIOUS round's dir for the same file.
STAR_DIRS = {"r1": "owner-dna/v1", "r2": "owner-dna"}
PREF_DIRS = {"r3ab": ("owner-dna-v3", "owner-dna"), "r4ab": ("owner-dna-v4", "owner-dna-v3")}

CLAP_POS = ["a hard-hitting professional trap beat",
            "a polished modern hip hop instrumental with deep 808 bass"]
CLAP_NEG = ["a messy amateur beat loop",
            "poorly mixed low quality music demo"]
CLAP_MOODS = {"happy": "a happy uplifting cheerful beat",
              "dark": "a dark moody menacing beat"}

# Pre-registered direction for every signal: HIGHER on keeps. Future packs test these
# one-sided (confirmatory); flipping a direction after seeing data is not allowed.
SIGNALS = ["PQ", "CE", "CU", "PC", "clapPos", "clapContrast", "clapKeptCentroid", "rmsDb"]


# ---------------------------------------------------------------- stats (exact)

def _ranks(values):
    """Average ranks (1-based) with ties."""
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    return ranks


def auc_from_ranks(ranks, pos_idx):
    n_pos = len(pos_idx)
    n_neg = len(ranks) - n_pos
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    r_pos = sum(ranks[i] for i in pos_idx)
    return (r_pos - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg)


def exact_relabelings(n, n_pos, cap=200_000):
    """All C(n, n_pos) positive-index sets, or a seeded sample if too many."""
    total = math.comb(n, n_pos)
    if total <= cap:
        return list(itertools.combinations(range(n), n_pos)), True
    rng = random.Random(7)
    seen = set()
    while len(seen) < 20_000:
        seen.add(tuple(sorted(rng.sample(range(n), n_pos))))
    return list(seen), False


def permutation_report(signal_values: dict, pos_idx: list):
    """Per-signal one-sided exact p (pre-registered direction: higher on positives)
    + max-statistic corrected p across all signals. Returns {sig: (auc, p, p_corr)}."""
    names = [s for s in signal_values if signal_values[s] is not None]
    n = len(next(iter(signal_values.values()))) if names else 0
    ranks = {s: _ranks(signal_values[s]) for s in names}
    obs = {s: auc_from_ranks(ranks[s], pos_idx) for s in names}
    relabels, exact = exact_relabelings(n, len(pos_idx))
    ge = {s: 0 for s in names}
    max_ge = {s: 0 for s in names}
    for combo in relabels:
        combo = list(combo)
        aucs = {s: auc_from_ranks(ranks[s], combo) for s in names}
        m = max(aucs.values())
        for s in names:
            if aucs[s] >= obs[s] - 1e-12:
                ge[s] += 1
            if m >= obs[s] - 1e-12:
                max_ge[s] += 1
    total = len(relabels)
    return {s: (obs[s], ge[s] / total, max_ge[s] / total) for s in names}, exact


def critical_auc(n: int, n_pos: int, alpha: float = 0.05) -> tuple:
    """Smallest AUC clearing one-sided alpha under the exact permutation null."""
    relabels, _ = exact_relabelings(n, n_pos)
    ranks = _ranks(list(range(n)))
    aucs = sorted(auc_from_ranks(ranks, list(c)) for c in relabels)
    total = len(aucs)
    for a in sorted(set(aucs)):
        p = sum(1 for x in aucs if x >= a - 1e-12) / total
        if p <= alpha:
            return round(a, 3), round(p, 4)
    return 1.0, 1.0 / total


def hanley_mcneil_ci(auc, n_pos, n_neg):
    if math.isnan(auc):
        return (float("nan"), float("nan"))
    q1 = auc / (2.0 - auc)
    q2 = 2.0 * auc * auc / (1.0 + auc)
    var = (auc * (1 - auc) + (n_pos - 1) * (q1 - auc * auc)
           + (n_neg - 1) * (q2 - auc * auc)) / (n_pos * n_neg)
    se = math.sqrt(max(var, 0.0))
    return (max(0.0, auc - 1.96 * se), min(1.0, auc + 1.96 * se))


def spearman(xs, ys):
    rx, ry = _ranks(xs), _ranks(ys)
    mx, my = sum(rx) / len(rx), sum(ry) / len(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    return num / den if den else float("nan")


def spearman_perm_p(xs, ys, n_iter=20_000):
    obs = spearman(xs, ys)
    if math.isnan(obs):
        return obs, float("nan")
    rng = random.Random(7)
    ys2 = list(ys)
    ge = 0
    for _ in range(n_iter):
        rng.shuffle(ys2)
        if spearman(xs, ys2) >= obs - 1e-12:
            ge += 1
    return obs, ge / n_iter


def binom_tail_one_sided(k, n):
    """P(X >= k) for X~Bin(n, 0.5)."""
    return sum(math.comb(n, i) for i in range(k, n + 1)) / (2 ** n)


def verdict(auc, p_one):
    if math.isnan(auc):
        return "unavailable"
    if p_one <= 0.10 and auc >= 0.70:
        return "prioritize"
    if auc < 0.50:
        return "deprioritize"
    return "insufficient"


# ---------------------------------------------------------------- CLAP plumbing

def _cos(a, b):
    num = sum(x * y for x, y in zip(a, b))
    den = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(x * x for x in b))
    return num / den if den else 0.0


def clap_embeddings(wavs: list, texts: list) -> dict:
    """{'audio': {path: vec}, 'text': {text: vec}} via the judges venv, or {} if
    the venv/checkpoint is absent (bench degrades to axes-only, loudly)."""
    if not (os.path.isfile(JUDGES_PY) and os.path.isfile(CLAP_CKPT)):
        print(f"  (CLAP skipped: venv or ckpt absent — {JUDGES_PY}, {CLAP_CKPT})",
              file=sys.stderr)
        return {}
    scorer = os.path.join(os.path.dirname(os.path.abspath(__file__)), "clap_score.py")
    with tempfile.TemporaryDirectory() as td:
        req = os.path.join(td, "req.json")
        out = os.path.join(td, "out.json")
        json.dump({"wavs": wavs, "texts": texts}, open(req, "w"))
        proc = subprocess.run([JUDGES_PY, scorer, "--request", req, "--out", out],
                              capture_output=True, text=True, timeout=1200)
        if proc.returncode != 0 or not os.path.isfile(out):
            print(f"  (CLAP failed: {proc.stderr.strip()[-400:]})", file=sys.stderr)
            return {}
        emb = json.load(open(out))
    print(f"  CLAP embedded: {len(emb.get('audio', {}))}/{len(wavs)} wavs", file=sys.stderr)
    return emb


# ---------------------------------------------------------------- data loading

def load_rows():
    return [json.loads(l) for l in open(LEDGER)]


def pack_rows(rows):
    # value must be a real verdict: unrated cards (e.g. the pack-002 reprises the owner
    # skipped) come through as "" and would otherwise silently count as kills.
    return [r for r in rows if r["kind"] == "keep" and r.get("value") in ("keep", "kill")]


def wav_path_for(row):
    return os.path.join(BEATS, row["round"], row["file"])


def build_signals(prs, emb):
    """Per-beat signal vectors for the pack rows. Returns {signal: [v per row] | None}."""
    audio = emb.get("audio", {}) if emb else {}
    text = emb.get("text", {}) if emb else {}
    pos_vecs = [text[t] for t in CLAP_POS if t in text]
    neg_vecs = [text[t] for t in CLAP_NEG if t in text]

    sig = {s: [] for s in SIGNALS}
    keeps_emb = [audio.get(wav_path_for(r)) for r in prs if r["value"] == "keep"]
    keeps_emb = [e for e in keeps_emb if e]

    for r in prs:
        ax = (r.get("features") or {}).get("axes") or {}
        for a in ("PQ", "CE", "CU", "PC"):
            sig[a].append(ax.get(a))
        sig["rmsDb"].append((r.get("features") or {}).get("rmsDb"))
        e = audio.get(wav_path_for(r))
        if e and pos_vecs and neg_vecs:
            cp = sum(_cos(e, v) for v in pos_vecs) / len(pos_vecs)
            cn = sum(_cos(e, v) for v in neg_vecs) / len(neg_vecs)
            sig["clapPos"].append(cp)
            sig["clapContrast"].append(cp - cn)
        else:
            sig["clapPos"].append(None)
            sig["clapContrast"].append(None)
        if e and keeps_emb:
            others = [k for k in keeps_emb if k is not e] if r["value"] == "keep" else keeps_emb
            if others:
                cen = [sum(v[i] for v in others) / len(others) for i in range(len(others[0]))]
                sig["clapKeptCentroid"].append(_cos(e, cen))
            else:
                sig["clapKeptCentroid"].append(None)
        else:
            sig["clapKeptCentroid"].append(None)

    return {s: (vs if all(v is not None for v in vs) else None) for s, vs in sig.items()}


# ------------------------------------------------ reward re-benchmark (program §4.4)
#
# Scores the legacy reward artifacts + the current taste ranker against the two
# OWNER-rated validity sets — the 2026-07 training program's "highest-information
# hour" (docs/plans/MOSHI_TRAINING_PROGRAM_2026-07.md §4.4).
#
# PRE-REGISTERED (stated before computing, per the program's gate discipline):
#   • primary metric = Spearman ρ vs the raw owner ratings, one-sided permutation p
#     with the direction HIGHER-on-better for every scorer (rmsDb included, as the
#     dumb-baseline; a negative ρ simply fails its one-sided test);
#   • AUC is OMITTED — neither RATINGS.csv carries a native keep/kill column, so
#     any binarization would be post-hoc;
#   • the two sets use different scales (1–6 vs 1–7) and are NEVER pooled.

VALIDITY_SETS = [
    ("validity-24", os.path.expanduser("~/mosh-validity")),
    ("probe-38", os.path.expanduser("~/mosh-reward-probe")),
]
REWARD_DOC = os.path.join(REPO, "docs", "bench", "REWARD_BENCH_2026-07.md")
REWARD_JSON = os.path.join(BEATS, "labels", "reward-bench-2026-07.json")
VALIDITY_STORE = os.path.join(BEATS, "labels", "embeddings", "validity-store.jsonl")
SIDECAR_PY = os.path.join(REPO, "service", "sa3", "judge_sidecar.py")
EMBED_STORE_PY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "embed_store.py")
VALIDITY_SIGNALS = ["composite", "PQ", "CE", "CU", "PC",
                    "clapPos", "clapContrast", "clapKeepCentroid", "ranker", "rmsDb"]
VALIDITY_NOTES = {
    "composite": "GRPO reward as implemented (clean × pq_dsp; pull→pq fallback active)",
    "PQ": "Audiobox production quality", "CE": "Audiobox enjoyment",
    "CU": "Audiobox usefulness", "PC": "Audiobox complexity",
    "clapPos": "CLAP cos to trap-beat anchors",
    "clapContrast": "CLAP pos−neg anchor contrast",
    "clapKeepCentroid": "CLAP cos to the owner's kept-pack centroid",
    "ranker": "taste_ranker.score_candidate (production path; symbolic imputed)",
    "rmsDb": "raw mix loudness (baseline)",
}


def qr_scores_main(req_path: str, out_path: str) -> int:
    """Judges-venv sub-mode: composite reward + rmsDb per clip. The composite is the
    frozen GRPO Reward reproduced faithfully — loudness_normalize verbatim from the
    frozen branch (6c0c0f2b service/teardown/oracle/score.py), floor = service/
    quality_readout.analyze_array (the pq the loop actually ran on), aggregation
    Reward.composite = clean × (0.5·pq + 0.5·pull) with pull→pq (the MuQ probe
    checkpoint is unrecoverable) ⇒ clean × pq/10."""
    import numpy as np
    import soundfile as sf
    sys.path.insert(0, os.path.join(REPO, "service"))
    import quality_readout as qr

    res = {}
    for w in json.load(open(req_path))["wavs"]:
        x, sr = sf.read(w, always_2d=True, dtype="float64")
        mono = x.mean(axis=1)
        rms = float(np.sqrt(np.mean(mono ** 2))) if mono.size else 0.0
        rms_db = 20.0 * math.log10(max(rms, 1e-12))
        y = mono.astype(np.float32)
        if rms >= 1e-9:                       # loudness_normalize(y, sr, -20.0), verbatim
            y = y * ((10.0 ** (-20.0 / 20.0)) / rms)
            peak = float(np.max(np.abs(y)))
            if peak > 1.0:
                y = y / peak
        r = qr.analyze_array(y.astype("float64"), sr)
        pq01 = max(0.0, min(1.0, float(r.get("pq", 0.0)) / 10.0))
        clean = 0.0 if r.get("flags") else 1.0
        res[w] = {"composite": round(clean * pq01, 4), "clean": clean,
                  "pqDsp": round(float(r.get("pq", 0.0)), 3),
                  "flags": [str(f) for f in (r.get("flags") or [])],
                  "rmsDb": round(rms_db, 2)}
    json.dump(res, open(out_path, "w"), indent=1)
    return 0


def load_validity_rows(root: str) -> list:
    """[(index, rating, wav_path)] from RATINGS.csv + clips/."""
    import csv
    rows = []
    with open(os.path.join(root, "RATINGS.csv")) as f:
        for r in csv.DictReader(f):
            wav = os.path.join(root, "clips", f"{r['index']}.wav")
            if r.get("rating", "").strip() and os.path.isfile(wav):
                rows.append((r["index"], float(r["rating"]), wav))
    return rows


def audiobox_axes(paths: list) -> dict:
    """{path: {PQ,CE,CU,PC}} via one judge-sidecar batch (communicate+timeout — the
    sidecar exits on stdin EOF, so this can't hang past the deadline)."""
    if not os.path.isfile(JUDGES_PY):
        print("  (Audiobox skipped: judges venv absent)", file=sys.stderr)
        return {}
    proc = subprocess.run([JUDGES_PY, SIDECAR_PY],
                          input=json.dumps({"paths": paths}) + "\n",
                          capture_output=True, text=True, timeout=1800, cwd=REPO)
    payloads = [json.loads(l[len("@@MOSH@@"):]) for l in proc.stdout.splitlines()
                if l.startswith("@@MOSH@@")]
    for p in payloads:
        if p and "ready" not in p and "error" not in p:
            print(f"  Audiobox axes: {len(p)}/{len(paths)} clips", file=sys.stderr)
            return p
    print(f"  (Audiobox failed: {proc.stderr.strip()[-300:]})", file=sys.stderr)
    return {}


def validity_bench() -> int:
    sets = {name: load_validity_rows(root) for name, root in VALIDITY_SETS
            if os.path.isdir(root)}
    sets = {k: v for k, v in sets.items() if v}
    if not sets:
        print("no validity sets found", file=sys.stderr)
        return 1
    all_wavs = sorted({w for rows in sets.values() for _, _, w in rows})
    print(f"validity clips: {sum(len(v) for v in sets.values())} "
          f"({', '.join(f'{k}:{len(v)}' for k, v in sets.items())})", file=sys.stderr)

    # 1) composite + rmsDb under the judges venv (numpy+soundfile+quality_readout)
    with tempfile.TemporaryDirectory() as td:
        req, out = os.path.join(td, "req.json"), os.path.join(td, "qr.json")
        json.dump({"wavs": all_wavs}, open(req, "w"))
        proc = subprocess.run([JUDGES_PY, os.path.abspath(__file__),
                               "--qr-scores", req, out],
                              capture_output=True, text=True, timeout=1200)
        if proc.returncode != 0:
            print(f"  (composite scoring failed: {proc.stderr[-400:]})", file=sys.stderr)
            qr_scores = {}
        else:
            qr_scores = json.load(open(out))
    print(f"  composite scored: {len(qr_scores)}/{len(all_wavs)}", file=sys.stderr)

    # 2) Audiobox axes (one sidecar batch)
    axes = audiobox_axes(all_wavs)

    # 3) CLAP: validity clips + the owner's kept-pack beats in ONE embed call so the
    #    audio/text spaces are identical. Embeddings are PINNED in a bench-local cache
    #    (embed-store philosophy: embed once, persist) — CLAP inference on the GPU
    #    jitters ρ by ~±0.03 run-to-run otherwise; with the cache, re-runs are
    #    byte-identical. The cache key is the input set; a new keep changes it.
    keep_wavs = sorted({wav_path_for(r) for r in pack_rows(load_rows())
                        if r["value"] == "keep" and os.path.isfile(wav_path_for(r))})
    cache_path = os.path.join(os.path.dirname(VALIDITY_STORE), "validity-clap-cache.json")
    cache_key = ",".join(all_wavs + keep_wavs + CLAP_POS + CLAP_NEG)
    emb = {}
    if os.path.isfile(cache_path):
        cached = json.load(open(cache_path))
        if cached.get("key") == cache_key:
            emb = cached["emb"]
            print("  CLAP: cache hit (pinned embeddings)", file=sys.stderr)
    if not emb:
        emb = clap_embeddings(all_wavs + keep_wavs, CLAP_POS + CLAP_NEG)
        if emb:
            json.dump({"key": cache_key, "emb": emb}, open(cache_path, "w"))
    audio, text = emb.get("audio", {}), emb.get("text", {})
    pos_vecs = [text[t] for t in CLAP_POS if t in text]
    neg_vecs = [text[t] for t in CLAP_NEG if t in text]
    keep_vecs = [audio[w] for w in keep_wavs if w in audio]
    keep_cen = ([sum(v[i] for v in keep_vecs) / len(keep_vecs)
                 for i in range(len(keep_vecs[0]))] if keep_vecs else None)

    # 4) MuQ embeddings (ranker view) → a bench-local store; the shared store is
    #    never written (validity clips are not pack candidates)
    env = dict(os.environ, MOSH_EMBED_STORE=VALIDITY_STORE)
    proc = subprocess.run([JUDGES_PY, EMBED_STORE_PY, "--wavs"] + all_wavs,
                          env=env, capture_output=True, text=True, timeout=2400)
    if proc.returncode != 0:
        print(f"  (embed_store failed: {proc.stderr[-300:]})", file=sys.stderr)
    vstore = {}
    if os.path.isfile(VALIDITY_STORE):
        for line in open(VALIDITY_STORE):
            if line.strip():
                r = json.loads(line)
                vstore[r["path"]] = r

    # 5) ranker (production score_candidate; model frozen on disk)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import taste_ranker as tr
    model = tr.load_model()
    view = model.get("view", "muq")

    def signal_values(rows):
        sig = {s: [] for s in VALIDITY_SIGNALS}
        for _, _, w in rows:
            q = qr_scores.get(w) or {}
            sig["composite"].append(q.get("composite"))
            sig["rmsDb"].append(q.get("rmsDb"))
            ax = axes.get(w) or {}
            for a in ("PQ", "CE", "CU", "PC"):
                sig[a].append(ax.get(a))
            e = audio.get(w)
            if e and pos_vecs and neg_vecs:
                cp = sum(_cos(e, v) for v in pos_vecs) / len(pos_vecs)
                cn = sum(_cos(e, v) for v in neg_vecs) / len(neg_vecs)
                sig["clapPos"].append(cp)
                sig["clapContrast"].append(cp - cn)
            else:
                sig["clapPos"].append(None)
                sig["clapContrast"].append(None)
            sig["clapKeepCentroid"].append(_cos(e, keep_cen) if e and keep_cen else None)
            row = vstore.get(w) or {}
            vec = row.get(view) or row.get("clap")
            if model and vec and ax:
                sig["ranker"].append(tr.score_candidate(
                    model, vec, ax, {"rmsDb": q.get("rmsDb")}))
            else:
                sig["ranker"].append(None)
        return sig

    results, raw = {}, {}
    for name, rows in sets.items():
        ratings = [r for _, r, _ in rows]
        sig = signal_values(rows)
        per = {}
        for s in VALIDITY_SIGNALS:
            pairs = [(v, y) for v, y in zip(sig[s], ratings) if v is not None]
            if len(pairs) >= 8:
                rho, p = spearman_perm_p([a for a, _ in pairs], [b for _, b in pairs])
                per[s] = {"n": len(pairs), "rho": round(rho, 4), "p": round(p, 4)}
            else:
                per[s] = {"n": len(pairs), "rho": None, "p": None}
        results[name] = per
        raw[name] = [{"index": i, "rating": r, "wav": os.path.basename(w),
                      **{s: sig[s][k] for s in VALIDITY_SIGNALS}}
                     for k, (i, r, w) in enumerate(rows)]

    # ------------------------------------------------------------ write outputs
    lines = []
    w = lines.append
    w("# Reward re-benchmark (2026-07) — every legacy scorer vs the owner's ears")
    w("")
    w("*Generated by `scripts/verify-hardware/bench_evaluators.py --validity` — "
      "regenerate, don't hand-edit. Program: "
      "`docs/plans/MOSHI_TRAINING_PROGRAM_2026-07.md` §4.4.*")
    w("")
    w("## Pre-registration (stated before results)")
    w("")
    w("- **Primary metric: Spearman ρ** vs the raw owner ratings; one-sided seeded "
      "permutation p (20k), direction **higher-on-better for every scorer** "
      "(rmsDb included as the dumb baseline — a negative ρ fails its one-sided test).")
    w("- **AUC omitted**: neither RATINGS.csv carries a native keep/kill column; any "
      "binarization would be post-hoc.")
    w("- Sets use different scales (1–6 vs 1–7) and are **never pooled**.")
    w("- **Standing bar (program §3):** no model is used as a scorer again without "
      "beating the current ranker on these sets.")
    w("")
    w("## Sets")
    w("")
    w("| set | n rated | scale | what it is |")
    w("|---|---|---|---|")
    w(f"| validity-24 | {len(sets.get('validity-24', []))} | 1–6 | "
      "`~/mosh-validity` — the audit-era validity pack, owner-rated 2026-07-02 |")
    w(f"| probe-38 | {len(sets.get('probe-38', []))} | 1–7 | "
      "`~/mosh-reward-probe` — the reward-probe clips, owner-rated 2026-06-30 |")
    w("")
    for name in results:
        w(f"## Scoreboard — {name}")
        w("")
        w("| scorer | n | Spearman ρ | perm p (1-sided) | note |")
        w("|---|---|---|---|---|")
        for s in VALIDITY_SIGNALS:
            r = results[name][s]
            if r["rho"] is None:
                w(f"| {s} | {r['n']} | — | — | {VALIDITY_NOTES[s]} (unavailable) |")
            else:
                w(f"| {s} | {r['n']} | {r['rho']:.3f} | {r['p']:.3f} | "
                  f"{VALIDITY_NOTES[s]} |")
        w("")
    w("## Not computable / by record")
    w("")
    w("- **LoRA-MuQ pull probe — BY RECORD ONLY.** The probe checkpoint lived only on "
      "the frozen GRPO branch and was never committed; unrecoverable. Recorded numbers "
      "stand: iso-timing ρ 0.897, **validity ρ −0.129** (anti-correlated) — "
      "`docs/plans/moshi-training-audit-2026-07.md`. In the composite above its `pull` "
      "term therefore falls back to pq, exactly as `Reward.composite` implements.")
    w("- **CLAP → owner-corpus centroid — could-not-compute.** `~/mosh-taste/own` is "
      "still empty (no bounces dropped yet); the kept-pack centroid row above is the "
      "available owner-taste anchor. The owner ask stands.")
    w("")
    w("## Provenance")
    w("")
    w("- composite: `Reward.composite`/`score_audio` reproduced verbatim from the frozen "
      "branch (commit `6c0c0f2b`, `service/teardown/flywheel/reward.py` + "
      "`oracle/score.py::loudness_normalize`); floor pq = `service/quality_readout` "
      "(the DSP pq the loop actually ran); clean = no-flags.")
    w("- Audiobox axes: `service/sa3/judge_sidecar.py` under `~/AI/judges_venv` "
      "(one batch, deterministic).")
    w("- CLAP: `clap_score.py` (judges venv), same audio/text space for anchors, "
      "clips, and the kept-pack centroid.")
    w("- ranker: `taste_ranker.score_candidate` with the frozen on-disk model "
      f"(view={view}, mode={model.get('mode')}, n={model.get('n')}); axes real, "
      "rmsDb measured, remaining symbolic features at their production defaults; "
      "corpus features = keep-centroid only (own/ref corpus empty) — identical to "
      "how shipped packs are scored.")
    w("- MuQ embeddings for the ranker go to a bench-local store "
      "(`validity-store.jsonl`); the shared pack store is never written.")
    w("- Determinism: composite/Audiobox/ranker/rmsDb are bit-identical across runs; "
      "CLAP embeddings are PINNED in `validity-clap-cache.json` (before pinning, GPU "
      "inference jittered the CLAP ρ by ~±0.03 run-to-run — signs and significance "
      "categories unchanged). With the cache, re-runs reproduce byte-identically.")
    w("")
    w("## Verdict")
    w("")
    ranked = {}
    for name, per in results.items():
        avail = [(s, per[s]["rho"]) for s in VALIDITY_SIGNALS if per[s]["rho"] is not None]
        avail.sort(key=lambda kv: -kv[1])
        ranked[name] = avail
        top = ", ".join(f"{s} {v:+.3f}" for s, v in avail[:3])
        rk = per.get("ranker", {}).get("rho")
        beat = [s for s, v in avail if rk is not None and v > rk and s != "ranker"]
        w(f"- **{name}**: top signals {top}. Scorers above the ranker "
          f"(ρ {rk if rk is not None else '—'}): {', '.join(beat) if beat else 'none'}.")
    w("")
    w("*Interpretation discipline: at n=24/38 these are ranking reads, not adoption "
      "decisions — the adoption bar for any scorer remains beating the ranker on BOTH "
      "sets plus the pack-side prequential ≥0.65 (RANKER_PROMOTION.md). A composite "
      "ρ near 0 CONFIRMS the audit's retirement verdict; it is not retested later.*")
    os.makedirs(os.path.dirname(REWARD_DOC), exist_ok=True)
    open(REWARD_DOC, "w").write("\n".join(lines) + "\n")
    json.dump({"results": results, "raw": raw,
               "model": {"view": view, "mode": model.get("mode"), "n": model.get("n")}},
              open(REWARD_JSON, "w"), indent=1)
    print(f"reward bench → {REWARD_DOC}\njson → {REWARD_JSON}")
    return 0


# ---------------------------------------------------------------- self-check

def selfcheck():
    """Pin the permutation machinery to known exact values at 7-vs-7."""
    relabels, exact = exact_relabelings(14, 7)
    assert exact and len(relabels) == 3432, len(relabels)
    values = list(range(14))            # unique values, ranks 1..14
    ranks = _ranks(values)
    # perfect separation: top 7 are positives
    p_perfect = sum(1 for c in relabels
                    if auc_from_ranks(ranks, list(c)) >= 1.0 - 1e-12) / 3432
    assert abs(p_perfect - 1 / 3432) < 1e-12, p_perfect
    # critical value at one-sided alpha=0.05: smallest AUC with p <= 0.05
    aucs = sorted(auc_from_ranks(ranks, list(c)) for c in relabels)
    crit = None
    for a in sorted(set(aucs)):
        p = sum(1 for x in aucs if x >= a - 1e-12) / 3432
        if p <= 0.05:
            crit = (a, p)
            break
    assert crit and abs(crit[0] - 38 / 49) < 1e-9, crit   # 0.7755…
    assert abs(crit[1] - 0.049) < 0.002, crit
    print(f"selfcheck OK: |relabelings|=3432, perfect-sep p={p_perfect:.6f}, "
          f"critical AUC={crit[0]:.4f} (p={crit[1]:.4f})")


# ---------------------------------------------------------------- report

def fmt_row(name, auc, p, p_corr, ci, verd, note=""):
    return (f"| {name} | {auc:.3f} | {p:.3f} | {p_corr:.3f} | "
            f"[{ci[0]:.2f}, {ci[1]:.2f}] | {verd} | {note} |")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-clap", action="store_true")
    ap.add_argument("--selfcheck", action="store_true")
    ap.add_argument("--validity", action="store_true",
                    help="reward re-benchmark vs the owner-rated validity sets (§4.4)")
    ap.add_argument("--qr-scores", nargs=2, metavar=("REQ", "OUT"),
                    help="(internal) judges-venv sub-mode: composite+rmsDb per clip")
    args = ap.parse_args(argv)
    if args.selfcheck:
        selfcheck()
        return 0
    if args.qr_scores:
        return qr_scores_main(args.qr_scores[0], args.qr_scores[1])
    if args.validity:
        return validity_bench()

    rows = load_rows()
    prs = pack_rows(rows)
    if not prs:
        print("no pack keep/kill rows in the ledger", file=sys.stderr)
        return 1
    n_pos = sum(1 for r in prs if r["value"] == "keep")
    n_neg = len(prs) - n_pos
    packs = sorted({r["round"] for r in prs})

    # CLAP embeddings for pack + old-round wavs (one subprocess, one model load)
    old_wavs = []
    for d in list(STAR_DIRS.values()) + [x for pair in PREF_DIRS.values() for x in pair]:
        full = os.path.join(BEATS, d)
        if os.path.isdir(full):
            old_wavs += [os.path.join(full, f) for f in sorted(os.listdir(full))
                         if f.endswith(".wav") and " 2" not in f]
    texts = CLAP_POS + CLAP_NEG + list(CLAP_MOODS.values())
    emb = {} if args.no_clap else clap_embeddings(
        sorted({wav_path_for(r) for r in prs} | set(old_wavs)), texts)

    signals = build_signals(prs, emb)
    pos_idx = [i for i, r in enumerate(prs) if r["value"] == "keep"]
    report, exact = permutation_report(
        {s: v for s, v in signals.items() if v is not None}, pos_idx)

    # ---- defect-chip AUCs (which signal predicts each complaint?)
    chip_vocab = sorted({c for r in prs for c in (r.get("chips") or []) if c})
    chip_reports = {}
    for chip in chip_vocab:
        cidx = [i for i, r in enumerate(prs) if chip in (r.get("chips") or [])]
        if 2 <= len(cidx) <= len(prs) - 2:
            # chips flag DEFECTS: pre-registered direction is LOWER signal on flagged
            flipped = {s: [-v for v in vs] for s, vs in signals.items() if vs is not None}
            chip_reports[chip], _ = permutation_report(flipped, cidx)

    # ---- transfer checks (secondary; never pooled into the keep/kill AUC)
    backfill = json.load(open(AXES_BACKFILL)) if os.path.isfile(AXES_BACKFILL) else {}
    audio = emb.get("audio", {}) if emb else {}

    def old_signal(relpath, s):
        if s in ("PQ", "CE", "CU", "PC"):
            return (backfill.get(relpath) or {}).get(s)
        e = audio.get(os.path.join(BEATS, relpath))
        if not e:
            return None
        text = emb.get("text", {})
        pos = [text[t] for t in CLAP_POS if t in text]
        neg = [text[t] for t in CLAP_NEG if t in text]
        if not (pos and neg):
            return None
        cp = sum(_cos(e, v) for v in pos) / len(pos)
        if s == "clapPos":
            return cp
        if s == "clapContrast":
            return cp - sum(_cos(e, v) for v in neg) / len(neg)
        return None

    transfer_sigs = ["PQ", "CE", "CU", "PC", "clapPos", "clapContrast"]
    stars = [(f"{STAR_DIRS[r['round']]}/{r['file']}", int(r["value"]))
             for r in rows if r["kind"] == "star" and r["round"] in STAR_DIRS]
    star_rows = []
    for s in transfer_sigs:
        pts = [(old_signal(rel, s), v) for rel, v in stars]
        pts = [(a, b) for a, b in pts if a is not None]
        if len(pts) >= 8:
            rho, p = spearman_perm_p([a for a, _ in pts], [b for _, b in pts])
            star_rows.append((s, len(pts), rho, p))

    pref_rows_out = []
    for rnd, (new_dir, old_dir) in PREF_DIRS.items():
        pairs = [(r["file"], r["value"]) for r in rows
                 if r["kind"] == "pref" and r["round"] == rnd and r["value"] != "same"]
        for s in transfer_sigs:
            conc = tot = 0
            for f, val in pairs:
                a, b = old_signal(f"{new_dir}/{f}", s), old_signal(f"{old_dir}/{f}", s)
                if a is None or b is None or a == b:
                    continue
                tot += 1
                new_preferred = val.lower().startswith(rnd[:2])  # "r3"/"r4" = new arm
                if (a > b) == new_preferred:
                    conc += 1
            if tot:
                pref_rows_out.append((rnd, s, conc, tot, binom_tail_one_sided(conc, tot)))

    # ---- mood-agreement probe (CLAP as a mood judge — validity data, not a gate)
    mood_rows = []
    text = emb.get("text", {}) if emb else {}
    if all(t in text for t in CLAP_MOODS.values()):
        for r in prs:
            e = audio.get(wav_path_for(r))
            if not e:
                continue
            happy = _cos(e, text[CLAP_MOODS["happy"]])
            dark = _cos(e, text[CLAP_MOODS["dark"]])
            req = ((r.get("features") or {}).get("request") or {}).get("mood", "?")
            mood_rows.append((r["file"], req, happy, dark))

    # ---- per-sample keep-rate (seeds palette curation; decides nothing at n=14)
    sample_stats = {}
    for r in prs:
        for role, h in ((r.get("features") or {}).get("samples") or {}).items():
            st = sample_stats.setdefault(h, {"role": role, "keep": 0, "n": 0})
            st["n"] += 1
            st["keep"] += 1 if r["value"] == "keep" else 0
    multi = {h: st for h, st in sample_stats.items() if st["n"] >= 2}

    # ------------------------------------------------------------ write outputs
    os.makedirs(os.path.dirname(DOC_OUT), exist_ok=True)
    lines = []
    w = lines.append
    w("# Evaluator bench — running scoreboard (R1)")
    w("")
    w(f"*Generated by `scripts/verify-hardware/bench_evaluators.py` from "
      f"`~/mosh-beats/labels/labels.jsonl` — regenerate, don't hand-edit. "
      f"Packs included: {', '.join(packs)} (n={len(prs)}: {n_pos} keep / {n_neg} kill).*")
    w("")
    crit, crit_p = critical_auc(len(prs), n_pos)
    w(f"**This is a cumulative protocol, not a verdict.** At the current n={len(prs)} "
      f"({n_pos}/{n_neg}) only AUC ≥ {crit} clears one-sided α=0.05 (exact permutation, "
      f"p={crit_p}). Verdicts below are limited to "
      "`prioritize` / `deprioritize` / `insufficient`. The adoption decision "
      "(AUC ≥ 0.65 held-out, per MUSIC_EVAL_RESEARCH.md) fires only with ≥2 rated packs "
      "and per-pack replication (fixed signals: per-pack AUCs in the note column must "
      "agree in direction). Power: at a true AUC of 0.70, ~3 packs (~44 labels) give "
      "80% power at one-sided 0.05; at a true 0.65, ~6–7 packs.")
    w("")
    w("**Pre-registered directions** (set before pack-002; future packs are one-sided "
      "confirmatory tests): every signal HIGHER on keeps; every signal LOWER on "
      "defect-chipped beats. Flipping a direction after seeing data is not allowed.")
    w("")
    w("## Keep/kill scoreboard")
    w("")
    w("| signal | AUC | exact p (1-sided) | max-T corr. p | HM 95% CI | verdict | note |")
    w("|---|---|---|---|---|---|---|")
    notes = {"PQ": "Audiobox production quality", "CE": "Audiobox enjoyment",
             "CU": "Audiobox usefulness", "PC": "Audiobox complexity",
             "clapPos": "CLAP cos to trap-beat anchors",
             "clapContrast": "CLAP pos−neg anchor contrast",
             "clapKeptCentroid": "CLAP cos to kept-set centroid (LOO)",
             "rmsDb": "raw mix loudness (baseline)"}
    # per-pack AUCs (signals are FIXED, not fitted, so per-pack splits are honest
    # replication checks — a signal that flips direction across packs is noise)
    per_pack = {}
    for pk in packs:
        idx = [i for i, r in enumerate(prs) if r["round"] == pk]
        ppos = [i for i in idx if prs[i]["value"] == "keep"]
        if not ppos or len(ppos) == len(idx):
            continue
        for s, vs in signals.items():
            if vs is None:
                continue
            sub = [vs[i] for i in idx]
            sub_pos = [j for j, i in enumerate(idx) if i in ppos]
            per_pack.setdefault(s, {})[pk] = auc_from_ranks(_ranks(sub), sub_pos)
    for s in SIGNALS:
        if s in report:
            auc, p, pc = report[s]
            ci = hanley_mcneil_ci(auc, n_pos, n_neg)
            pp = " · ".join(f"{pk[-3:]}:{v:.2f}" for pk, v in per_pack.get(s, {}).items())
            note = notes.get(s, "") + (f" — per-pack {pp}" if pp else "")
            w(fmt_row(s, auc, p, pc, ci, verdict(auc, p), note))
        else:
            w(f"| {s} | — | — | — | — | unavailable | {notes.get(s, '')} |")
    w("")
    if not exact:
        w("*(permutation sampled, not exact — n grew past the enumeration cap)*")

    if chip_reports:
        w("")
        w("## Defect-chip scoreboard (which signal predicts each complaint?)")
        w("")
        w("*Pre-registered hypothesis: population-aesthetics axes (esp. PQ) predict the "
          "`mix` chip better than keep/kill — his keeps include 'messy but I like it'. "
          "If that holds, these models are adopted as cleanliness FILTERS, not taste judges.*")
        w("")
        w("| chip | n flagged | best signal | AUC | exact p | max-T p |")
        w("|---|---|---|---|---|---|")
        for chip, rep in sorted(chip_reports.items()):
            nflag = sum(1 for r in prs if chip in (r.get("chips") or []))
            best = max(rep.items(), key=lambda kv: kv[1][0])
            w(f"| {chip} | {nflag} | {best[0]} | {best[1][0]:.3f} | "
              f"{best[1][1]:.3f} | {best[1][2]:.3f} |")

    # ---- top-1 agreement (the forced 'open it in the DAW' pick — strongest label)
    top_tally: dict = {}
    for pk in packs:
        idx = [i for i, r in enumerate(prs) if r["round"] == pk]
        owner_top = next((prs[i]["file"] for i in idx if prs[i].get("topPick")), None)
        if not owner_top:
            continue
        for s, vs in signals.items():
            if vs is None:
                continue
            best_i = max(idx, key=lambda i: vs[i])
            t = top_tally.setdefault(s, [0, 0])
            t[1] += 1
            t[0] += 1 if prs[best_i]["file"] == owner_top else 0
    if top_tally:
        w("")
        w("## Top-pick agreement (running tally — does the signal's argmax match the "
          "owner's forced 'open it in the DAW' pick? no p-theater at n=packs)")
        w("")
        w("| signal | agreements |")
        w("|---|---|")
        for s in SIGNALS:
            if s in top_tally:
                w(f"| {s} | {top_tally[s][0]}/{top_tally[s][1]} |")

    w("")
    w("## Transfer checks (secondary — different task/pipeline, NEVER pooled)")
    w("")
    if star_rows:
        w("Star ratings, rounds r1+r2 pooled (caveat: pre-restart pipeline, owner "
          "recalibrated his scale between rounds; a hit here may just detect loudness):")
        w("")
        w("| signal | n | Spearman ρ | perm p (1-sided) |")
        w("|---|---|---|---|")
        for s, n, rho, p in star_rows:
            w(f"| {s} | {n} | {rho:.3f} | {p:.3f} |")
        w("")
    if pref_rows_out:
        w("A/B preference concordance (sanity check only — all r4 pairs preferred r4, so "
          "any 'later pipeline' detector scores high; zero weight toward adoption):")
        w("")
        w("| round | signal | concordant | binom p (1-sided) |")
        w("|---|---|---|---|")
        for rnd, s, conc, tot, p in pref_rows_out:
            w(f"| {rnd} | {s} | {conc}/{tot} | {p:.3f} |")
        w("")
    if mood_rows:
        w("## CLAP mood probe (validity data for mood tags — beat 12 was rated "
          "'happy, not emotional'; requested mood miscalibrated 2-for-2 this pack)")
        w("")
        w("| beat | requested | cos(happy) | cos(dark) | CLAP says |")
        w("|---|---|---|---|---|")
        for f, req, happy, dark in mood_rows:
            says = "happy" if happy > dark else "dark"
            w(f"| {f} | {req} | {happy:.3f} | {dark:.3f} | {says} |")
        w("")
    if multi:
        w("## Per-sample keep-rate (n≥2 only; seeds palette curation, decides nothing yet)")
        w("")
        w("| sample | role | keeps/n |")
        w("|---|---|---|")
        for h, st in sorted(multi.items(), key=lambda kv: (-kv[1]["n"], kv[0])):
            w(f"| {h} | {st['role']} | {st['keep']}/{st['n']} |")
        w("")

    open(DOC_OUT, "w").write("\n".join(lines) + "\n")
    json.dump({"packs": packs, "n": len(prs), "n_keep": n_pos,
               "keepkill": {s: {"auc": report[s][0], "p": report[s][1],
                                "p_maxT": report[s][2]} for s in report},
               "chips": {c: {s: {"auc": r[s][0], "p": r[s][1]} for s in r}
                         for c, r in chip_reports.items()},
               "stars": [{"signal": s, "n": n, "rho": rho, "p": p}
                         for s, n, rho, p in star_rows],
               "prefs": [{"round": rnd, "signal": s, "concordant": conc,
                          "total": tot, "p": p}
                         for rnd, s, conc, tot, p in pref_rows_out],
               "mood": [{"file": f, "requested": req, "happy": h, "dark": d}
                        for f, req, h, d in mood_rows]},
              open(JSON_OUT, "w"), indent=1)
    print(f"scoreboard → {DOC_OUT}\njson → {JSON_OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
