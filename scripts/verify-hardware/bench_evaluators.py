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
    return [r for r in rows if r["kind"] == "keep"]


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
    args = ap.parse_args(argv)
    if args.selfcheck:
        selfcheck()
        return 0

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
    w("**This is a cumulative protocol, not a verdict.** At n=14 (7/7) only AUC ≥ 0.776 "
      "clears one-sided α=0.05 (exact permutation over C(14,7)=3,432 relabelings); an "
      "evaluator sitting exactly at the pre-registered adoption bar (AUC 0.65) is "
      "indistinguishable from a coin flip here (p≈0.19). Verdicts below are limited to "
      "`prioritize` / `deprioritize` / `insufficient`. The adoption decision "
      "(AUC ≥ 0.65 held-out, per MUSIC_EVAL_RESEARCH.md) fires only under "
      "leave-one-pack-out once ≥2 rated packs exist. Power: at a true AUC of 0.70, "
      "~3 packs (~44 labels) give 80% power at one-sided 0.05; at a true 0.65, ~6–7 packs.")
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
    for s in SIGNALS:
        if s in report:
            auc, p, pc = report[s]
            ci = hanley_mcneil_ci(auc, n_pos, n_neg)
            w(fmt_row(s, auc, p, pc, ci, verdict(auc, p), notes.get(s, "")))
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
