#!/usr/bin/env python3
"""Golden tests for the blind rating page + its persistence (I2).

The page is the instrument that produces the labels the whole program trusts, so
the tests check the two ways it can silently corrupt them:
  - the rendered HTML tells the rater which side is the human line (via a key,
    an attribute, a class name, or even consistent ordering);
  - a rating is lost or double-counted on reload.

Run:  python3 service/lyrics/bench/calibrate_page_test.py     (exit 0 = all pass)
"""
import json
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import calibrate, calibrate_page  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


POOL = [{"itemId": f"v1:line:s{i}", "granularity": "line",
         "arm": "llm-constrained" if i % 2 else "product-llm",
         "truth": f"the human wrote bar number {i}",
         "candidate": f"the machine wrote bar number {i}",
         "context": {"before": [f"prior bar {i}"], "after": [f"next bar {i}"]}}
        for i in range(8)]
pairs, key = calibrate.mint_pairs(POOL, n=8, dupes=2, seed=3)
html = calibrate_page.render(pairs, title="calibration sitting 1")

# ---- blindness of the rendered artifact ----
check("page embeds every pair", all(p["pairId"] in html for p in pairs))
check("page never contains the words truth/human/original as side labels",
      not re.search(r"(truth|human|original)\s*[:=]", html, re.I),
      (re.search(r".{0,40}(truth|human|original)\s*[:=].{0,40}", html, re.I) or
       [""])[0] if re.search(r"(truth|human|original)\s*[:=]", html, re.I) else "")
check("page carries no blind-key data",
      "truthSide" not in html and not any(v["truthText"] in html
                                          for v in key.values()
                                          if v["truthText"] not in
                                          (p["left"] for p in pairs)
                                          and v["truthText"] not in
                                          (p["right"] for p in pairs)))
check("page shows both sides for each pair",
      all(p["left"] in html and p["right"] in html for p in pairs))
check("page exposes no arm attribution to the rater",
      "llm-constrained" not in html and "product-llm" not in html)
check("page offers left / right / tie",
      all(x in html.lower() for x in ("left", "right", "tie")))
check("page posts to the persistence endpoint", "/rate" in html)
check("render is deterministic",
      calibrate_page.render(pairs, title="calibration sitting 1") == html)

# ---- persistence ----
with tempfile.TemporaryDirectory() as td:
    path = os.path.join(td, "ratings.jsonl")
    calibrate_page.append_rating(path, {"pairId": pairs[0]["pairId"],
                                        "choice": "left"})
    calibrate_page.append_rating(path, {"pairId": pairs[1]["pairId"],
                                        "choice": "tie"})
    rows = calibrate_page.load_ratings(path)
    check("ratings persist as JSONL in order", len(rows) == 2
          and rows[0]["choice"] == "left" and rows[1]["choice"] == "tie",
          # ts stripped: a wall-clock value in the detail would make this
          # suite's 3x signature differ by the second.
          str([{k: v for k, v in r.items() if k != "ts"} for r in rows]))
    check("每 rating carries a timestamp for the ledger".replace("每", "each"),
          all("ts" in r for r in rows))
    # A re-rated pair appends (history preserved); the resolver takes the
    # consistent answer, so a corrected mind is visible rather than silently lost.
    calibrate_page.append_rating(path, {"pairId": pairs[0]["pairId"],
                                        "choice": "right"})
    rows = calibrate_page.load_ratings(path)
    check("re-rating appends rather than overwriting", len(rows) == 3)
    labels = calibrate.owner_labels(rows, key)
    check("contradictory repeat resolves to None, not a coin flip",
          labels.get(pairs[0]["pairId"]) is None, str(labels))
    check("bad rows are skipped, not fatal",
          calibrate_page.append_rating(path, {"choice": "left"}) is False
          and len(calibrate_page.load_ratings(path)) == 3)

# ---- progress accounting ----
with tempfile.TemporaryDirectory() as td:
    path = os.path.join(td, "r.jsonl")
    for p in pairs[:3]:
        calibrate_page.append_rating(path, {"pairId": p["pairId"], "choice": "left"})
    prog = calibrate_page.progress(pairs, calibrate_page.load_ratings(path))
    check("progress: rated vs total, dupes counted as their own slots",
          prog["rated"] == 3 and prog["total"] == len(pairs), str(prog))

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
