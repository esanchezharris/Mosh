#!/usr/bin/env python3
"""Goldens for installing corrected lyrics as bench ground truth (pure cores).

Run:  python3 scripts/fms-killshot/bench_lyric_install_test.py
"""
import hashlib
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_lyric_install as bli  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


LINES = [{"t": 0.0, "text": "I been tough, I been rough"},
         {"t": 3.2, "text": "  "},
         {"t": 6.5, "text": "smashing the piñata — my whole life!"},
         {"t": 9.8, "text": "(ah) don't stop"}]

# ── tokenize: what the aligner is allowed to be asked for ──────────────────────────────
toks = bli.tokenize_lines(LINES)
check("blank lines contribute nothing", all(t["line"] != 1 for t in toks), str(toks[:1]))
check("punctuation stripped, words kept in order",
      [t["word"] for t in toks][:6] == ["I", "been", "tough", "I", "been", "rough"],
      str([t["word"] for t in toks][:6]))
check("em-dash and trailing '!' do not become words",
      "—" not in [t["word"] for t in toks] and "life" in [t["word"] for t in toks])
check("accented letters survive tokenization (piñata stays one word)",
      "piñata" in [t["word"] for t in toks], str([t["word"] for t in toks]))
check("apostrophes survive (don't stays one word)", "don't" in [t["word"] for t in toks])
check("parenthetical ad-libs are kept as words (they are sung)",
      "ah" in [t["word"] for t in toks], str([t["word"] for t in toks]))
check("each token carries its source line index + line start time",
      toks[0]["line"] == 0 and toks[0]["lineT"] == 0.0 and toks[-1]["lineT"] == 9.8)

check("empty input -> no tokens", bli.tokenize_lines([]) == [])
check("all-blank input -> no tokens", bli.tokenize_lines([{"t": 0.0, "text": " "}]) == [])

# ── merge_alignment: aligner spans + line times -> the bench's words.json ──────────────
ALIGNED = [{"word": "I", "start": 0.10, "end": 0.30, "score": 0.8},
           {"word": "been", "start": 0.35, "end": 0.60, "score": 0.7},
           {"word": "tough", "start": 0.65, "end": 1.00, "score": 0.2}]
TOKS = [{"word": "I", "line": 0, "lineT": 0.0}, {"word": "been", "line": 0, "lineT": 0.0},
        {"word": "tough", "line": 0, "lineT": 0.0}]
merged = bli.merge_alignment(TOKS, ALIGNED)
check("merged rows carry word/start/end monotonically",
      [m["word"] for m in merged] == ["I", "been", "tough"]
      and merged[0]["start"] < merged[1]["start"] < merged[2]["start"], str(merged))
check("alignment score is carried through for QA", merged[2]["score"] == 0.2)
check("count mismatch is a hard error, never a silent truncation",
      bli.merge_alignment(TOKS, ALIGNED[:2]) is None)

# ── quality report: the honest read before anything is installed ───────────────────────
rep = bli.alignment_report(merged, hit=0.3)
check("report counts low-confidence words rather than hiding them",
      rep["n"] == 3 and rep["low"] == 1 and rep["lowWords"] == ["tough"], json.dumps(rep))
check("report exposes coverage span", abs(rep["span"][1] - 1.00) < 1e-9)

# ── install: writes words.json + lyrics.txt, backs up the originals ────────────────────
with tempfile.TemporaryDirectory() as td:
    for name, body in (("s.words.json", json.dumps([{"word": "old", "start": 0, "end": 1}])),
                       ("s.lyrics.txt", "old lyric\n")):
        open(os.path.join(td, name), "w").write(body)
    paths = bli.install("s", merged, LINES, td)
    check("words.json replaced with the merged alignment",
          [w["word"] for w in json.load(open(paths["words"]))] == ["I", "been", "tough"])
    check("lyrics.txt holds the corrected non-blank lines, in order",
          open(paths["lyrics"]).read().splitlines()[0] == "I been tough, I been rough")
    check("originals backed up, not destroyed",
          json.load(open(paths["backupWords"]))[0]["word"] == "old"
          and "old lyric" in open(paths["backupLyrics"]).read())
    bli.install("s", merged, LINES, td)
    check("re-install does not clobber the FIRST backup (the real ground truth)",
          json.load(open(paths["backupWords"]))[0]["word"] == "old")

det = {hashlib.sha256(json.dumps(bli.tokenize_lines(LINES), sort_keys=True).encode()).hexdigest()
       for _ in range(3)}
check("tokenize deterministic (3x)", len(det) == 1)

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
