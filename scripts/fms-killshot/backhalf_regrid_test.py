#!/usr/bin/env python3
"""Golden tests for the re-grid detectors (grid audit round).

The shipped grid derives syllable EXISTENCE from Basic Pitch notes and can only
REMOVE from there — on the soft back-half mumble it under-counts (90 slots vs ~114
envelope peaks / ~130 ASR syllables) and the owner hears "pretty much all off".
Candidate E derives nuclei from the energy envelope (gate attacks + dips between
peaks); candidate F fuses E ∪ Basic-Pitch onsets ∪ ASR syllable anchors with
witness voting. Both emit lineScores-shaped slots so all downstream machinery
works unchanged.

Run:  python3 scripts/fms-killshot/backhalf_regrid_test.py   (exit 0 = pass)
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "service"))

import backhalf_regrid as rg  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


HOP = 0.01


def env_from(spec):
    """Build a 10ms-hop envelope from [(duration_s, level), ...]."""
    env = []
    for dur, lvl in spec:
        env += [lvl] * int(round(dur / HOP))
    return env


# ── fixture: one voiced span holding THREE syllables ───────────────────────────────────
# syllable 1 loud (0.60), dip, syllable 2 SOFT (0.22 — Basic Pitch would miss it),
# dip, syllable 3 (0.55) sliding into a MELISMA tail (no dip, continuous energy);
# then silence; then a 30ms breath spike (shorter than the gate's min span).
ENV = env_from([
    (0.30, 0.001),          # leading silence
    (0.20, 0.60),           # syl 1
    (0.06, 0.10),           # dip (consonant trough)
    (0.20, 0.22),           # syl 2 — soft
    (0.06, 0.08),           # dip
    (0.20, 0.55),           # syl 3
    (0.25, 0.50),           # melisma tail: continuous energy, NO dip
    (0.40, 0.001),          # silence
    (0.03, 0.45),           # breath spike (< MIN_SPAN_S)
    (0.30, 0.001),
])

nuc = rg.detect_e(ENV, HOP, f0=None, notes=[])
starts = [round(s["start"], 2) for s in nuc]
check("E finds exactly the three true syllables", len(nuc) == 3, f"starts={starts}")
check("the SOFT syllable is found (the Basic-Pitch miss class)",
      any(0.50 <= s <= 0.60 for s in starts), f"starts={starts}")
check("the melisma tail does NOT split (no dip = same syllable)",
      not any(s > 0.95 for s in starts), f"starts={starts}")
check("the breath spike is rejected (gate min-span)",
      not any(s > 1.5 for s in starts), f"starts={starts}")
check("slots carry the lineScores shape",
      all(set(s) >= {"start", "end", "velocity", "segments"} for s in nuc), str(nuc[:1]))
check("velocity scales with loudness (soft syllable quieter)",
      nuc[1]["velocity"] < nuc[0]["velocity"],
      f"{[s['velocity'] for s in nuc]}")

# pitch attachment: an F0 contour over syllable 1 lands as its segment pitch
F0 = [{"t": 0.30 + i * 0.01, "hz": 220.0} for i in range(20)]   # A3 = MIDI 57
nuc_p = rg.detect_e(ENV, HOP, f0=F0, notes=[])
check("median F0 attaches as the nucleus pitch",
      nuc_p[0]["segments"][0]["pitch"] == 57, str(nuc_p[0]["segments"]))
check("nuclei without F0 coverage fall back to a neighbor/default pitch",
      isinstance(nuc_p[2]["segments"][0]["pitch"], int), str(nuc_p[2]["segments"]))

# ── fusion voting ──────────────────────────────────────────────────────────────────────
# E bounds are the precise spine (a real E nucleus starts AT the span attack); BP/ASR
# extras only ADD splits when they are far from every energy bound, outside the span's
# attack-lag shadow, and backed by >=2 witnesses or voiced audio.
VENV = env_from([(0.9, 0.001), (0.4, 0.5), (0.9, 0.001)])   # voiced only ~0.9-1.3
E_N = [{"start": 0.90, "end": 1.30, "velocity": 90,
        "segments": [{"start": 0.90, "end": 1.30, "pitch": 57}]}]
BP = [{"start": 0.98, "end": 1.18, "pitch": 57, "velocity": 80}]     # late attack echo
WORDS = [{"word": "la", "start": 1.00, "end": 1.15, "conf": 0.8, "syl": 1},
         {"word": "gone", "start": 2.00, "end": 2.10, "conf": 0.6, "syl": 1}]   # lone, silent
fused = rg.detect_f(VENV, HOP, e_nuclei=E_N, notes=BP, words=WORDS)
fstarts = [round(s["start"], 2) for s in fused]
check("late witnesses of the attack do NOT split (ONE nucleus)",
      len([s for s in fstarts if s < 1.5]) == 1, str(fstarts))
check("a lone ASR anchor in silence is dropped", not any(s >= 1.9 for s in fstarts), str(fstarts))
lone_e = rg.detect_f(VENV, HOP, e_nuclei=E_N, notes=[], words=[])
check("a lone energy nucleus in VOICED audio survives", len(lone_e) == 1, str(lone_e))
# a LONE extra never splits — spans are voiced by definition, so "voiced" is not
# corroboration (the lone-accept rule ballooned the real take to 267 splits)
lone_bp = rg.detect_f(VENV, HOP, e_nuclei=E_N,
                      notes=[{"start": 1.15, "end": 1.28, "pitch": 59, "velocity": 80}],
                      words=[])
check("a lone BP onset in voiced audio does NOT split", len(lone_bp) == 1,
      str([round(s['start'], 2) for s in lone_bp]))
# the fusion VALUE-ADD: agreeing witnesses far from any energy bound split a dip-less span
BP2 = [{"start": 1.14, "end": 1.28, "pitch": 59, "velocity": 80}]
W2 = [{"word": "day", "start": 1.16, "end": 1.28, "conf": 0.8, "syl": 1}]
added = rg.detect_f(VENV, HOP, e_nuclei=E_N, notes=BP2, words=W2)
check("agreeing far witnesses ADD a split E's dips missed", len(added) == 2,
      str([round(s['start'], 2) for s in added]))

# ── determinism ────────────────────────────────────────────────────────────────────────
def dig():
    a = rg.detect_e(ENV, HOP, f0=F0, notes=[])
    b = rg.detect_f(VENV, HOP, e_nuclei=E_N, notes=BP, words=WORDS)
    return hashlib.sha256(json.dumps([a, b], sort_keys=True).encode()).hexdigest()


check("detectors are deterministic (3x)", len({dig() for _ in range(3)}) == 1)

# ── truth_slots v2 (audit round): GLOBAL onsets, envelope-trimmed ends, melisma ────────
# The v1 builder inherited the OLD grid's phrase windows (a slot could span a real rest;
# marks past an old edge could overlap the next phrase). v2: slots come from the global
# onset list; each end trims to the last VOICED frame before the next onset (rests
# emerge from the audio); segments re-derive from F0 (melisma glides return).
def _ls(bar, slots):
    return {"v": 1, "bar": bar, "bpm": 138.0, "timeSig": [4, 4], "grid": "1/16", "slots": slots}


def _slot(a, b):
    return {"start": a, "end": b, "velocity": 80, "kind": "gap",
            "segments": [{"start": a, "end": b, "pitch": 57}]}


# OLD grid wrongly merged across a real rest: one old slot spans 0.30-1.50 (through the
# 0.90-1.40 silence), so the OLD phrase window is 0.30-1.70. Second phrase 2.50-2.90.
TS_SKEL = {"lineScores": [_ls(0, [_slot(0.30, 1.50), _slot(1.50, 1.70)]),
                          _ls(1, [_slot(2.50, 2.70), _slot(2.70, 2.90)])],
           "lines": [], "lineHeard": []}
TS_ENV = env_from([(0.30, 0.001), (0.60, 0.5),            # voiced 0.30-0.90
                   (0.50, 0.001), (0.30, 0.5),            # REST 0.90-1.40, voiced 1.40-1.70
                   (0.80, 0.001), (0.40, 0.5), (0.30, 0.001)])   # voiced 2.50-2.90
# F0: A3 through 0.30-0.42, then a sustained +3st step to C4 through 0.55 (melisma inside
# slot 1), plain A3 elsewhere it is voiced
TS_F0 = ([{"t": round(0.30 + i * 0.01, 3), "hz": 220.0} for i in range(12)]
         + [{"t": round(0.42 + i * 0.01, 3), "hz": 261.63} for i in range(13)]
         + [{"t": round(0.55 + i * 0.01, 3), "hz": 220.0} for i in range(35)]
         + [{"t": round(1.40 + i * 0.01, 3), "hz": 220.0} for i in range(30)])
TS_EV = {"hopS": HOP, "env": TS_ENV, "notes": [], "f0": TS_F0}

# marks: 3 in the (old) first window — incl. one whose next onset is far PAST the rest —
# and 2 in the second window
GT = {"phrases": {"0": [0.30, 0.55, 1.40], "1": [2.50, 2.72]}}
warns = []
tslots = rg.truth_slots(TS_EV, TS_SKEL, GT, warns=warns)
check("one slot per owner onset (3 + 2)", len(tslots) == 5, str(len(tslots)))
check("slot starts ARE the owner's onsets",
      [round(s["start"], 2) for s in tslots] == [0.30, 0.55, 1.40, 2.50, 2.72],
      str([round(s["start"], 2) for s in tslots]))
check("a slot NEVER spans a rest: the 0.55 slot trims to the voiced end (~0.90)",
      abs(tslots[1]["end"] - 0.90) <= 0.03, str(tslots[1]["end"]))
check("the rest EMERGES between slots (gap >= 0.35s for phrase re-derivation)",
      tslots[2]["start"] - tslots[1]["end"] >= 0.35,
      f"gap={tslots[2]['start'] - tslots[1]['end']:.2f}")
check("no slot overlaps the next (global ordering holds)",
      all(tslots[i]["end"] <= tslots[i + 1]["start"] + 1e-6 for i in range(len(tslots) - 1)))
check("the 1.40 slot trims to ITS voiced end (~1.70), not the old window edge",
      abs(tslots[2]["end"] - 1.70) <= 0.03, str(tslots[2]["end"]))
# melisma: slot 1 (0.30-0.55) has an F0 step at ~0.42 -> TWO segments, ONE slot
segs = tslots[0]["segments"]
check("melisma re-derives INSIDE the slot (2 segments, 1 slot)", len(segs) == 2, str(segs))
check("segment pitches follow the contour (A3 then C4)",
      segs[0]["pitch"] == 57 and segs[1]["pitch"] == 60, str(segs))
check("plain slots keep one segment", len(tslots[2]["segments"]) == 1, str(tslots[2]["segments"]))
check("velocity is in range", all(1 <= s["velocity"] <= 127 for s in tslots))

# REAL-DATA finding (first truth rebuild, 2026-07-12): "last voiced frame before the
# next onset" is wrong when the rest contains an UNMARKED breath hump (measured: a
# 0.09-level breath at 4.44s dragged a slot across a 510ms true rest → 147 slots, ONE
# phrase). A slot must end at the first SUSTAINED rest (>=100ms below gate) after its
# own voiced run — later humps belong to the gap, not the syllable.
BREATH_ENV = env_from([(0.30, 0.001), (0.30, 0.5),   # voiced 0.30-0.60
                       (0.50, 0.001),                # TRUE rest 0.60-1.10 (500ms)
                       (0.15, 0.3),                  # unmarked BREATH hump 1.10-1.25
                       (0.15, 0.001),                # dip 1.25-1.40
                       (0.30, 0.5), (0.20, 0.001)])  # next syllable 1.40-1.70
BREATH_EV = {"hopS": HOP, "env": BREATH_ENV, "notes": [], "f0": []}
bs = rg.truth_slots(BREATH_EV, TS_SKEL, {"phrases": {"0": [0.30, 1.40]}})
check("a breath hump inside the rest does NOT extend the slot",
      abs(bs[0]["end"] - 0.60) <= 0.03, str(bs[0]["end"]))
check("the rest emerges despite the hump (gap >= 0.35s)",
      bs[1]["start"] - bs[0]["end"] >= 0.35, f"gap={bs[1]['start'] - bs[0]['end']:.2f}")
# a mark a hair EARLY (before the attack) must not end instantly: the rest-hold arms
# only once the slot's voiced run has begun
be = rg.truth_slots(BREATH_EV, TS_SKEL, {"phrases": {"0": [0.20, 1.40]}})
check("an early mark still rides to its voiced end (rest-hold arms after voicing)",
      abs(be[0]["end"] - 0.60) <= 0.03, str(be[0]["end"]))

# each truth slot carries its owner WINDOW id (`phrase`) — the owner confirmed marks
# per annotator page, so membership is his verdict; grouping splits on it downstream
# (legato tails defeat any silence gate — measured: 6 windows merged into one line).
check("truth slots carry the owner phrase id",
      [s.get("phrase") for s in tslots] == [0, 0, 0, 1, 1],
      str([s.get("phrase") for s in tslots]))

# a mark in SILENCE is still truth: it gets a minimal slot, never dropped
gt_sil = {"phrases": {"0": [0.30, 1.00]}}   # 1.00 is inside the 0.90-1.40 rest
sil = rg.truth_slots(TS_EV, TS_SKEL, gt_sil)
check("a silence mark keeps a minimal slot (truth is never dropped)",
      len(sil) == 2 and sil[1]["end"] > sil[1]["start"], str(sil[1] if len(sil) > 1 else sil))

# marks <40ms apart are KEPT but warned (double-click accidents surface, never vanish)
warns2 = []
close_gt = {"phrases": {"0": [0.30, 0.32]}}
close_slots = rg.truth_slots(TS_EV, TS_SKEL, close_gt, warns=warns2)
check("marks <40ms apart are kept", len(close_slots) == 2, str(close_slots))
check("...and warned", len(warns2) >= 1, str(warns2))
check("...and the min-hold never overlaps the NEXT mark's slot",
      close_slots[0]["end"] <= close_slots[1]["start"] + 1e-6,
      str([(s['start'], s['end']) for s in close_slots]))

# unmarked phrases contribute nothing; determinism holds
gt_empty = {"phrases": {"0": [], "1": [2.6]}}
check("an unmarked phrase yields no slots", len(rg.truth_slots(TS_EV, TS_SKEL, gt_empty)) == 1)
check("truth_slots is deterministic (3x)",
      len({hashlib.sha256(json.dumps(rg.truth_slots(TS_EV, TS_SKEL, GT), sort_keys=True).encode()).hexdigest()
           for _ in range(3)}) == 1)

# ── strike-aware rebuild: a struck word never locks verbatim ───────────────────────────
# NOTE the real evidence.json schema: whisper words carry `confidence`, NOT `conf` —
# the first truth render silently zeroed every conf (all keeps demoted to echoes).
SK_EV = {**TS_EV, "words": [{"word": "flame", "start": 0.31, "end": 0.50, "confidence": 0.9, "syl": 1},
                            {"word": "balls", "start": 0.56, "end": 0.80, "confidence": 0.9, "syl": 1}]}
SK_SKEL = {**TS_SKEL,
           "lineHeard": [{"v": 1, "bar": 0,
                          "words": [{"word": "flame", "slot": 0, "conf": 0.9, "kept": True},
                                    {"word": "balls", "slot": 1, "conf": 0.9, "kept": True}]}]}
sk_slots = rg.truth_slots(SK_EV, SK_SKEL, GT)
doc, _ = rg._slots_to_skeleton(sk_slots, SK_SKEL, SK_EV, "truth", None,
                               struck={"balls@0.56": True})
l0 = doc["lines"][0]
check("unstruck kept word still locks into the seed", "flame" in l0["seedText"], l0["seedText"])
check("a STRUCK word never locks verbatim", "balls" not in l0["seedText"], l0["seedText"])
hw = {w["word"]: w for lh in doc["lineHeard"] for w in lh["words"]}
check("the struck word stays as SOUND evidence (kept=False, still heard)",
      hw["balls"]["kept"] is False and hw["flame"]["kept"] is True, str(hw))
check("heard rows carry the REAL whisper confidence (not a zeroed default)",
      hw["flame"]["conf"] == 0.9, str(hw["flame"]))

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
