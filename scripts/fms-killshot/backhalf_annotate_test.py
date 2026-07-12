#!/usr/bin/env python3
"""Golden tests for the annotator's pure data builder (annotator round).

build_annotate_data turns evidence + skeleton into the page's embedded DATA: per-phrase
spans, the F seed marks (what the owner nudges), and the C/E reference marks. Pinning it
keeps the served page honest without driving a browser in CI.

Run:  python3 scripts/fms-killshot/backhalf_annotate_test.py   (exit 0 = pass)
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "service"))

import backhalf_annotate as ann  # noqa: E402
import backhalf_regrid as rg     # noqa: E402
from lyrics import flowspec      # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


HOP = 0.01


def env_from(spec):
    env = []
    for dur, lvl in spec:
        env += [lvl] * int(round(dur / HOP))
    return env


# a 2-phrase take: voiced 0.3-0.9 (loud + soft syllable), rest, voiced 2.5-2.9 (two syllables)
ENV = env_from([(0.30, 0.001), (0.25, 0.55), (0.05, 0.08), (0.25, 0.30),
                (1.60, 0.001), (0.18, 0.50), (0.04, 0.08), (0.18, 0.45), (0.30, 0.001)])
EVID = {"takeS": round(len(ENV) * HOP, 3), "hopS": HOP, "env": ENV,
        "notes": [], "f0": [],
        "words": [{"word": "flame", "start": 0.31, "end": 0.55, "conf": 0.9, "syl": 1},
                  {"word": "balls", "start": 2.51, "end": 2.70, "conf": 0.85, "syl": 1}]}


def LS(bar, slots):
    return {"v": 1, "bar": bar, "bpm": 138.0, "timeSig": [4, 4], "grid": "1/16", "slots": slots}


def SLOT(a, b, vel, pitch):
    return {"start": a, "end": b, "velocity": float(vel), "kind": "gap",
            "segments": [{"start": a, "end": b, "pitch": pitch}]}


SKEL = {
    "lineScores": [
        LS(0, [SLOT(0.30, 0.60, 90, 57), SLOT(0.60, 0.90, 40, 57)]),
        LS(1, [SLOT(2.50, 2.70, 80, 60), SLOT(2.70, 2.90, 75, 62)]),
    ],
    "lines": [], "lineHeard": [],
}

data = ann.build_annotate_data(EVID, SKEL)

# ── 1. structure ──────────────────────────────────────────────────────────────────────
check("one row per phrase", len(data["phrases"]) == 2, str(len(data["phrases"])))
check("carries the take length + hop + envelope",
      data["takeS"] == EVID["takeS"] and data["hopS"] == HOP and data["env"] == ENV)
check("audio points at the take relative to annotate/",
      data["audio"] == "../back-half/source-backhalf-48k.wav")

p0 = data["phrases"][0]
check("span comes from the rest grouping", p0["startS"] < 0.6 and p0["endS"] >= 0.85,
      f"{p0['startS']}-{p0['endS']}")
check("pad extends but clamps to the take",
      p0["padStart"] >= 0.0 and p0["padStart"] < p0["startS"]
      and data["phrases"][-1]["padEnd"] <= data["takeS"])

# ── 2. seed marks are detector F within the phrase span (what the owner nudges) ────────
phrases = flowspec.group_by_rest(SKEL["lineScores"], gap_s=ann.GAP_S, min_syllables=ann.MIN_SYL)
cands = rg._candidate_slots(EVID, SKEL)
for i, ph in enumerate(phrases):
    a, b = float(ph["start"]), float(ph["end"])
    exp_f = sorted(round(float(s["start"]), 4) for s in cands["F"] if a <= float(s["start"]) < b)
    check(f"phrase {i} seedF == detector F onsets in span", data["phrases"][i]["seedF"] == exp_f,
          f"{data['phrases'][i]['seedF']} vs {exp_f}")
check("reference rows carry C and E", "refC" in p0 and "refE" in p0)
check("every seed mark lies inside its phrase span",
      all(p["startS"] <= t < p["endS"] for p in data["phrases"] for t in p["seedF"]))

# ── 2b. heard ASR words ride along for the strike UI (word@start keys) ─────────────────
check("page data carries the heard words with keys",
      len(data["words"]) == 2
      and data["words"][0]["word"] == "flame"
      and data["words"][0]["key"] == "flame@0.31"
      and data["words"][1]["key"] == "balls@2.51",
      str(data.get("words")))

# ── 2c. page JS stops scheduled clicks on stop (owner: clicks ran on after Space) ──────
check("page tracks scheduled click oscillators", "clickNodes.push(o)" in ann._PAGE)
check("stop() kills the scheduled clicks",
      "clickNodes.forEach(o=>{ try{o.stop();}catch(e){} }); clickNodes=[];" in ann._PAGE)

# ── 3. determinism ─────────────────────────────────────────────────────────────────────
digs = {hashlib.sha256(json.dumps(ann.build_annotate_data(EVID, SKEL), sort_keys=True).encode()).hexdigest()
        for _ in range(3)}
check("build_annotate_data is deterministic (3x)", len(digs) == 1)

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
