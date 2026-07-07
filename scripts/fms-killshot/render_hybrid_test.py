#!/usr/bin/env python3
"""Golden tests for the hybrid render authoring + overlay (FMS stage 6, deterministic core).

The MPS renders themselves are owner-gated, but the deterministic authoring is tested:
  - rewrite_spans: the time spans of the REWRITTEN lines (where melody-mode replaces SVC)
  - author_melody_metadata: a melody-mode clip that sings ONLY the rewritten lines (sung
    lines become <SP> rests) with the take's real F0 attached as the space-separated string
    control=melody reads (50 fps).
  - overlay: SVC (clear spans) + melody (rewritten spans) blended by span with edge crossfades.

Run:  python3 scripts/fms-killshot/render_hybrid_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import render_hybrid as rh  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def SLOT(a, b, pitch=55):
    return {"start": a, "end": b, "velocity": 90, "segments": [{"start": a, "end": b, "pitch": pitch}]}


def SC(*slots):
    return {"v": 1, "algo": "v4", "bar": 0, "bpm": 120.0, "timeSig": [4, 4], "grid": "1/16",
            "clamped": False, "slots": list(slots)}


SHEET = {
    "lines": [
        {"index": 0, "origin": "sung", "text": "hold the line"},
        {"index": 1, "origin": "generated", "text": "rise again tonight"},
        {"index": 2, "origin": "sung", "text": "cold at night"},
        {"index": 3, "origin": "mixed", "text": "they fade from sight"},
    ],
    "lineScores": [
        SC(SLOT(0.5, 1.0), SLOT(1.0, 1.5), SLOT(1.5, 2.0)),
        SC(SLOT(3.0, 3.5), SLOT(3.5, 4.0), SLOT(4.0, 4.5)),
        SC(SLOT(5.0, 5.5), SLOT(5.5, 6.0)),
        SC(SLOT(7.0, 7.5), SLOT(7.5, 8.0), SLOT(8.0, 8.5)),
    ],
}


# ── 1. rewrite_spans: only the rewritten lines' spans ──────────────────────────────────
spans = rh.rewrite_spans(SHEET)
check("rewrite_spans returns only the rewritten lines' spans",
      spans == [(3.0, 4.5), (7.0, 8.5)], str(spans))

# ── 2. author_melody_metadata: only rewritten words sing; sung lines are rests ─────────
take_f0 = [220.0] * 600
md = rh.author_melody_metadata(SHEET, take_f0, fps=50)
check("author ok, one clip", md.get("ok") and len(md.get("score", [])) == 1, str(md.get("error")))
clip = md["score"][0]
txt = clip["text"]
check("rewritten words present", "rise" in txt and "sight" in txt, txt)
check("SUNG words NOT in the melody clip (they're SVC's job)", "hold" not in txt and "cold" not in txt, txt)
check("sung spans became <SP> rests", "<SP>" in txt, txt)

# ── 3. author_melody_metadata: F0 attached as a 50fps space-separated string ───────────
n_expected = round(clip["time"][1] / 1000 * 50)
f0toks = clip["f0"].split()
check("f0 field is a space-separated string of the take's F0", isinstance(clip["f0"], str) and len(f0toks) == n_expected,
      f"{len(f0toks)} toks vs {n_expected}")
check("f0 values are the take's Hz (voiced)", all(abs(float(x) - 220.0) < 1e-6 for x in f0toks[:5]), str(f0toks[:3]))
check("clip time ends at the last rewritten line's end (~8500ms)", abs(clip["time"][1] - 8500) <= 20, str(clip["time"]))

# ── 4. author_melody_metadata: t_end slices to rewritten lines before the cutoff ───────
md2 = rh.author_melody_metadata(SHEET, take_f0, fps=50, t_end=5.0)
clip2 = md2["score"][0]
check("t_end=5.0 keeps only the first rewritten line (ends 4.5)",
      "rise" in clip2["text"] and "sight" not in clip2["text"], clip2["text"])

# ── 5. overlay: melody replaces SVC inside spans, SVC elsewhere, crossfaded edges ──────
sr = 100
svc = [1000.0] * 1000       # constant "clear" voice
mel = [-400.0] * 1000       # constant "rewritten" voice (silent-in-reality, constant here for the test)
out = rh.overlay(svc, mel, [(3.0, 4.5)], sr, xfade_ms=100)  # span = samples [300,450], xfade=10 samples
check("inside the span → melody", abs(out[380] - (-400.0)) < 1e-6, str(out[380]))
check("well outside the span → SVC", abs(out[100] - 1000.0) < 1e-6 and abs(out[700] - 1000.0) < 1e-6, f"{out[100]},{out[700]}")
check("fade-in midpoint blends svc→melody", abs(out[295] - (0.5 * 1000.0 + 0.5 * -400.0)) < 60.0, str(out[295]))
check("overlay length matches svc", len(out) == len(svc), str(len(out)))

# ── 6. Determinism: 3x identical authored clip ─────────────────────────────────────────
import hashlib
import json
digs = {hashlib.sha256(json.dumps(rh.author_melody_metadata(SHEET, take_f0, fps=50), sort_keys=True).encode()).hexdigest() for _ in range(3)}
check("3x deterministic authored metadata", len(digs) == 1, str(digs))

if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print("\nOK: 0 failure(s)")
