#!/usr/bin/env python3
"""Stage C rescore: rank LLM candidates against the phonetic template.

Reads <dir>/template.json + <dir>/candidates.json, scores every candidate with
distance.score_line, and writes:
  ranked.json      per line: top-5 / bottom-5 / random-5 (seeded), with components
  separation.json  the quantitative half of Stage C — top-5 vs random-5 score stats
                   (if these distributions overlap, rescoring added nothing)

Unpronounceable candidates (g2p failure) are excluded and counted, never guessed.

Usage:  rescore.py <template-dir>
"""
from __future__ import annotations

import json
import os
import random
import re
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "service"))

import panphon  # noqa: E402

import distance as D  # noqa: E402
import ipa_norm  # noqa: E402
from phonology import core as phon  # noqa: E402

SEED = 20260811
TOP_N = 5

_WORD_RE = re.compile(r"[A-Za-z']+")


def main() -> int:
    tdir = sys.argv[1]
    with open(os.path.join(tdir, "template.json"), encoding="utf-8") as f:
        template = json.load(f)
    with open(os.path.join(tdir, "candidates.json"), encoding="utf-8") as f:
        cands = json.load(f)
    tpl_by_index = {l["index"]: l for l in template["lines"]}

    ft = panphon.FeatureTable()
    fs = D.FeatureSpace(ft)
    pron = phon.Pronouncer()
    rng = random.Random(SEED)

    ranked = {"take": template["take"], "topic": cands.get("topic"), "lines": []}
    sep_rows = []
    for cl in cands["lines"]:
        tpl = tpl_by_index.get(cl["index"])
        if tpl is None or not cl["candidates"]:
            continue
        scored, oov = [], 0
        for text in cl["candidates"]:
            ipa = ipa_norm.arpa_line_to_ipa(
                [w for w in _WORD_RE.findall(text)], pron)
            if ipa is None:
                oov += 1
                continue
            s = D.score_line(tpl, ipa, fs)
            scored.append({"text": text, "total": round(s["total"], 4),
                           "seg": round(s["seg"], 4), "vowelseq": round(s["vowelseq"], 4),
                           "syl": round(s["syl"], 4),
                           "stress": round(s["stress"], 4) if s["stress"] is not None else None})
        if len(scored) < TOP_N * 3:
            continue
        scored.sort(key=lambda x: (x["total"], x["text"]))
        top = scored[:TOP_N]
        bottom = scored[-TOP_N:]
        middle = scored[TOP_N:-TOP_N]
        rand = rng.sample(middle, min(TOP_N, len(middle)))
        ranked["lines"].append({"index": cl["index"], "syllables": cl["syllables"],
                                "span": cl["span"], "n_candidates": len(scored),
                                "oov_excluded": oov, "top": top, "bottom": bottom,
                                "random": rand})
        top_m = statistics.mean(x["total"] for x in top)
        rand_m = statistics.mean(x["total"] for x in rand) if rand else None
        all_sd = statistics.pstdev([x["total"] for x in scored]) or 1e-9
        sep_rows.append({"index": cl["index"], "top_mean": round(top_m, 4),
                         "random_mean": round(rand_m, 4) if rand_m else None,
                         "bottom_mean": round(statistics.mean(x["total"] for x in bottom), 4),
                         "separation_sd": round((rand_m - top_m) / all_sd, 3) if rand_m else None})

    with open(os.path.join(tdir, "ranked.json"), "w", encoding="utf-8") as f:
        json.dump(ranked, f, ensure_ascii=False, indent=1)
    sep = {"take": template["take"], "rows": sep_rows,
           "mean_separation_sd": round(statistics.mean(
               r["separation_sd"] for r in sep_rows if r["separation_sd"] is not None), 3)
           if any(r["separation_sd"] is not None for r in sep_rows) else None}
    with open(os.path.join(tdir, "separation.json"), "w", encoding="utf-8") as f:
        json.dump(sep, f, indent=1)
    print(f"{template['take']}: {len(ranked['lines'])} lines ranked; "
          f"mean top-vs-random separation = {sep['mean_separation_sd']} sd")
    for r in sep_rows:
        print(f"  line {r['index']}: top {r['top_mean']} vs random {r['random_mean']} "
              f"vs bottom {r['bottom_mean']}  (sep {r['separation_sd']} sd)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
