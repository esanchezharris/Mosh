#!/usr/bin/env python3
"""Goldens for the lyric-correction tool's pure cores (page data + save validation).

Run:  python3 scripts/fms-killshot/bench_lyric_edit_test.py   (exit 0 = all pass)
"""
import hashlib
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_lyric_edit as ble  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


SEGS = [{"start": 0.0, "end": 3.2, "text": "I been tough I been rough"},
        {"start": 3.3, "end": 6.4, "text": "smashing a pinata my whole life"},
        {"start": 16.5, "end": 19.6, "text": "warning all you fools"},
        {"start": 19.7, "end": 23.0, "text": "cutting the beat up"}]

# ── build_lines: every ASR segment becomes an editable row with a play span ─────────────
lines = ble.build_lines(SEGS, dur=30.0)
check("one row per segment, text carried verbatim",
      [ln["text"] for ln in lines] == [s["text"] for s in SEGS], str(lines[:1]))
check("play span runs to the NEXT line's start (so a click plays that line, not a word)",
      abs(lines[0]["playEnd"] - 3.3) < 1e-9 and abs(lines[2]["playEnd"] - 19.7) < 1e-9,
      str([ln["playEnd"] for ln in lines]))
check("last line's span runs to the take end", abs(lines[-1]["playEnd"] - 30.0) < 1e-9)
check("rows carry a stable id (edits survive reordering in the UI)",
      len({ln["id"] for ln in lines}) == 4)
check("verified flag defaults False", all(ln["verified"] is False for ln in lines))

vlines = ble.build_lines(SEGS, dur=30.0, verified_until=15.0)
check("segments inside the verified span are marked verified (context, not work)",
      [ln["verified"] for ln in vlines] == [True, True, False, False], str(
          [ln["verified"] for ln in vlines]))

check("empty segments -> empty rows (never crashes)", ble.build_lines([], dur=5.0) == [])

# ── verified rows must show the TRUE words, never the ASR guess of them ────────────────
VWORDS = [{"word": "I", "start": 0.1, "end": 0.3}, {"word": "been", "start": 0.4, "end": 0.7},
          {"word": "tough", "start": 0.8, "end": 1.2},
          {"word": "smashing", "start": 3.4, "end": 3.9},
          {"word": "the", "start": 4.0, "end": 4.2},
          {"word": "piñata", "start": 4.3, "end": 5.0}]
tv = ble.build_lines(SEGS, dur=30.0, verified_until=15.0, verified_words=VWORDS)
check("verified row text comes from the verified WORDS, not the transcriber",
      tv[0]["text"] == "I been tough" and tv[1]["text"] == "smashing the piñata",
      str([ln["text"] for ln in tv[:2]]))
check("draft rows keep the ASR text untouched",
      tv[2]["text"] == SEGS[2]["text"] and tv[3]["text"] == SEGS[3]["text"])
check("a verified span with no words in it falls back to the ASR text (never blanks a row)",
      ble.build_lines([{"start": 8.0, "end": 9.0, "text": "asr guess"}], dur=30.0,
                      verified_until=15.0, verified_words=VWORDS)[0]["text"] == "asr guess")

# ── validate_correction: guard what a browser may write to disk ────────────────────────
GOOD = {"song": "stage9orsum", "lines": [{"t": 0.0, "text": "I been tough"},
                                         {"t": 3.3, "text": "smashing a pinata"}]}
ok, err = ble.validate_correction(GOOD, {"stage9orsum", "stage10"})
check("well-formed payload validates", ok, str(err))

for bad, why in (
        ({"song": "../etc/passwd", "lines": []}, "path traversal in song"),
        ({"song": "nope", "lines": []}, "unknown song"),
        ({"song": "stage9orsum"}, "missing lines"),
        ({"song": "stage9orsum", "lines": [{"t": -1.0, "text": "x"}]}, "negative time"),
        ({"song": "stage9orsum", "lines": [{"t": 0.0, "text": "x" * 5000}]}, "absurd text"),
        ({"song": "stage9orsum", "lines": [{"t": 0.0}]}, "missing text"),
        ({"song": "stage9orsum", "lines": "notalist"}, "lines not a list"),
):
    ok, _ = ble.validate_correction(bad, {"stage9orsum", "stage10"})
    check(f"rejects {why}", not ok, json.dumps(bad)[:60])

check("blank lines are allowed (a deleted/never-sung line)",
      ble.validate_correction({"song": "stage10", "lines": [{"t": 1.0, "text": "  "}]},
                              {"stage10"})[0])

# ── save_correction: atomic write, sorted by time, blanks dropped from the lyric text ──
with tempfile.TemporaryDirectory() as td:
    payload = {"song": "stage10", "lines": [{"t": 5.0, "text": "second line"},
                                            {"t": 1.0, "text": "first line"},
                                            {"t": 3.0, "text": "   "}]}
    paths = ble.save_correction(payload, td)
    saved = json.load(open(paths["json"]))
    check("saved json sorted by time",
          [ln["t"] for ln in saved["lines"]] == [1.0, 3.0, 5.0], str(saved["lines"]))
    txt = open(paths["txt"]).read()
    check("plain-text sidecar holds only non-blank lines, in order",
          txt.split("\n")[:2] == ["first line", "second line"], repr(txt))
    ble.save_correction({"song": "stage10", "lines": [{"t": 1.0, "text": "rewritten"}]}, td)
    check("re-save overwrites in place (no orphan temp files)",
          json.load(open(paths["json"]))["lines"][0]["text"] == "rewritten"
          and not [f for f in os.listdir(td) if f.endswith(".tmp")], str(os.listdir(td)))

# ── Range parsing: without it the browser cannot SEEK audio (a click plays from 0) ─────
check("open-ended range 'bytes=100-' -> [100, size-1]", ble.parse_range("bytes=100-", 500) == (100, 499))
check("closed range 'bytes=10-19' -> [10, 19]", ble.parse_range("bytes=10-19", 500) == (10, 19))
check("suffix range 'bytes=-50' -> last 50 bytes", ble.parse_range("bytes=-50", 500) == (450, 499))
check("range past EOF clamps to the last byte", ble.parse_range("bytes=400-9999", 500) == (400, 499))
check("no header -> None (plain 200)", ble.parse_range(None, 500) is None)
check("garbage header -> None, never a crash", ble.parse_range("bytes=abc", 500) is None)
check("unsatisfiable start -> 'invalid' sentinel (416, not a silent 200)",
      ble.parse_range("bytes=900-", 500) == "invalid")

det = {hashlib.sha256(json.dumps(ble.build_lines(SEGS, dur=30.0),
                                 sort_keys=True).encode()).hexdigest() for _ in range(3)}
check("build_lines deterministic (3x)", len(det) == 1)

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
