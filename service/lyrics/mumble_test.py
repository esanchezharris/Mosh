#!/usr/bin/env python3
"""Golden tests for the audio "mumble take" spec-builder (Finish-My-Song Phase 3).

`build_spec_from_take(notes, words, bpm, ...)` turns a sung take's note onsets (Basic
Pitch — the reliable RHYTHM) + confidence-gated words (Whisper) into a lyric constraint
spec: one line per non-empty bar, syllables-per-bar = notes-per-bar (clamped), stress from
note dynamics, confident words placed as anchors and the rest as `___` gaps. The L2/L3 loop
then fills the gaps. PURE + deterministic (note/word math only, stdlib) — golden-tested 3×.

When Whisper isn't installed, /transcribe_words degrades to EMPTY words (everything becomes
a gap) — never invented words (misrecognized lyrics in the sheet would be worse than gaps),
so the rhythm path still works hermetically. The word-anchor path is covered here with
explicit words (Whisper's real job).

Run:  python3 service/lyrics/mumble_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from lyrics import core, mumble  # noqa: E402

# An empty-words take (Whisper absent / nothing confident) → all gaps; the rhythm still
# builds the sheet. Asserted in section 9b.

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def note(start, end, vel, pitch=60):
    return {"pitch": pitch, "start": start, "end": end, "velocity": vel}


# ── A 2-bar take at 120bpm 4/4 (sec_per_bar = 2.0). Bar0: 4 notes; bar1: 3 notes. ─
NOTES = [
    note(0.0, 0.4, 100), note(0.5, 0.9, 60), note(1.0, 1.4, 60), note(1.5, 1.9, 110),  # bar 0
    note(2.0, 2.4, 90),  note(2.7, 3.1, 70), note(3.4, 3.8, 100),                       # bar 1
]
WORDS = [
    {"word": "Fire!", "start": 1.5, "end": 1.9, "confidence": 0.9},  # bar0 slot3 → "fire"
    {"word": "uh", "start": 2.0, "end": 2.2, "confidence": 0.3},     # low-conf → dropped
]

EXPECT = {
    "ok": True, "grid": "1/16", "topic": "", "mood": "", "rhymeStrictness": "slant",
    "lines": [
        {"index": 0, "role": "verse", "seedText": "___ ___ ___ fire",
         "syllableTarget": 4, "syllableTol": 1, "stress": "XxxX", "rhymeGroup": "A"},
        {"index": 1, "role": "verse", "seedText": "___ ___ ___",
         "syllableTarget": 3, "syllableTol": 1, "stress": "XxX", "rhymeGroup": "B"},
    ],
}

# ── 1. Exact spec + determinism (3×) ──────────────────────────────────────────────
got = mumble.build_spec_from_take(NOTES, WORDS, bpm=120, time_sig=(4, 4))
check("build_spec_from_take matches the golden", got == EXPECT, str(got))
runs = [mumble.build_spec_from_take(NOTES, WORDS, bpm=120, time_sig=(4, 4)) for _ in range(3)]
check("build_spec_from_take is deterministic (3×)", runs[0] == runs[1] == runs[2])

# ── 2. A confident word becomes a placed anchor; a low-confidence word is dropped ─
line0 = got["lines"][0]
check("confident word 'fire' placed at its nearest slot", line0["seedText"].split()[-1] == "fire")
check("low-confidence 'uh' was NOT placed (stays a gap)", "uh" not in got["lines"][1]["seedText"])

# ── 3. syllableTarget = notes-per-bar; stress length == target ────────────────────
for ln in got["lines"]:
    check(f"line {ln['index']} stress length == syllableTarget", len(ln["stress"]) == ln["syllableTarget"])

# ── 4. Dense bar is CLAMPED to grid_per_bar (1/16 ⇒ 16) ───────────────────────────
dense = [note(i * 0.05, i * 0.05 + 0.04, 80) for i in range(30)]  # 30 notes in bar 0 (<2.0s)
dres = mumble.build_spec_from_take(dense, [], bpm=120, time_sig=(4, 4), grid="1/16")
check("dense bar clamps syllableTarget to 16", dres["lines"][0]["syllableTarget"] == 16, str(dres["lines"][0]["syllableTarget"]))
check("dense bar stress length also clamps to 16", len(dres["lines"][0]["stress"]) == 16)

# ── 5. No notes ⇒ no_melody_detected (no sheet) ───────────────────────────────────
empty = mumble.build_spec_from_take([], [], bpm=120)
check("no notes ⇒ ok False", empty.get("ok") is False)
check("no notes ⇒ error no_melody_detected", empty.get("error") == "no_melody_detected")
check("no notes ⇒ empty lines", empty.get("lines") == [])

# ── 6. Very long take is truncated to MAX_BARS lines ──────────────────────────────
long_notes = [note(b * 2.0 + 0.1, b * 2.0 + 0.5, 90) for b in range(50)]  # 50 bars, 1 note each
lres = mumble.build_spec_from_take(long_notes, [], bpm=120, time_sig=(4, 4))
check("long take truncated to MAX_BARS (32)", len(lres["lines"]) == 32, str(len(lres["lines"])))

# ── 7. Empty bars are skipped; dense lines re-index + ABAB groups ─────────────────
# notes only in bar 0 and bar 2 (gap bar 1 at 2..4s)
gappy = [note(0.2, 0.6, 90), note(4.2, 4.6, 90)]  # bar 0 and bar 2
gres = mumble.build_spec_from_take(gappy, [], bpm=120, time_sig=(4, 4))
check("empty bars skipped ⇒ 2 dense lines", len(gres["lines"]) == 2)
check("dense re-index 0,1 (not bar indices 0,2)", [l["index"] for l in gres["lines"]] == [0, 1])
check("ABAB groups by dense index", [l["rhymeGroup"] for l in gres["lines"]] == ["A", "B"])

# ── 8. Empty words (Whisper absent / nothing confident) ⇒ all gaps, rhythm intact ─
nowords = mumble.build_spec_from_take(NOTES, [], bpm=120, time_sig=(4, 4))
check("empty words ⇒ all slots are gaps", all("___" in l["seedText"] and not any(c.isalpha() for c in l["seedText"]) for l in nowords["lines"]))
check("empty words ⇒ rhythm (syllableTargets) still built", [l["syllableTarget"] for l in nowords["lines"]] == [4, 3])

# ── 9. The built spec is LOOP-VALID — core.complete() fills its gaps ──────────────
filled = core.complete(got, backend="fake")
check("the mumble spec feeds the generation loop", filled.get("ok") is True and len(filled.get("lines", [])) >= 1)
top0 = next((l for l in filled["lines"] if l["index"] == 0), None)
check("loop returns a proposal for the gapped mumble line", top0 is not None and len(top0["proposals"]) >= 1)

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
sys.exit(len(fails))
