#!/usr/bin/env python3
"""Author a SoulX target score for a NUS item window using the PRODUCT author_score.

Runs under the phonology venv (cmudict/g2p) so (a) NUS words carry REAL text (reverse-CMUdict,
~65% mapped; the teardown venv has no cmudict → phone-labels) and (b) author_score derives
correct ARPAbet phonemes and spreads them over note_type 2/3 notes — hand-rolling NUS phones
sings the wrong words (ruler-proven 0.042 vs clean 0.377); author_score lands them (0.167).

argv:  in.json {"singer","t0","t1","f0":[[t,hz,voiced],...], "words"?}   out_score.json

`words` is optional: own-pairs items carry their own ground-truth words (Whisper on the
finished take — real text with apostrophes), so they are passed inline. Absent, the NUS
lookup-by-singer path runs exactly as before.
Builds ONE line = one slot per word (segments = the word's syllables, so author_score spreads
the phones over notes), pitch from the clean F0. Prints the true words (real text) as JSON on
stdout's last line so the caller can score word-recovery against them.
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import bench_dataset as bd  # noqa: E402
from soulx.score import author_score  # noqa: E402
import phonology.core as ph  # noqa: E402

_pron = ph.Pronouncer()


def nsyl(word):
    try:
        return max(1, _pron.syllables(word) or 1)
    except Exception:
        return max(1, sum(word.lower().count(v) for v in "aeiou") or 1)


def _midi(hz):
    return int(round(69 + 12 * math.log2(hz / 440.0))) if hz and hz > 0 else 0


def _pitch(f0, a, b):
    hz = sorted(h for t, h, v in f0 if a <= t < b and v and h > 0)
    return _midi(hz[len(hz) // 2]) if hz else 0


def _med(xs):
    s = sorted(xs)
    return s[len(s) // 2] if s else 0.0


def fill_unvoiced_pitches(slots, fallback=57):
    """Replace None pitches (words where pyin found no voiced frames) with the NEAREST
    measured neighbour's pitch — previous word first, else the next one, else `fallback`.

    Round-0 oracle finding: the old hardcoded default (57 = A3) commanded notes up to
    ~9 st above the singer's actual line in his low register ("tough": take C3, commanded
    A3 — and the model OBEYED the wrong command). A singer's unvoiced word sits in the
    phrase's register, not on a constant. Pure; mutates copies."""
    out = [dict(s2) for s2 in slots]
    n = len(out)
    for i, sl in enumerate(out):
        if sl.get("pitch") is not None:
            continue
        pick = None
        for j in range(i - 1, -1, -1):
            if out[j].get("pitch") is not None:
                pick = out[j]["pitch"]
                break
        if pick is None:
            for j in range(i + 1, n):
                if slots[j].get("pitch") is not None:
                    pick = slots[j]["pitch"]
                    break
        sl["pitch"] = pick if pick is not None else fallback
        for g in sl.get("segments") or []:
            if g.get("pitch") is None:
                g["pitch"] = sl["pitch"]
    return out


def enforce_word_budgets(words, nsyl_fn, syl_floor_s, t1, *, claim_cap_s=0.30,
                         keep_rest_s=0.05):
    """The lyric self-enforces its syllable count (owner, stage9orsum round).

    A word's minimum time = nsyl(word) x syl_floor_s. Forced alignment under-times words
    whose final syllable is sung QUIETLY (quiet singing is still singing) — the score then
    crams the syllables into too little time and the word warps. An under-budget word
    extends its END into the FOLLOWING gap, bounded by: the deficit, `claim_cap_s`, the
    next word's start minus `keep_rest_s`, and the window end `t1`.

    "If it makes sense with the melody": a claim never crosses a PHRASE boundary — a
    phrase break is a breath. Words without phrase keys (the NUS lane) never claim, so
    that path stays byte-identical. Pure; input not mutated; starts never move."""
    if not words or not syl_floor_s or syl_floor_s <= 0:
        return [dict(w) for w in words or []]
    out = [dict(w) for w in words]
    for i, w in enumerate(out):
        s, e = float(w.get("start", 0.0)), float(w.get("end", 0.0))
        deficit = nsyl_fn(str(w.get("word", ""))) * syl_floor_s - (e - s)
        if deficit <= 0 or w.get("phrase") is None:
            continue
        if i + 1 < len(out):
            nxt = out[i + 1]
            if nxt.get("phrase") != w.get("phrase"):
                continue                       # a breath: never claimed
            room = float(nxt.get("start", e)) - keep_rest_s - e
        else:
            room = float(t1) - e
        claim = min(deficit, claim_cap_s, max(0.0, room))
        if claim > 1e-6:
            w["end"] = round(e + claim, 4)
            w["budgeted"] = True
    return out


def take_voiced_frac(f0, a, b):
    """Fraction of [a,b) f0 frames that are voiced (absolute clock). No frames -> 0."""
    n = v = 0
    for t, h, vo in f0:
        if a <= t < b:
            n += 1
            v += 1 if (vo and h and h > 0) else 0
    return v / n if n else 0.0


def snap_and_resync(slots, key):
    """Snap every segment pitch to the song KEY (verbatim reuse of the ear-certified
    flowfit.snap_slots_to_key — relative-key aware, ties UP) and re-sync each slot's
    top-level pitch from its first segment. Must run AFTER fill_unvoiced_pitches (the
    snapper does int(pitch)). Pure."""
    from soulx.flowfit import snap_slots_to_key
    out = snap_slots_to_key(slots, key)
    for sl in out:
        if sl.get("segments"):
            sl["pitch"] = sl["segments"][0]["pitch"]
    return out


def chain_long_segments(segs, max_s):
    """Split any segment longer than `max_s` into equal SAME-PITCH pieces.

    author_score renders a multi-segment slot as note_type-3 continuations — the melisma
    mechanism V4b proved holds voicing CONTINUOUSLY across a chain. A single long note is
    where SoulX decays its tail toward silence (lineup instrument on round 3: 26 of 27
    missing spans were QUIET-SING, overwhelmingly @TAIL). The same total duration as a
    continuation chain is an in-distribution "keep singing" command. 0/None = off, input
    returned unchanged. Pure."""
    if not max_s or max_s <= 0:
        return segs
    out = []
    for sg in segs:
        dur = sg["end"] - sg["start"]
        if dur <= max_s:
            out.append(sg)
            continue
        n = int(math.ceil(dur / max_s - 1e-9))
        step = dur / n
        for k in range(n):
            out.append({"start": round(sg["start"] + k * step, 4),
                        "end": sg["end"] if k == n - 1 else round(sg["start"] + (k + 1) * step, 4),
                        "pitch": sg["pitch"]})
    return out


def syllable_stress_weights(word):
    """Per-syllable stress weights via the pronouncer: primary 1.5, secondary 1.25,
    unstressed 1.0. Empty list when phones are unavailable (no re-deal signal). Pure."""
    try:
        phones = _pron.phones(word)
        groups = ph.syllabify_phones(phones) if phones else None
    except Exception:
        groups = None
    if not groups:
        return []
    out = []
    for g in groups:
        d = next((p[-1] for p in g if p and p[-1].isdigit()), "0")
        out.append(1.5 if d == "1" else 1.25 if d == "2" else 1.0)
    return out


def redeal_segments(segs, weights, f0, t0, *, floor_s=0.12):
    """L1 (word campaign): stress-weighted within-word duration re-deal.

    `word_segments` cuts at F0 steps, and a passing glide can leave a sub-floor sliver
    that the 1:1 syllable dealing then hands the STRESSED syllable (the pinata stress
    inversion — 40 ms for N-AA1 while the unstressed syllables hold ~0.28 s). When any
    segment is sub-floor, re-deal the word's whole span across its segments by syllable
    stress: soft floor per segment (proportional fallback if the span can't afford
    n*floor), ORDER PRESERVED, span exact. Segment pitches re-measure from the take F0
    over the new spans (per-index fallback where F0 is silent). This deliberately keeps
    n_segments == n_syllables — merging the sliver away would drop the word into
    _slot_phonemes' surplus-fold branch, the B2.1 cram class. Fires only on a 1:1
    weights/segments match; floor_s<=0 or a healthy word returns the input. Pure."""
    if floor_s <= 0 or len(segs) < 2 or len(weights) != len(segs):
        return segs
    if min(sg["end"] - sg["start"] for sg in segs) >= floor_s:
        return segs
    span = segs[-1]["end"] - segs[0]["start"]
    n, wsum = len(segs), float(sum(weights))
    if span >= n * floor_s:
        extra = span - n * floor_s
        durs = [floor_s + extra * w / wsum for w in weights]
    else:
        durs = [span * w / wsum for w in weights]
    out, cur, acc = [], segs[0]["start"], segs[0]["start"]
    for k, d in enumerate(durs):
        acc += d
        end = segs[-1]["end"] if k == n - 1 else round(acc, 4)
        pitch = _pitch(f0, t0 + cur, t0 + end) or segs[k]["pitch"]
        out.append({"start": round(cur, 4), "end": end, "pitch": pitch})
        cur = end
    return out


def word_segments(f0, s, e, t0, *, min_step_st=1.5, min_hold_s=0.12, max_segs=None,
                  default_pitch=57):
    """SoulX-convention segmentation of ONE word's span into notes.

    SoulX's shipped scores ride a whole WORD on one note ("beautiful" = 8 phonemes / 1 note);
    the previous bench author forced `nsyl(word)` equal syllable notes, which is out of
    distribution (mechanism-verify V4a) and drops consonants. This returns ONE segment
    (whole word, one note) UNLESS the take's own F0 genuinely steps within the word — then it
    splits at the step, a real melisma, which is the V4b-proven note_type=3 mechanism.

    A step is a sustained (>= min_hold_s) pitch change of >= min_step_st semitones from the
    current segment's median. `max_segs` (the syllable count) caps how finely a word may
    split — keeping only the largest steps — so ornament noise can never exceed the word's
    syllables. Times returned on the t0-relative clock. Pure."""
    pts = [(t, 69.0 + 12.0 * math.log2(h / 440.0))
           for (t, h, v) in f0 if s <= t < e and v and h > 0]
    if not pts:
        # default_pitch=None => the caller back-fills from neighbours (fill_unvoiced_pitches)
        return [{"start": round(s - t0, 4), "end": round(e - t0, 4), "pitch": default_pitch}]

    times = [p[0] for p in pts]
    midis = [p[1] for p in pts]
    # collect candidate cut points: (frame index, jump size) where a new level sustains
    cuts = []
    seg_start = 0
    i = 1
    while i < len(pts):
        cur = _med(midis[seg_start:i])
        if abs(midis[i] - cur) >= min_step_st:
            j = i
            while j < len(pts) and times[j] - times[i] < min_hold_s:
                j += 1
            if abs(_med(midis[i:max(j, i + 1)]) - cur) >= min_step_st:
                cuts.append((i, abs(_med(midis[i:max(j, i + 1)]) - cur)))
                seg_start = i
        i += 1

    if max_segs is not None and len(cuts) > max_segs - 1:
        keep = sorted(sorted(cuts, key=lambda c: -c[1])[:max(0, max_segs - 1)])
        cuts = keep
    bounds = [0] + [c[0] for c in cuts] + [len(pts)]

    out = []
    for k in range(len(bounds) - 1):
        a, b = bounds[k], bounds[k + 1]
        seg_s = s if k == 0 else times[a]
        seg_e = e if k == len(bounds) - 2 else times[bounds[k + 1]]
        out.append({"start": round(seg_s - t0, 4), "end": round(seg_e - t0, 4),
                    "pitch": int(round(_med(midis[a:b]) or default_pitch))})
    return out


def main():
    data = json.load(open(sys.argv[1]))
    f0 = [tuple(x) for x in data["f0"]]
    t0, t1 = float(data["t0"]), float(data["t1"])
    if data.get("words") is not None:
        # own-pairs: real ground-truth words travel with the item (may carry apostrophes,
        # which .isalpha() would wrongly reject — normalize curly quotes, keep any word
        # containing a letter). See the apostrophe GOTCHA in the used2 notes.
        src = [dict(w, word=str(w.get("word", "")).replace("’", "'").strip())
               for w in data["words"]]
        words = [w for w in src if w["end"] > t0 and w["start"] < t1
                 and any(c.isalpha() for c in w["word"])]
    else:
        it = bd.nus_items(singers=[data["singer"]], limit=1)[0]
        words = [w for w in it["words"]
                 if w["end"] > t0 and w["start"] < t1 and w["word"].isalpha()]

    convention = str(data.get("convention") or "syllable")
    if convention == "soulx" and float(data.get("sylBudgetS") or 0.0) > 0:
        # the lyric self-enforces its syllable count (quietly-sung tails reclaim time)
        words = enforce_word_budgets(words, nsyl, float(data["sylBudgetS"]), t1)
    slots, texts, audit = [], [], []
    redeal_s = float(data.get("stressRedeal") or 0.0)
    for w in words:
        s, e = max(t0, float(w["start"])), min(t1, float(w["end"]))
        if e - s < 0.05:
            continue
        if convention == "soulx":
            # whole word on one note unless the take's F0 genuinely steps (a real melisma),
            # capped at the word's syllable count. Step/hold thresholds are iterate-loop
            # knobs (defaults preserved when the payload omits them).
            segs = word_segments(f0, s, e, t0, max_segs=nsyl(w["word"]),
                                 min_step_st=float(data.get("melismaStepSt") or 1.5),
                                 min_hold_s=float(data.get("melismaHoldS") or 0.12),
                                 default_pitch=None)
            # L1 (word campaign): stress-weighted within-word re-deal — knob-gated,
            # fires only on a 1:1 syllable/segment match with a sub-floor sliver.
            ws_stress = syllable_stress_weights(w["word"]) if redeal_s > 0 else []
            pre = segs
            if redeal_s > 0 and len(ws_stress) == len(segs):
                segs = redeal_segments(segs, ws_stress, f0, t0, floor_s=redeal_s)
            # L3 audit (always-on diagnostic): the singability geometry per word
            sdurs = [round(sg["end"] - sg["start"], 4) for sg in segs]
            si = ws_stress.index(max(ws_stress)) if ws_stress and len(ws_stress) == len(segs) else None
            audit.append({"word": w["word"], "nSyl": nsyl(w["word"]), "nSegs": len(segs),
                          "minSegS": min(sdurs), "stressSegS": sdurs[si] if si is not None else None,
                          "redealt": segs is not pre})
            # sustain-chain: long notes become same-pitch continuation chains so the model
            # is COMMANDED to keep voicing through the tail (absent/0 = off, byte-identical).
            # GATED on the take's own voicing: chain only words the singer sang through —
            # round-6 chained everything and cost stage10's articulation (drop 0.37->0.53,
            # past its take's own 0.42 ruler level); where the take itself decays, the
            # model's natural decay is the right behavior.
            chain_s = float(data.get("sustainChainS") or 0.0)
            gate = float(data.get("chainVoicedGate") or 0.90)
            if chain_s > 0 and take_voiced_frac(f0, s, e) >= gate:
                segs = chain_long_segments(segs, chain_s)
        else:
            n = nsyl(w["word"])
            segs = []
            for j in range(n):
                a, b = s + (e - s) * j / n, s + (e - s) * (j + 1) / n
                p = _pitch(f0, a, b) or _pitch(f0, s, e) or 57
                segs.append({"start": round(a - t0, 4), "end": round(b - t0, 4), "pitch": p})
        slots.append({"start": round(s - t0, 4), "end": round(e - t0, 4),
                      "pitch": segs[0]["pitch"], "segments": segs})
        texts.append(w["word"])
    if convention == "soulx":
        # unvoiced words inherit a NEIGHBOUR's pitch, never a hardcoded register
        slots = fill_unvoiced_pitches(slots)
        for sl in slots:
            sl["pitch"] = sl["segments"][0]["pitch"] if sl.get("segments") else sl["pitch"]
        if data.get("key"):
            # score-side autotune: commanded pitches snap to the song's known key
            slots = snap_and_resync(slots, str(data["key"]))

    if not slots:
        print(json.dumps({"ok": False, "error": "no words in window"}))
        sys.exit(1)
    line = {"text": " ".join(texts), "asserted": True, "score": {"slots": slots}}
    res = author_score([line], durations=str(data.get("durations") or "verbatim"),
                       note_floor_s=float(data.get("noteFloorS") or 0.0))
    if not res.get("ok"):
        print("author_score rejected:", json.dumps(res)[:300])
        sys.exit(1)
    json.dump(res["score"], open(sys.argv[2], "w"), indent=1)
    if audit:
        # L3 singability audit: diagnostic file beside the score, never a mutation
        apath = (sys.argv[2][: -len("_score.json")] + "_audit.json"
                 if sys.argv[2].endswith("_score.json") else sys.argv[2] + ".audit.json")
        json.dump(audit, open(apath, "w"), indent=1)
    clip = res["score"][0] if isinstance(res["score"], list) else res["score"]
    print("events:", len(clip["note_type"].split()))
    print("WORDS " + json.dumps(texts))          # last line: the true words (real text)


if __name__ == "__main__":
    main()
