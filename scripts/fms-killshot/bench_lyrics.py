#!/usr/bin/env python3
"""Replace ASR with the singer's REAL lyrics as the benchmark's word source.

The own-pairs lane called its words "oracle lyrics", but they were Whisper transcribing the
finished take — and in the rendered windows 55% / 27% / 15% of words fell below the 0.6
confidence gate. Measured errors from the owner's own lyrics:

    sang                     Whisper heard          syllables
    "smashing the piñata"    "smashing the pin yet"      +1
    "I rarely sleep"         "I've already sleep"        -1
    "alligator ON my jeans"  "alligator AROUND my..."    -1
    "Helena Bonham"          "hell no bono"              +1
    "worried 'bout 'em"      "worried about em"          -1

That matters beyond wrong sounds: `author_score` allocates roughly ONE NOTE-SLOT PER
SYLLABLE, so a miscounted word REDISTRIBUTES NOTES ACROSS THE BAR. It is a mechanical path
from ASR error to "doesn't match the rhythm of my mumble" — so the words problem and the
rhythm problem may be one problem.

Timings come from FORCED ALIGNMENT of the known words against the finished take (bench_align
/ MMS), not from ASR guessing: we tell it what was sung and ask only *where*. Per-word
alignment scores come back too, so a bad alignment is visible rather than silent.

Lyrics live at <root>/<song>.lyrics.txt, ONE PHRASE PER LINE — the line breaks are the
singer's own phrasing and are kept as phrase boundaries (they also drive window snapping).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Apostrophes: keep them (they carry the elision that fixes syllable counts — "'bout" is one
# syllable, "about" is two). Strip everything else.
_PUNCT = re.compile(r"[^\w'’ñáéíóú]+", re.UNICODE)
_PARENS = re.compile(r"\([^)]*\)")


def normalize_word(w):
    """Lower-case, straighten curly apostrophes, drop stray punctuation, and collapse a
    deliberately elongated spelling ("sheee" -> "shee" -> "she") so the pronouncer can find
    it. The elongation is a melisma the singer wrote in; it belongs to the grid, not the
    dictionary lookup."""
    w = w.replace("’", "'").strip().lower()
    w = _PUNCT.sub("", w)
    w = re.sub(r"(.)\1{2,}", r"\1", w)          # sheee -> she, woahhh -> woah
    return w


def parse_lyrics(text):
    """Lyrics text -> [{"phrase": i, "word": str}]. One line = one phrase (the singer's own
    line breaks). Parenthetical asides are the singer's commentary, not lyrics."""
    out = []
    for i, line in enumerate(text.splitlines()):
        line = _PARENS.sub(" ", line)
        for raw in line.split():
            w = normalize_word(raw)
            if w:
                out.append({"phrase": i, "word": w})
    return out


def close_legato_gaps(words, take_env, sr_hop_s=0.01, quiet_frac=0.10, max_close_s=0.30,
                      sustain_voiced_frac=0.90, sustain_mean_mult=2.0):
    """Close inter-word gaps the singer sang THROUGH, leaving only real rests.

    Forced alignment emits a boundary at every word, but a singer is legato across most of
    them — they only truly stop to breathe. The score author turns each boundary into a
    commanded REST, and the damage is measured: the render came out 31-43% silent while the
    finished take and the mumble both sit at 9-17%, with the authored score commanding
    23-35% silence over 14-16 rest events per window. 45 of those gaps were under 120 ms.

    Rather than pick a threshold, ask the TAKE: if it still has energy across the gap, the
    singer sustained through it, so extend the word to meet the next one. If the take really
    goes quiet, keep the rest — that is a breath and it belongs in the score.

    Gaps LONGER than `max_close_s` get a stricter test instead of a flat refusal: bridge
    only if the take is voiced essentially throughout (>= `sustain_voiced_frac` of frames
    above the gate AND mean >= `sustain_mean_mult` x gate). The flat cap left a 0.71 s
    commanded rest inside a held vowel on stage10 — measured by the lineup instrument as
    `missing@rest`, the exact "silence where there's a sustained" the owner called out. A
    mean test alone is not enough out there: word-edge energy can drag a breath's mean up,
    but a breath cannot keep 90% of its frames voiced.

    `take_env` is an RMS envelope of the finished take at `sr_hop_s` per frame. Pure."""
    if not words:
        return []
    out = [dict(w) for w in sorted(words, key=lambda x: (x.get("start") or 0.0))]
    if not take_env:
        return out
    peak = sorted(take_env)[int(0.95 * (len(take_env) - 1))]
    th = quiet_frac * peak
    for i in range(len(out) - 1):
        a, b = out[i], out[i + 1]
        if a.get("end") is None or b.get("start") is None:
            continue
        gap = b["start"] - a["end"]
        if gap <= 0:
            continue
        i0, i1 = int(a["end"] / sr_hop_s), max(int(b["start"] / sr_hop_s), int(a["end"] / sr_hop_s) + 1)
        seg = take_env[max(0, i0):min(len(take_env), i1)]
        if not seg:
            continue
        mean = sum(seg) / len(seg)
        if gap <= max_close_s:
            bridge = mean >= th                       # the take sang through it -> legato
        else:
            voiced = sum(1 for e in seg if e >= th) / len(seg)
            bridge = voiced >= sustain_voiced_frac and mean >= sustain_mean_mult * th
        if bridge:
            a["end"] = b["start"]
            a["legato"] = True
    return out


def trim_word_ends(words, take_env, sr_hop_s=0.01, quiet_frac=0.10, min_tail_s=0.12,
                   pad_s=0.06, min_word_s=0.05):
    """Pull a word's END back to where the take actually stops voicing.

    Forced alignment can hand a word more span than the singer used — the score then
    commands a NOTE through the take's silence, and the model sings it (measured as
    `spurious@note` by the lineup instrument: the render singing past the take's last
    word). Only a LONG quiet tail (>= `min_tail_s` after a `pad_s` grace) is trimmed, so
    natural soft decays survive; a word with no voiced frames at all is left alone —
    that is alignment junk, not a tail. Pure; input not mutated."""
    if not words or not take_env:
        return [dict(w) for w in words or []]
    peak = sorted(take_env)[int(0.95 * (len(take_env) - 1))]
    th = quiet_frac * peak
    out = []
    for w in words:
        w = dict(w)
        s, e = w.get("start"), w.get("end")
        if s is None or e is None or e - s <= min_word_s:
            out.append(w)
            continue
        i0, i1 = int(s / sr_hop_s), min(len(take_env), int(e / sr_hop_s))
        seg = take_env[max(0, i0):i1]
        last = None
        for j in range(len(seg) - 1, -1, -1):
            if seg[j] >= th:
                last = j
                break
        if last is None:
            out.append(w)                             # wholly quiet: junk, not a tail
            continue
        voiced_end = (max(0, i0) + last + 1) * sr_hop_s + pad_s
        if e - voiced_end >= min_tail_s:
            w["end"] = round(max(voiced_end, s + min_word_s), 4)
            w["trimmed"] = True
        out.append(w)
    return out


def extend_word_ends(words, take_env, sr_hop_s=0.01, quiet_frac=0.10, pad_s=0.04,
                     min_ext_s=0.10, quiet_run_s=0.06):
    """Extend a word's END through take voicing the aligner did not give it.

    MMS aligns phoneme CONTENT; a held vowel's sustain often lands after the aligner's
    word end ("woah" held ~0.3 s past its end on stage10), leaving the sustain inside a
    commanded rest — `missing@rest` that gap-bridging cannot fix, because the far half of
    that gap is a real breath. Walk forward from the word end while the take stays voiced
    (a run of >= `quiet_run_s` below the gate ends the walk); extend only if it buys
    >= `min_ext_s`, capped at the next word's start. The trim/extend pair together say one
    thing: commanded sound ends where the singer stops, not where the aligner did. Pure."""
    if not words or not take_env:
        return [dict(w) for w in words or []]
    peak = sorted(take_env)[int(0.95 * (len(take_env) - 1))]
    th = quiet_frac * peak
    quiet_run = max(1, int(quiet_run_s / sr_hop_s))
    out = [dict(w) for w in sorted(words, key=lambda x: (x.get("start") or 0.0))]
    for i, w in enumerate(out):
        e = w.get("end")
        if e is None:
            continue
        cap = out[i + 1]["start"] if i + 1 < len(out) and out[i + 1].get("start") is not None \
            else len(take_env) * sr_hop_s
        j = int(e / sr_hop_s)
        last_voiced, quiet = None, 0
        while j < min(len(take_env), int(cap / sr_hop_s)):
            if take_env[j] >= th:
                last_voiced, quiet = j, 0
            else:
                quiet += 1
                if quiet >= quiet_run:
                    break
            j += 1
        if last_voiced is None:
            continue
        new_end = min((last_voiced + 1) * sr_hop_s + pad_s, cap)
        if new_end - e >= min_ext_s:
            w["end"] = round(new_end, 4)
            w["extended"] = True
    return out


def phrase_windows(words):
    """[(phrase_index, start_s, end_s)] from aligned words carrying a `phrase` key."""
    by = {}
    for w in words:
        if w.get("start") is None:
            continue
        p = w.get("phrase", 0)
        lo, hi = by.get(p, (w["start"], w["end"]))
        by[p] = (min(lo, w["start"]), max(hi, w["end"]))
    return [(p, a, b) for p, (a, b) in sorted(by.items())]


def snap_window(words, limit_s):
    """Largest PHRASE-ALIGNED window that fits in `limit_s`, as (t0, t1).

    A fixed stopwatch cut truncates mid-phrase ("Helena Bonham-", "got a good one and I-"),
    which corrupts both the render and the scoring at the boundary. Ending on a phrase gap
    instead costs a little duration and buys a clean edge. Falls back to the hard limit if
    even the first phrase overruns it."""
    wins = phrase_windows(words)
    if not wins:
        return (0.0, limit_s)
    t0 = wins[0][1]
    end = None
    for _p, _a, b in wins:
        if b - t0 <= limit_s:
            end = b
        else:
            break
    return (t0, end if end is not None else t0 + limit_s)


def align_lyrics(song, root=None, *, limit_s=16.0, legato=True):
    """Force-align <song>.lyrics.txt against the FINISHED take -> words with real timings.

    Aligned against the take's first `limit_s` only: the owner supplied opening lyrics, and
    forced alignment assumes the transcript spans the audio it is given, so handing it a
    partial transcript over a full 47-55 s take would smear the timings."""
    import bench_align
    import bench_own_run as run
    import mumble_probe as mp

    root = root or _default_root()
    lyr = os.path.join(root, f"{song}.lyrics.txt")
    fin = os.path.join(root, f"{song}.finished.wav")
    if not (os.path.isfile(lyr) and os.path.isfile(fin)):
        raise FileNotFoundError(f"need {lyr} and {fin}")

    toks = parse_lyrics(open(lyr).read())
    mono, sr = mp._read_mono(fin)
    head = os.path.join(root, f".{song}.head.wav")
    run.slice_wav(mono, sr, 0.0, min(limit_s, len(mono) / sr), head)
    try:
        aligned = bench_align.align_words(head, [t["word"] for t in toks])
    finally:
        if os.path.isfile(head):
            os.remove(head)

    out = []
    for t, a in zip(toks, aligned or []):
        out.append({"word": t["word"], "phrase": t["phrase"],
                    "start": float(a.get("start", 0.0)), "end": float(a.get("end", 0.0)),
                    "score": round(float(a.get("score", 0.0)), 4), "source": "lyrics"})
    if legato:
        # Commanded sound must end where the singer stops; commanded silence only where the
        # singer is silent. Trim FIRST (ends pulled to real voicing), then bridge gaps the
        # take sang through — the two act on disjoint envelope conditions.
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "service"))
        from skeleton.core import energy_envelope
        head_n = int(min(limit_s, len(mono) / sr) * sr)
        env = list(energy_envelope(list(mono[:head_n]), sr, hop_ms=10.0))
        out = close_legato_gaps(extend_word_ends(trim_word_ends(out, env), env), env)
    return out


def _default_root():
    import bench_dataset as bd
    return bd.REGISTRY["own-pairs"]["default_root"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--songs")
    ap.add_argument("--root", default=None)
    ap.add_argument("--limit", type=float, default=16.0, help="seconds of take to align against")
    ap.add_argument("--no-legato", action="store_true",
                    help="keep every aligner word-boundary as a commanded rest (old behaviour)")
    ap.add_argument("--write", action="store_true",
                    help="install as <song>.words.json (ASR kept as <song>.words.asr.json)")
    a = ap.parse_args()
    root = a.root or _default_root()
    songs = a.songs.split(",") if a.songs else sorted(
        f[:-len(".lyrics.txt")] for f in os.listdir(root) if f.endswith(".lyrics.txt"))

    for song in songs:
        words = align_lyrics(song, root, limit_s=a.limit, legato=not a.no_legato)
        ok = [w for w in words if w["score"] > 0.3]
        leg = sum(1 for w in words if w.get("legato"))
        t0, t1 = snap_window(words, 12.0)
        print(f"=== {song}: {len(words)} words, {len(ok)} aligned >0.3 "
              f"({len(ok)/max(1,len(words)):.0%}) | {leg} legato joins | window {t0:.2f}-{t1:.2f}s")
        for p, s, e in phrase_windows(words):
            txt = " ".join(w["word"] for w in words if w.get("phrase") == p)
            print(f"    phrase {p}: {s:6.2f}-{e:6.2f}s  {txt}")
        if a.write:
            asr = os.path.join(root, f"{song}.words.json")
            keep = os.path.join(root, f"{song}.words.asr.json")
            if os.path.isfile(asr) and not os.path.isfile(keep):
                os.rename(asr, keep)
            json.dump(words, open(asr, "w"), indent=1)
            json.dump({"t0": t0, "t1": t1}, open(os.path.join(root, f"{song}.window.json"), "w"))
            print(f"    installed -> {os.path.basename(asr)} (ASR kept as {os.path.basename(keep)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
