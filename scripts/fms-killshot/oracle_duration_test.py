#!/usr/bin/env python3
"""Golden tests for the V2 oracle-duration pure core (mechanism-verify spec §3).

Pins the registered duration-mapping rules (k==m / m>k fold / k>m drop), gold-relative gap
authoring, line finding (rest-bounded, cut-word rejection), rest absorption with overhang
abort, 4dp error-diffusion re-emit, and total-length preservation. Deterministic (3×).

Run:  python3 scripts/fms-killshot/oracle_duration_test.py     (exit 0 = all pass)
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import oracle_duration as od  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# rest | fights(1n) won(1n) | rest | strangers(2n: 2,3) | rest        (chunk-local)
CLIP = {
    "index": "t_0_3000", "language": "English", "time": [1000, 4000],
    "duration": "0.5000 0.4000 0.3000 0.3000 0.6000 0.4000 0.5000",
    "text": "<SP> fights won <SP> strangers strangers <SP>",
    "phoneme": "<SP> en_F-AY1-T-S en_W-AH1-N <SP> en_S-T-R-EY1-N en_JH-ER0-Z <SP>",
    "note_pitch": "0 60 62 0 64 63 0",
    "note_type": "1 2 2 1 2 3 1",
}
notes = od.parse_notes(CLIP)
check("parse_notes count", len(notes) == 7)
check("chain sums to span", abs(sum(n["dur"] for n in notes) - 3.0) < 1e-9)

# ── find_line ──────────────────────────────────────────────────────────────────────────
i0, i1 = od.find_line(notes, 0.4, 1.3)
check("find_line fights..won", (i0, i1) == (1, 3), f"{(i0, i1)}")
j0, j1 = od.find_line(notes, 1.4, 2.6)
check("find_line strangers (2 notes)", (j0, j1) == (4, 6))
try:
    od.find_line(notes, 1.4, 2.1)   # cuts the strangers continuation
    check("cut-word window rejected", False)
except ValueError:
    check("cut-word window rejected", True)

units = od.word_units(notes, 1, 6)
check("word_units groups continuations",
      [u["word"] for u in units] == ["fights", "won", "strangers"]
      and [len(u["idx"]) for u in units] == [1, 1, 2])

# ── map_word_durations ─────────────────────────────────────────────────────────────────
check("k==m 1:1", od.map_word_durations([0.4], [0.35]) == ([0.35], 0))
check("m>k fold tail", od.map_word_durations([0.4, 0.3], [0.2, 0.2, 0.3]) == ([0.2, 0.5], 0))
m, dropped = od.map_word_durations([0.3, 0.2, 0.2], [0.25, 0.25])
check("k>m drops surplus continuations", m == [0.25, 0.25] and dropped == 1)

# ── build_oracle_line: gaps from gold, pitches verbatim, drop logged ───────────────────
gold = [
    {"word": "fights", "start": 10.00, "end": 10.30, "slots": [0.30]},
    {"word": "won", "start": 10.42, "end": 10.70, "slots": [0.28]},      # 120ms gap -> rest
    {"word": "strangers", "start": 10.705, "end": 11.30, "slots": [0.30, 0.295]},  # 5ms gap absorbed
]
line, log = od.build_oracle_line(notes, 1, 6, gold)
check("oracle line shape: fights, rest, won, strangers(2)",
      [n["text"] for n in line] == ["fights", "<SP>", "won", "strangers", "strangers"],
      str([n["text"] for n in line]))
check("gap rest duration from gold", abs(line[1]["dur"] - 0.12) < 1e-9)
check("sub-10ms gap absorbed into prev note", abs(line[2]["dur"] - (0.28 + 0.005)) < 1e-9)
check("pitches copied verbatim", [n["pitch"] for n in line] == ["60", "0", "62", "64", "63"])
check("log counts", log["gap_rests"] == 1 and log["dropped_notes"] == 0 and log["folds"] == 0)

# internal rest between baseline words survives via gold gaps only (registered: gaps from GOLD)
line2, log2 = od.build_oracle_line(
    notes, 1, 6,
    [{"word": "fights", "start": 0.0, "end": 0.3, "slots": [0.3]},
     {"word": "won", "start": 0.301, "end": 0.6, "slots": [0.299]},
     {"word": "strangers", "start": 0.9, "end": 1.5, "slots": [0.3, 0.3]}])
check("baseline internal rest replaced by gold micro-gap",
      [n["text"] for n in line2] == ["fights", "won", "<SP>", "strangers", "strangers"])

try:
    od.build_oracle_line(notes, 1, 6, gold[:2])
    check("word-count mismatch aborts", False)
except ValueError:
    check("word-count mismatch aborts", True)

# ── splice: rest absorption + overhang ─────────────────────────────────────────────────
spliced = od.splice_line(notes, 4, 6, line[:1])  # strangers(1.0s) -> fights(0.3s)
check("following rest absorbs the delta",
      abs(spliced[5]["dur"] - (0.5 + (1.0 - 0.3))) < 1e-9, str(spliced[5]))
check("total preserved after splice",
      abs(sum(n["dur"] for n in spliced) - 3.0) < 1e-9)
big = [dict(line[0], dur=1.46)]
try:
    od.splice_line(notes, 4, 6, big)   # rest would be 0.5 + (1.0-1.46) = 0.04 < 0.05
    check("overhang aborts", False)
except ValueError:
    check("overhang aborts", True)

# ── emit + quantize ────────────────────────────────────────────────────────────────────
clip2 = od.emit_clip(spliced, CLIP["time"], "oracle_t")
durs2 = [float(d) for d in clip2["duration"].split()]
check("emitted chain sums exactly to span", abs(sum(durs2) - 3.0) < 1e-9, str(sum(durs2)))
check("emit round-trips through parse", len(od.parse_notes(clip2)) == len(spliced))
q = od.quantize_4dp([0.33333, 0.33333, 0.33334], 1.0)
check("error diffusion sums exact", abs(sum(q) - 1.0) < 1e-12 and all(abs(x - round(x, 4)) < 1e-12 for x in q))

# ── even_slots ─────────────────────────────────────────────────────────────────────────
sl = od.even_slots(1.0, 2.2, 3)
check("even_slots covers span", abs(sl[0][0] - 1.0) < 1e-9 and abs(sl[-1][1] - 2.2) < 1e-9
      and abs((sl[1][1] - sl[1][0]) - 0.4) < 1e-9)

# ── determinism (3×) ───────────────────────────────────────────────────────────────────
def digest():
    l, lg = od.build_oracle_line(notes, 1, 6, gold)
    payload = {"line": l, "log": lg,
               "clip": od.emit_clip(od.splice_line(notes, 4, 6, l[:1]), CLIP["time"], "x")}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()

check("3x deterministic", len({digest() for _ in range(3)}) == 1)

if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print("\nOK: 0 failure(s)")
