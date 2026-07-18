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

# ── 4. Overflow: more WORDS than slots -> REJECTED, never crammed (B2.1, 2026-07-17) ───
# The old "surplus words share the last slot evenly" squeeze was a mechanical
# unnaturalness generator (mechanism-verify handoff §6b); a count-exact upstream can
# never produce words > slots, so reaching this state is an authoring bug — surface it.
r = sx.author_score([LINE("hold the flame", [SLOT(0.0, 0.5, 57), SLOT(0.5, 1.1, 60)])])
check("overflow: words > slots is REJECTED with a named error",
      not r.get("ok") and r.get("error") == "line_overflow", str(r))
check("overflow error carries the counts + offending text",
      r.get("words") == 3 and r.get("slots") == 2 and "hold the flame" in str(r.get("lineText", "")),
      str(r))
# control: words == slots still authors fine
r_ok = sx.author_score([LINE("hold flame", [SLOT(0.0, 0.5, 57), SLOT(0.5, 1.1, 60)])])
check("control: words == slots authors normally", r_ok.get("ok") is True, str(r_ok.get("ok")))

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

# ── 11. word_event_spans + phrase_windows: pure parse of the score chain (Phase A snap) ─
# The product timing-snap derives its slot-snap events + phrase-align windows from the
# SAME authored clip the adapter builds (no chunk offsets — single clip). Chain times are
# take-aligned by construction (4dp error diffusion).
_pclip = {"duration": "0.20 0.22 0.08 0.22 0.08 0.22 0.20", "note_type": "1 2 1 2 1 2 1"}
_evs = sx.word_event_spans(_pclip)
check("word_event_spans: 3 word events at the slot starts",
      len(_evs) == 3 and abs(_evs[0][0] - 0.20) < 1e-6 and abs(_evs[0][1] - 0.42) < 1e-6
      and abs(_evs[1][0] - 0.50) < 1e-6 and abs(_evs[2][0] - 0.80) < 1e-6, str(_evs))
# a type-3 continuation extends its parent word's span (one event, not two)
_cclip = {"duration": "0.20 0.30 0.10 0.50 0.40", "note_type": "1 2 3 1 2"}
_ce = sx.word_event_spans(_cclip)
check("word_event_spans: a type-3 continuation extends the word's end",
      len(_ce) == 2 and abs(_ce[0][0] - 0.20) < 1e-6 and abs(_ce[0][1] - 0.60) < 1e-6
      and abs(_ce[1][0] - 1.10) < 1e-6, str(_ce))
# phrase_windows splits at rests >= rest_split_s (0.08s inter-word rests do NOT split)
_pw = sx.phrase_windows(_cclip, rest_split_s=0.35)
check("phrase_windows splits at the 0.5s rest -> 2 windows, word-counts intact",
      len(_pw) == 2 and _pw[0][2] == 1 and _pw[1][2] == 1
      and abs(_pw[0][0] - 0.20) < 1e-3 and abs(_pw[0][1] - 0.60) < 1e-3, str(_pw))
_pw1 = sx.phrase_windows(_pclip, rest_split_s=0.35)
check("phrase_windows: sub-threshold inter-word rests keep one window of 3 words",
      len(_pw1) == 1 and _pw1[0][2] == 3, str(_pw1))
# derived from a REAL author_score clip: events == word count, on the take timeline
_ar = sx.author_score([LINE("hold the flame", [SLOT(0.5, 1.0, 57), SLOT(1.0, 1.5, 59), SLOT(1.5, 2.0, 60)])])
_ac = _ar["score"][0]
check("word_event_spans on a real authored clip == its word count",
      len(sx.word_event_spans(_ac)) == _ar["words"], str(sx.word_event_spans(_ac)))

# ── 12. durations mode (B1-lite, 2026-07-17): derived vs verbatim ───────────────────────
# default == explicit verbatim, byte-identical (the shipped path never moves)
_dl = [LINE("hold the flame", [SLOT(0.5, 1.0, 57), SLOT(1.0, 1.5, 59), SLOT(1.5, 2.0, 60)]),
       LINE("cold nights fade", [SLOT(3.0, 3.4, 55), SLOT(3.4, 3.9, 57), SLOT(3.9, 4.6, 59)])]
_rv = sx.author_score(_dl)
_rv2 = sx.author_score(_dl, durations="verbatim")
check("durations default == verbatim, byte-identical",
      json.dumps(_rv, sort_keys=True) == json.dumps(_rv2, sort_keys=True))
_rd = sx.author_score(_dl, durations="derived")
check("derived mode ok", _rd.get("ok"), str(_rd)[:200])
_cv, _cd = _rv["score"][0], _rd["score"][0]
for _k in ("text", "phoneme", "note_pitch", "note_type", "time", "index"):
    check(f"derived keeps {_k} byte-identical", _cv[_k] == _cd[_k],
          f"{_cv[_k]} vs {_cd[_k]}")
_dv = [float(x) for x in _cv["duration"].split()]
_dd = [float(x) for x in _cd["duration"].split()]
check("derived actually changes durations",
      any(abs(a - b) > 0.0005 for a, b in zip(_dv, _dd)),
      str(list(zip(_dv, _dd))))
check("derived chain-sum == time span",
      abs(sum(_dd) - _cd["time"][1] / 1000.0) <= 0.005, str(sum(_dd)))
check("result records the mode", _rv.get("durations") == "verbatim"
      and _rd.get("durations") == "derived", f"{_rv.get('durations')}/{_rd.get('durations')}")
try:
    sx.author_score(_dl, durations="nope")
    check("unknown durations mode raises", False, "no raise")
except ValueError:
    check("unknown durations mode raises", True)

# ── apply_note_floor: raise sub-floor sung notes, preserve the total timeline ───────────
FLOOR_CLIP = {"index": "t_0_800", "language": "English", "time": [0, 800],
              "duration": "0.30 0.06 0.20 0.04 0.20", "text": "a b c d e",
              "phoneme": "en_AH1 en_B en_S en_D en_IY1", "note_pitch": "60 62 60 62 60",
              "note_type": "2 2 1 2 2"}   # index 2 is a REST (0.20s)

check("floor 0 is byte-identical (the shipped-default contract)",
      sx.apply_note_floor(FLOOR_CLIP, 0.0) == FLOOR_CLIP)

fl = sx.apply_note_floor(FLOOR_CLIP, 0.15)
fd = [float(x) for x in fl["duration"].split()]
check("floor raises the 0.06s sung note to >= 0.15s", fd[1] >= 0.1499, str(fd))
check("floor raises the 0.04s sung note to >= 0.15s", fd[3] >= 0.1499, str(fd))
check("floor preserves the TOTAL timeline (borrowed, not invented)",
      abs(sum(fd) - 0.80) < 1e-3, f"sum={sum(fd):.4f}")
check("floor borrows from the adjacent REST first (the rest at idx2 shrinks)",
      fd[2] < 0.20, f"rest now {fd[2]:.3f}")
check("floor never pushes a donor sung note below the floor",
      all(fd[i] >= 0.1499 for i in (0, 1, 3, 4)), str(fd))
check("apply_note_floor is pure (input clip untouched)", FLOOR_CLIP["duration"] == "0.30 0.06 0.20 0.04 0.20")

# _clean folds diacritics instead of deleting the letter — "piñata" must reach the
# pronouncer as "pinata" (the bare strip produced "piata": the N vanished from the sung
# phonemes, the owner's stage9orsum "nonsense word"). Venv-independent (pure string).
check("_clean folds ñ: piñata -> pinata", sx._clean("piñata") == "pinata", sx._clean("piñata"))
check("_clean identity on ASCII (apostrophes kept)", sx._clean("'Bout") == "'bout")
check("_clean deterministic", sx._clean("piñata") == sx._clean("piñata"))

# author_score(note_floor_s=) is off by default → byte-identical to the plain call
_base = sx.author_score(LINES) if "LINES" in dir() else None
if _base and _base.get("ok"):
    _f0 = sx.author_score(LINES, note_floor_s=0.0)
    check("author_score note_floor_s=0 leaves the score byte-identical",
          _f0["score"] == _base["score"])

if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print("\nOK: 0 failure(s)")
