#!/usr/bin/env python3
"""Golden tests for the FIT report — does a written line actually FIT the mumble's grid?

`author_score` places words onto the take's real notes with a mismatch policy (words>slots
squeeze onto the last note; syllables<slots hold the last word across the spare notes;
syllables>slots slur). The fake render then makes it audible. `fit.compute_fit` is the
NUMERIC readout of that same placement — a per-line coefficient + an overall workability
score — so "is this workable?" is a number, not an argument. It measures the SAME slots
`author_score` renders, so the number and the beeps agree.

Pure + deterministic. Run:  python3 service/soulx/fit_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from soulx import fit  # noqa: E402
from soulx import score as sx  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def SLOTS(n):
    return [{"start": i * 0.3, "end": i * 0.3 + 0.25, "velocity": 90.0, "kind": "gap",
             "segments": [{"start": i * 0.3, "end": i * 0.3 + 0.25, "pitch": 57}]} for i in range(n)]


def L(text, n, asserted=True):
    return {"text": text, "asserted": asserted, "score": {"v": 1, "slots": SLOTS(n)}}


# clean = 3 one-syllable words on 3 notes (1:1) · busy = 5 syllables on 3 notes (overflow)
# · roomy = 2 syllables on 4 notes (the take held more articulations)
CLEAN, BUSY, ROOMY = L("one two three", 3), L("one two three four five", 3), L("one two", 4)
rep = fit.compute_fit([CLEAN, BUSY, ROOMY])

# ── 1. clean 1:1 line is a perfect fit ────────────────────────────────────────────────
c = rep["lines"][0]
check("clean line: fit == 1.0", c["fit"] == 1.0, str(c))
check("clean line: verdict 'clean'", c["verdict"] == "clean")
check("clean line: no squeeze/cram/held", c["squeezed"] == 0 and c["crammed"] == 0 and c["held"] == 0)

# ── 2. too many words/syllables for the notes = squeezed (the audibly rushed case) ────
b = rep["lines"][1]
check("busy line: squeezed == words-slots (2)", b["squeezed"] == 2, str(b))
check("busy line: crammed == syllables-slots (2)", b["crammed"] == 2)
check("busy line: verdict 'squeezed'", b["verdict"] == "squeezed")
check("busy line: fit degraded into (0,1)", 0.0 <= b["fit"] < 1.0, str(b["fit"]))

# ── 3. more notes than syllables = held (benign melisma, lightly penalized) ────────────
r = rep["lines"][2]
check("roomy line: held == slots-syllables (2)", r["held"] == 2, str(r))
check("roomy line: verdict 'held'", r["verdict"] == "held")
check("roomy line: held is benign — fit stays high", r["fit"] > 0.85, str(r["fit"]))

# ── 4. overall workability = slot-weighted mean of scored lines ───────────────────────
import math  # noqa: E402
exp = sum(l["fit"] * l["slots"] for l in rep["lines"]) / sum(l["slots"] for l in rep["lines"])
check("workability is the slot-weighted mean of per-line fit", math.isclose(rep["workability"], exp, rel_tol=1e-9), f"{rep['workability']} vs {exp}")
check("workability in (0,1)", 0.0 < rep["workability"] < 1.0)
check("counts clean lines", rep.get("clean") == 1 and rep.get("linesScored") == 3)

# ── 5. un-renderable lines are SKIPPED (mirror author_score), not scored as fits ──────
skip_rep = fit.compute_fit([L("gap ___ here", 3), L("no notes", 0), L("unasserted", 3, asserted=False), CLEAN])
check("gap / no-slots / unasserted lines are skipped", skip_rep["linesSkipped"] == 3 and skip_rep["linesScored"] == 1, str(skip_rep))
check("skipped lines carry scored=False", sum(1 for l in skip_rep["lines"] if not l["scored"]) == 3)

# ── 6. deterministic ──────────────────────────────────────────────────────────────────
check("compute_fit is deterministic", fit.compute_fit([CLEAN, BUSY, ROOMY]) == rep)

# ── 7. the fit number AGREES with author_score's actual placement ─────────────────────
authored = sx.author_score([CLEAN])
check("clean line: author_score emits exactly 3 word events (matches fit's 'clean')",
      authored.get("ok") and authored["words"] == 3, str(authored.get("words")))

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
