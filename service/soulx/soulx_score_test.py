#!/usr/bin/env python3
"""Golden tests for the SoulX target-score author (FMS Phase-3 Stage 2, fake-first).

`author_score` turns accepted lyric lines + their per-line `lyricScore` blobs (landed by
Stage 1's build_skeleton_from_clip) into the SoulX-Singer target-score JSON — the exact
shape the KS-A grid renders validated (scripts/fms-killshot/score_author.py): per-event
`text` / `phoneme` (en_-prefixed dash-joined ARPAbet) / `note_pitch` (MIDI, 0 = rest) /
`note_type` (1 rest, 2 word, 3 continuation) / `duration` (seconds).

Pure stdlib + the phonology core (cmudict/g2p when importable, heuristic fallback —
never crashes on gibberish). Deterministic: 3x identical output.

Run:  python3 service/soulx/soulx_score_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from soulx import score as sx  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def SLOT(a, b, *pitches):
    segs, n = [], len(pitches)
    for i, p in enumerate(pitches):
        segs.append({"start": a + (b - a) * i / n, "end": a + (b - a) * (i + 1) / n, "pitch": p})
    return {"start": a, "end": b, "velocity": 90, "kind": "gap", "segments": segs}


def LINE(text, slots, bar=0, asserted=True):
    return {"text": text, "asserted": asserted,
            "score": {"v": 1, "algo": "v3", "bar": bar, "bpm": 120.0,
                      "timeSig": [4, 4], "grid": "1/16", "clamped": False,
                      "slots": slots}}


def toks(clip, key):
    return clip[key].split()


# ── 1. Exact fit: 3 one-syllable words over 3 single-segment slots ─────────────────────
r = sx.author_score([LINE("hold the flame", [SLOT(0.5, 1.0, 57), SLOT(1.0, 1.5, 59), SLOT(1.5, 2.0, 60)])])
check("author ok with one clip", r.get("ok") and len(r.get("score", [])) == 1, str(r.get("error")))
clip = r["score"][0]
check("leading gap from t=0 becomes an <SP> rest (take-aligned timeline)",
      toks(clip, "text")[0] == "<SP>" and toks(clip, "note_type")[0] == "1"
      and toks(clip, "note_pitch")[0] == "0" and abs(float(toks(clip, "duration")[0]) - 0.5) < 0.011,
      f"{toks(clip, 'text')[:2]} {toks(clip, 'duration')[:2]}")
check("3 word events, type 2, take pitches",
      toks(clip, "text")[1:] == ["hold", "the", "flame"]
      and toks(clip, "note_type")[1:] == ["2", "2", "2"]
      and toks(clip, "note_pitch")[1:] == ["57", "59", "60"], str(clip["text"]))
check("word durations are the slot spans", all(abs(float(d) - 0.5) < 0.011 for d in toks(clip, "duration")[1:]),
      str(clip["duration"]))
check("phonemes are en_-prefixed ARPAbet",
      all(p.startswith("en_") or p == "<SP>" for p in toks(clip, "phoneme")),
      str(clip["phoneme"]))
check("time covers the full span in ms", clip["time"][0] == 0 and abs(clip["time"][1] - 2000) <= 20,
      str(clip["time"]))

# ── 2. Melisma slot: 2 segments -> type 2 + type 3 continuation, same word ─────────────
r = sx.author_score([LINE("flame", [SLOT(0.0, 1.0, 57, 60)])])
clip = r["score"][0]
check("melisma: word then continuation", toks(clip, "note_type") == ["2", "3"]
      and toks(clip, "text") == ["flame", "flame"]
      and toks(clip, "note_pitch") == ["57", "60"], f"{clip['text']} {clip['note_type']}")
# FMS sung-render fix: a held 1-syllable continuation SUSTAINS the bare vowel (onset stripped)
# instead of re-emitting the full onset-carrying phoneme — the real SoulX model re-ATTACKS on
# a repeated onset ("down-down"); a bare vowel makes it hold the note.
check("melisma continuation sustains the bare vowel, not a re-articulation",
      toks(clip, "phoneme") == ["en_F-L-EY1-M", "en_EY1"], str(clip["phoneme"]))

# ── 3. Multi-syllable word consumes its syllable count of slots (continuations) ────────
r = sx.author_score([LINE("forever gold",
                          [SLOT(0.0, 0.5, 57), SLOT(0.5, 1.0, 59), SLOT(1.0, 1.5, 60), SLOT(1.5, 2.0, 62)])])
clip = r["score"][0]
check("'forever' (3 syl) takes 3 slots: type 2 + two type 3; 'gold' takes the 4th",
      toks(clip, "text") == ["forever", "forever", "forever", "gold"]
      and toks(clip, "note_type") == ["2", "3", "3", "2"]
      and toks(clip, "note_pitch") == ["57", "59", "60", "62"],
      f"{clip['text']} {clip['note_type']}")
# FMS fix: a multi-syllable word PROGRESSES through its syllable phonemes across its slots
# (for-EV-er), it does NOT re-articulate the whole word on each slot.
check("multi-syllable word distributes its syllable phonemes across the slots",
      toks(clip, "phoneme")[:3] == ["en_F-ER0", "en_EH1", "en_V-ER0"], str(clip["phoneme"]))

# ── 4. Squeeze: more word-syllables than slots -> words share the last slot evenly ─────
r = sx.author_score([LINE("hold the flame", [SLOT(0.0, 0.5, 57), SLOT(0.5, 1.1, 60)])])
clip = r["score"][0]
check("squeeze: every word still sung (3 type-2 events over 2 slots)",
      toks(clip, "text") == ["hold", "the", "flame"] and toks(clip, "note_type") == ["2", "2", "2"],
      f"{clip['text']} {clip['note_type']}")
check("squeeze: the shared slot splits evenly",
      abs(float(toks(clip, "duration")[1]) - 0.3) < 0.011 and abs(float(toks(clip, "duration")[2]) - 0.3) < 0.011,
      str(clip["duration"]))

# ── 5. Leftover slots become a held continuation of the last word (never dropped) ──────
r = sx.author_score([LINE("flame", [SLOT(0.0, 0.5, 57), SLOT(0.5, 1.0, 59), SLOT(1.0, 1.5, 60)])])
clip = r["score"][0]
check("hold: 1 word over 3 slots = type 2 + type 3 + type 3",
      toks(clip, "text") == ["flame", "flame", "flame"] and toks(clip, "note_type") == ["2", "3", "3"],
      f"{clip['text']} {clip['note_type']}")
# FMS fix: a 1-syllable word held over N slots = the word once, then the bare vowel sustained
# on every continuation (no re-attack). This is the exact "down down down" defect the owner heard.
check("held 1-syllable word: onset once, then vowel sustained on each continuation",
      toks(clip, "phoneme") == ["en_F-L-EY1-M", "en_EY1", "en_EY1"], str(clip["phoneme"]))

# ── 5b. FMS re-attack fix on a REAL multi-syllable word: 'gonna' over 2 slots = gon→na ──
# (the owner heard "gonna gonna" — the whole word re-articulated. Correct is the syllables.)
r = sx.author_score([LINE("gonna", [SLOT(0.0, 1.0, 50, 50)])])
clip = r["score"][0]
check("'gonna' over 2 slots progresses gon→na (no whole-word re-articulation)",
      toks(clip, "phoneme") == ["en_G-AA1", "en_N-AH0"] and toks(clip, "note_type") == ["2", "3"],
      str(clip["phoneme"]))

# ── 5c. No BARE-SCHWA slot: a word-initial unstressed vowel (again = AH0-G-EH1-N) must not
# get its own naked-vowel note (SoulX garbles a consonant-less "uh") — it borrows the next
# syllable's onset consonant so every slot has substance. ("again" → "ag"/"ain")
r = sx.author_score([LINE("again", [SLOT(0.0, 1.0, 50, 50)])])
clip = r["score"][0]
check("'again' borrows the onset so slot 1 isn't a bare schwa",
      toks(clip, "phoneme") == ["en_AH0-G", "en_EH1-N"], str(clip["phoneme"]))

# ── 6. Inter-slot gaps become <SP> rests ────────────────────────────────────────────────
r = sx.author_score([LINE("hold flame", [SLOT(0.0, 0.4, 57), SLOT(1.0, 1.4, 60)])])
clip = r["score"][0]
check("a 0.6s gap between slots is an <SP> rest",
      toks(clip, "text") == ["hold", "<SP>", "flame"] and toks(clip, "note_type")[1] == "1"
      and abs(float(toks(clip, "duration")[1]) - 0.6) < 0.011, f"{clip['text']} {clip['duration']}")

r = sx.author_score([LINE("hold ___ zzzqx", [SLOT(0.0, 0.5, 57), SLOT(0.5, 1.0, 59), SLOT(1.0, 1.5, 60)])])
check("___ gap line is skipped, never rendered as placeholder words",
      (not r.get("ok")) and r.get("error") == "no_asserted_scored_lines", str(r))
r = sx.author_score([LINE("hold zzzqx", [SLOT(0.0, 0.5, 57), SLOT(0.5, 1.0, 60)])])
clip = r["score"][0]
check("gibberish word gets fallback phones (no crash, still en_ ARPAbet)",
      toks(clip, "phoneme")[1].startswith("en_"), str(clip["phoneme"]))

# ── 8. Lines without a score are skipped + reported (never invented) ───────────────────
r = sx.author_score([LINE("hold the flame", [SLOT(0.0, 0.5, 57), SLOT(0.5, 1.0, 59), SLOT(1.0, 1.5, 60)]),
                     {"text": "typed later, no take flow", "score": None}])
check("scoreless line skipped + counted", r["ok"] and r["linesUsed"] == 1 and r["linesSkipped"] == 1,
      f"used={r.get('linesUsed')} skipped={r.get('linesSkipped')}")

# ── 9. Empty / all-scoreless input -> clean error ───────────────────────────────────────
r = sx.author_score([{"text": "no flow", "asserted": True, "score": None}])
check("no scored lines -> ok:false no asserted score", (not r.get("ok")) and r.get("error") == "no_asserted_scored_lines", str(r))
check("empty lines -> ok:false", not sx.author_score([]).get("ok"))

# ── 9b. Duration-chain precision: cumulative drift stays sub-millisecond ───────────────
# The score's timeline is reconstructed by SUMMING duration tokens (fake renderer AND the
# real model). 2dp formatting drifted real takes' onsets up to 33 ms (owner ear-caught,
# 2026-07-04) — a third of a 16th at 134 BPM. Pin: over ~120 awkward-duration slots, the
# reconstructed final onset lands within 1 ms of the take's true time.
_drift_slots = [SLOT(0.31 + i * (1.0 / 3.0), 0.31 + i * (1.0 / 3.0) + 0.2107, 57)
                for i in range(120)]
_r = sx.author_score([LINE("la", _drift_slots)])
_clip = _r["score"][0]
_durs = [float(d) for d in _clip["duration"].split()]
_types = [int(t) for t in _clip["note_type"].split()]
_t, _last_onset = 0.0, None
for _d, _nt in zip(_durs, _types):
    if _nt in (2, 3):
        _last_onset = _t
    _t += _d
_true_last = _drift_slots[-1]["start"]
check("duration chain: last onset within 1ms of the take's true time",
      _last_onset is not None and abs(_last_onset - _true_last) < 0.001,
      f"drift={( _last_onset - _true_last) * 1000:.2f}ms over {len(_durs)} events")

# ── 10. Determinism: 3x identical serialization ────────────────────────────────────────
import hashlib
import json

LINES = [LINE("they counted me out still I hold the flame",
              [SLOT(0.5 + 0.25 * i, 0.75 + 0.25 * i, 55 + (i % 5)) for i in range(9)]),
         LINE("cold nights taught me how to hold",
              [SLOT(4.0 + 0.3 * i, 4.25 + 0.3 * i, 53 + (i % 4), *([58] if i == 2 else [])) for i in range(7)],
              bar=2)]
digs = {hashlib.sha256(json.dumps(sx.author_score(LINES), sort_keys=True).encode()).hexdigest()
        for _ in range(3)}
check("3x deterministic", len(digs) == 1)
r = sx.author_score(LINES)
check("two lines flow into one clip with rests between", r["ok"] and len(r["score"]) == 1
      and r["score"][0]["text"].count("<SP>") >= 2, str(r["score"][0]["text"] if r.get("ok") else r))

if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print("\nOK: 0 failure(s)")
