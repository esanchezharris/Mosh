#!/usr/bin/env python3
"""Goldens for the SoulX-convention segmentation (word_segments) — pure, no audio/venv.

Run:  python3 scripts/fms-killshot/bench_soulx_author_test.py   (exit 0 = all pass)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_soulx_author as bsa  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def _midi_hz(m):
    return 440.0 * 2 ** ((m - 69) / 12.0)


def contour(spans, hop=0.01):
    """[(dur_s, midi), ...] -> f0 frames [(t, hz, voiced)] at `hop`, starting t=0."""
    out, t = [], 0.0
    for dur, m in spans:
        n = int(dur / hop)
        for _ in range(n):
            out.append((round(t, 4), _midi_hz(m), 1))
            t += hop
    return out


# ── one steady pitch across the whole word => ONE note (SoulX whole-word convention) ────
f0 = contour([(0.5, 60)])          # C4 held 0.5s
segs = bsa.word_segments(f0, 0.0, 0.5, 0.0)
check("steady pitch -> a single whole-word note", len(segs) == 1, str(segs))
check("the note spans the whole word", segs[0]["start"] == 0.0 and abs(segs[0]["end"] - 0.5) < 0.02)
check("the note carries the sung pitch", segs[0]["pitch"] == 60)

# ── a genuine, sustained step within the word => TWO notes (a real melisma) ──────────────
f0 = contour([(0.3, 60), (0.3, 64)])   # C4 then a sustained major-3rd up
segs = bsa.word_segments(f0, 0.0, 0.6, 0.0)
check("a sustained pitch step splits into two notes", len(segs) == 2, str(segs))
check("the two notes carry the two pitches", [s["pitch"] for s in segs] == [60, 64], str(segs))
check("the split lands near the step (~0.3s)", abs(segs[1]["start"] - 0.3) < 0.03, str(segs))
check("segments tile the word with no gap",
      abs(segs[0]["end"] - segs[1]["start"]) < 1e-6 and segs[0]["start"] == 0.0
      and abs(segs[-1]["end"] - 0.6) < 0.02)

# ── vibrato / small wobble must NOT split (below the step threshold) ────────────────────
f0 = contour([(0.1, 60), (0.1, 61), (0.1, 60), (0.1, 61), (0.1, 60)])   # ±1 st wobble
segs = bsa.word_segments(f0, 0.0, 0.5, 0.0)
check("a sub-threshold wobble stays ONE note (no ornament over-splitting)",
      len(segs) == 1, str(segs))

# ── a brief blip that does not HOLD must not split ──────────────────────────────────────
f0 = contour([(0.25, 60), (0.03, 66), (0.25, 60)])   # a 30ms spike up then back
segs = bsa.word_segments(f0, 0.0, 0.53, 0.0)
check("an un-sustained blip does not split (min_hold gate)", len(segs) == 1, str(segs))

# ── max_segs caps splitting at the syllable count ───────────────────────────────────────
f0 = contour([(0.15, 60), (0.15, 64), (0.15, 60), (0.15, 64)])   # 3 real steps
segs = bsa.word_segments(f0, 0.0, 0.6, 0.0, max_segs=2)
check("max_segs caps a word at its syllable count", len(segs) == 2, str(segs))
segs_uncapped = bsa.word_segments(f0, 0.0, 0.6, 0.0)
check("uncapped, the same contour splits further (cap is doing work)",
      len(segs_uncapped) > 2, str(segs_uncapped))

# ── unvoiced word (no F0) => one default-pitch note, never a crash ──────────────────────
segs = bsa.word_segments([], 0.0, 0.4, 0.0, default_pitch=57)
check("no F0 -> one whole-word note at the default pitch",
      segs == [{"start": 0.0, "end": 0.4, "pitch": 57}], str(segs))

# ── t0 offset is applied (clip-relative clock) ──────────────────────────────────────────
f0 = contour([(0.5, 60)])
for i in range(len(f0)):
    f0[i] = (round(f0[i][0] + 2.0, 4), f0[i][1], 1)   # shift the whole contour to t=2.0
segs = bsa.word_segments(f0, 2.0, 2.5, 2.0)
check("t0 offset makes the segment clip-relative (starts at 0)",
      segs[0]["start"] == 0.0 and abs(segs[0]["end"] - 0.5) < 0.02, str(segs))

# ── fill_unvoiced_pitches: an unvoiced word inherits a NEIGHBOUR, never a constant ──────
SL = [{"pitch": 48, "segments": [{"pitch": 48}]},
      {"pitch": None, "segments": [{"pitch": None}]},
      {"pitch": 50, "segments": [{"pitch": 50}]}]
fu = bsa.fill_unvoiced_pitches(SL)
check("unvoiced word takes the PREVIOUS word's pitch", fu[1]["pitch"] == 48, str(fu[1]))
check("its segments are filled too", fu[1]["segments"][0]["pitch"] == 48)
check("voiced words untouched", fu[0]["pitch"] == 48 and fu[2]["pitch"] == 50)
check("leading unvoiced word looks AHEAD",
      bsa.fill_unvoiced_pitches([{"pitch": None, "segments": []}, {"pitch": 44, "segments": []}])[0]["pitch"] == 44)
check("all-unvoiced falls back to the default, not a crash",
      bsa.fill_unvoiced_pitches([{"pitch": None, "segments": []}])[0]["pitch"] == 57)
check("fill does not mutate the caller's slots", SL[1]["pitch"] is None)
check("word_segments(default_pitch=None) marks unvoiced as None for the filler",
      bsa.word_segments([], 0.0, 0.4, 0.0, default_pitch=None)[0]["pitch"] is None)

# ── chain_long_segments: long notes -> same-pitch continuation chains ───────────────────
segs = [{"start": 0.0, "end": 1.0, "pitch": 60}]
ch = bsa.chain_long_segments(segs, 0.45)
check("a 1.0s note chains into 3 pieces at max 0.45", len(ch) == 3, str(ch))
check("chain pieces tile exactly (no gap, exact end)",
      ch[0]["start"] == 0.0 and ch[-1]["end"] == 1.0
      and all(abs(ch[k]["end"] - ch[k + 1]["start"]) < 1e-9 for k in range(len(ch) - 1)), str(ch))
check("chain pieces keep the pitch", all(c["pitch"] == 60 for c in ch))
check("a short note is untouched",
      bsa.chain_long_segments([{"start": 0.0, "end": 0.4, "pitch": 60}], 0.45)
      == [{"start": 0.0, "end": 0.4, "pitch": 60}])
check("max_s=0 is the identity (default off)",
      bsa.chain_long_segments(segs, 0.0) is segs)
check("an exact-length note does not split (no epsilon sliver)",
      len(bsa.chain_long_segments([{"start": 0.0, "end": 0.45, "pitch": 60}], 0.45)) == 1)
check("None pitch survives chaining (filler back-fills later)",
      all(c["pitch"] is None for c in
          bsa.chain_long_segments([{"start": 0.0, "end": 1.0, "pitch": None}], 0.45)))

# ── take_voiced_frac: the chain gate asks whether the SINGER sang through ───────────────
VF = [(round(0.01 * i, 4), 220.0, 1) for i in range(50)] + \
     [(round(0.01 * i, 4), 0.0, 0) for i in range(50, 100)]
check("fully-voiced span reads 1.0", bsa.take_voiced_frac(VF, 0.0, 0.5) == 1.0)
check("fully-unvoiced span reads 0.0", bsa.take_voiced_frac(VF, 0.5, 1.0) == 0.0)
check("half-voiced span reads 0.5", abs(bsa.take_voiced_frac(VF, 0.25, 0.75) - 0.5) < 0.03)
check("no frames -> 0.0 (never chains on no evidence)", bsa.take_voiced_frac(VF, 2.0, 3.0) == 0.0)

# ── enforce_word_budgets: the lyric self-enforces its syllable count ────────────────────
NS = {"pinata": 3, "my": 1, "whole": 1}.get


def _ns(w):
    return NS(w) or 1


# 3-syllable word given only 0.40s; the take pauses after it until the next word at 1.30
WB = [{"word": "pinata", "start": 0.0, "end": 0.40, "phrase": 1},
      {"word": "my", "start": 1.30, "end": 1.45, "phrase": 1}]
got = bl_ = bsa.enforce_word_budgets(WB, _ns, 0.22, 9.0)
check("under-budget word claims the following gap",
      got[0].get("budgeted") is True and abs(got[0]["end"] - 0.66) < 1e-6, str(got[0]))
check("budget claim never moves a start", got[1]["start"] == 1.30)
# claim is capped by the next word's start minus keep_rest_s
WB2 = [{"word": "pinata", "start": 0.0, "end": 0.40, "phrase": 1},
       {"word": "my", "start": 0.50, "end": 0.65, "phrase": 1}]
got = bsa.enforce_word_budgets(WB2, _ns, 0.22, 9.0)
check("claim caps at next start - keep_rest_s", abs(got[0]["end"] - 0.45) < 1e-6, str(got[0]))
# claim is capped by claim_cap_s
WB3 = [{"word": "pinata", "start": 0.0, "end": 0.10, "phrase": 1},
       {"word": "my", "start": 2.0, "end": 2.15, "phrase": 1}]
got = bsa.enforce_word_budgets(WB3, _ns, 0.22, 9.0)
check("claim caps at claim_cap_s (0.30)", abs(got[0]["end"] - 0.40) < 1e-6, str(got[0]))
# a phrase boundary is a breath: never claimed across
WB4 = [{"word": "pinata", "start": 0.0, "end": 0.40, "phrase": 1},
       {"word": "my", "start": 1.30, "end": 1.45, "phrase": 2}]
got = bsa.enforce_word_budgets(WB4, _ns, 0.22, 9.0)
check("never claims across a phrase boundary", "budgeted" not in got[0], str(got[0]))
# the last word of the window claims up to t1
got = bsa.enforce_word_budgets([{"word": "pinata", "start": 0.0, "end": 0.40, "phrase": 1}],
                               _ns, 0.22, 0.55)
check("last word claims only up to t1", abs(got[0]["end"] - 0.55) < 1e-6, str(got[0]))
# a word already at budget is untouched; phrase-less (NUS) words never claim
got = bsa.enforce_word_budgets([{"word": "my", "start": 0.0, "end": 0.30, "phrase": 1},
                                {"word": "whole", "start": 1.0, "end": 1.3, "phrase": 1}],
                               _ns, 0.22, 9.0)
check("at-budget words untouched", all("budgeted" not in w for w in got), str(got))
check("phrase-less words never claim (NUS lane byte-identical)",
      "budgeted" not in bsa.enforce_word_budgets(
          [{"word": "pinata", "start": 0.0, "end": 0.1}], _ns, 0.22, 9.0)[0])
check("sylBudgetS=0 is the identity",
      bsa.enforce_word_budgets(WB, _ns, 0.0, 9.0) == WB)
check("budgets do not mutate the caller's words", WB[0]["end"] == 0.40)

# ── snap_and_resync: commanded pitches snap to the song key, slot pitch follows ─────────
SLOTS = [{"start": 0.0, "end": 0.5, "pitch": 61,
          "segments": [{"start": 0.0, "end": 0.5, "pitch": 61}]}]   # C#4 in B major? no ->
got = bsa.snap_and_resync(SLOTS, "C major")                          # C#4 off C-major scale
check("off-key segment pitch snaps to the scale", got[0]["segments"][0]["pitch"] in (60, 62),
      str(got[0]))
check("slot pitch re-syncs from segments[0]", got[0]["pitch"] == got[0]["segments"][0]["pitch"])
check("snap ties resolve UP (61 -> 62 in C major)", got[0]["segments"][0]["pitch"] == 62)
got = bsa.snap_and_resync([{"start": 0, "end": 1, "pitch": 64,
                            "segments": [{"start": 0, "end": 1, "pitch": 64}]}], "C major")
check("in-key pitch unchanged", got[0]["segments"][0]["pitch"] == 64)
check("snap does not mutate the caller's slots", SLOTS[0]["segments"][0]["pitch"] == 61)

# ── determinism ─────────────────────────────────────────────────────────────────────────
import hashlib  # noqa: E402
import json  # noqa: E402
f0 = contour([(0.3, 60), (0.3, 64)])
det = {hashlib.sha256(json.dumps(bsa.word_segments(f0, 0.0, 0.6, 0.0), sort_keys=True).encode()).hexdigest()
       for _ in range(3)}
check("word_segments deterministic (3x)", len(det) == 1)

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
