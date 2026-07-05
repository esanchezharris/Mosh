#!/usr/bin/env python3
"""Phase-2 mumble -> rhythmic SKELETON core (Finish-My-Song roadmap §2 + Phase-3 Stage 1).

Turns a hummed/mumbled take (Basic-Pitch note onsets, optionally + an F0 contour) into the
SAME `LineSpec` the Phase-1 lyric engine consumes — a wordless skeleton (every slot a `___`
gap) carrying the syllable count + stress contour per bar. NO words, NO synthesis.

Design: do NOT duplicate the binning. `lyrics.mumble.build_spec_from_take(nuclei, [])` already
bins onsets into bars, derives syllables-per-bar + a stress contour, and emits the exact spec
shape — so this module owns only the NEW signal steps and funnels the result through mumble.
One `LineSpec` emitter, no contract drift.

Segmentation ladder (kill-shot B verdict GO, 2026-07-04 — promoted from
scripts/fms-killshot/segment_v2.py, ear- and lyrics-truth-validated):

- **No readable audio (no `env`):** today's v1 behavior, byte-identical lines — one note =
  one nucleus (+ F0 re-articulation splits when a contour is present). The safety floor.
- **With an energy envelope (`env`, computed by the route):** v3 — the owner's rule applied
  as a PRUNER on the v1 nuclei: a boundary survives only with evidence (a real silence gap,
  a note change across it, or an envelope dip at it), evidenced boundaries snap to the 16th
  lattice (8th/quarter lines preferred), evidence-free boundaries merge away. Then MELISMA
  GROUPING: a "note"-kind boundary (pitch changed, energy continuous) does NOT start a new
  syllable — the groups are the syllable slots; per-note `segments` stay underneath as the
  render-ready score (`lineScores`, the Phase-3 `lyricScore` blob).
- **With generous ASR words too (`words`):** v4 — "ASR counts, DSP times": per-PHRASE
  syllable budgets fold surplus slots (weakest evidence first). NEVER per-word (ASR word
  ends land early on held notes), NEVER inventing slots.

Pure stdlib (the service interpreter has no numpy); the real FCPE F0 extraction lives in the
isolated `skeleton_cli.py` venv and feeds this its `f0` list. The ONLY I/O here is
`read_pcm_mono` (stdlib `wave` behind a fmt-tag==1 guard), used by the /skeleton_spec route.
"""
from __future__ import annotations

import math
import struct
import wave
from typing import List, Optional, Tuple

from lyrics import mumble

# A within-note pitch re-articulation of at least this many semitones reads as a new syllable
# nucleus (a fresh vowel onset), not pitch drift within one sustained syllable.
_SPLIT_SEMITONES = 1.5

# ── envelope / pruner constants (validated in the KS-B harness; do not tune blind — the
#    values are the ones the owner's ear confirmed on real takes) ──
HOP_MS = 10.0             # envelope hop; aligns with FCPE's contour hop
WIN_MS = 25.0             # envelope RMS window
PRUNE_GAP_S = 0.03        # inter-nucleus silence >= this = a real break (kind "gap")
PRUNE_PITCH_ST = 1.0      # note change across the boundary >= 1 semitone (kind "note")
PRUNE_DIP_FRAC = 0.60     # envelope valley near the boundary below 60% of the quieter
PRUNE_DIP_WIN_S = 0.06    #   neighbouring peak, searched +/- this window (kind "dip")
PRUNE_GRID_TOL = 0.25     # snap window: +/- 25% of a 16th
MAX_READ_S = 600.0        # envelope source cap (MAX_BARS truncates the spec long before this)


def _semitone(hz: float) -> Optional[float]:
    """Absolute semitones from A440 (relative is all we use). None for unvoiced/invalid."""
    return 12.0 * math.log2(hz / 440.0) if hz and hz > 0 else None


def nuclei_from_notes(notes: List[dict], f0: Optional[List[dict]] = None) -> List[dict]:
    """Refine Basic-Pitch notes into syllable nuclei (each a {start, end, velocity} dict).

    With no F0: identity (one note = one nucleus) — preserves the exact note dicts so the
    downstream binning is unchanged. With an F0 contour ([{t, hz}, ...] in SECONDS / Hz): split
    a note wherever the voiced pitch jumps by >= _SPLIT_SEMITONES between consecutive samples."""
    if not f0:
        return [dict(n) for n in notes]   # identity — the offline/fake path

    samples = sorted(
        ({"t": float(s.get("t", s.get("time", 0.0))),
          "st": _semitone(float(s.get("hz", s.get("f0", 0.0)) or 0.0))} for s in f0),
        key=lambda s: s["t"])

    out: List[dict] = []
    for n in notes:
        ns, ne = float(n.get("start", 0.0)), float(n.get("end", 0.0))
        vel = float(n.get("velocity", 0))
        inside = [s for s in samples if ns <= s["t"] < ne and s["st"] is not None]
        cuts = [b["t"] for a, b in zip(inside, inside[1:])
                if abs(b["st"] - a["st"]) >= _SPLIT_SEMITONES]
        bounds = [ns] + cuts + [ne]
        for i in range(len(bounds) - 1):
            if bounds[i + 1] > bounds[i]:
                out.append({"start": bounds[i], "end": bounds[i + 1], "velocity": vel})
    return out


def _nuclei_with_pitch(notes: List[dict], f0: Optional[List[dict]]):
    """`nuclei_from_notes` plus a parallel per-nucleus pitch list (the parent note's MIDI
    pitch repeated across its splits — the pruner's no-F0 note-change evidence and the
    render score's segment pitch). Concatenating per-note calls == the batch call."""
    nuclei: List[dict] = []
    pitches: List[Optional[int]] = []
    for n in notes:
        subs = nuclei_from_notes([n], f0)
        nuclei += subs
        p = n.get("pitch")
        pitches += [int(p) if p is not None else None] * len(subs)
    return nuclei, pitches


# ── audio -> energy envelope (the route's in-process step; core stays list-based) ──────

def read_pcm_mono(path: str):
    """Read a PLAIN PCM WAV (fmt tag 1, 16/24-bit) -> (mono float list, sample rate), else None.

    Do NOT trust `wave.open` alone: Python >= 3.12 accepts WAVE_FORMAT_EXTENSIBLE (tag 0xFFFE,
    what afconvert emits) while <= 3.11 rejects it — gating on the fmt tag keeps the
    degradation ladder DETERMINISTIC across interpreters. Anything unreadable -> None (the
    caller degrades to the v1 path, never breaks). Reads at most MAX_READ_S seconds."""
    try:
        with open(path, "rb") as f:
            if f.read(4) != b"RIFF":
                return None
            f.seek(12)
            tag = bits = None
            while True:
                hdr = f.read(8)
                if len(hdr) < 8:
                    return None
                cid, sz = hdr[:4], int.from_bytes(hdr[4:8], "little")
                if cid == b"fmt ":
                    fmt = f.read(sz)
                    tag = int.from_bytes(fmt[0:2], "little")
                    bits = int.from_bytes(fmt[14:16], "little")
                    break
                f.seek(sz + (sz & 1), 1)
        if tag != 1 or bits not in (16, 24):
            return None
        with wave.open(path, "rb") as w:
            ch, sw, sr = w.getnchannels(), w.getsampwidth(), w.getframerate()
            nf = min(w.getnframes(), int(MAX_READ_S * sr))
            raw = w.readframes(nf)
        if sw == 3:
            inter = []
            for k in range(0, len(raw) - 2, 3):
                v = raw[k] | (raw[k + 1] << 8) | (raw[k + 2] << 16)
                if v & 0x800000:
                    v -= 0x1000000
                inter.append(v / 8388608.0)
        else:
            cnt = len(raw) // 2
            inter = [v / 32768.0 for v in struct.unpack("<%dh" % cnt, raw)] if cnt else []
        if ch <= 1:
            return inter, sr
        frames = len(inter) // ch
        return [sum(inter[i * ch:(i + 1) * ch]) / ch for i in range(frames)], sr
    except Exception:  # noqa: BLE001 — any parse failure degrades, never breaks
        return None


def energy_envelope(mono: List[float], sr: int, hop_ms: float = HOP_MS,
                    win_ms: float = WIN_MS) -> List[float]:
    """RMS frames over the mono signal (prefix-sum of squares, O(n)). Audio shorter than
    one RMS window -> [] (no usable envelope evidence; callers degrade to the v1 floor)."""
    hop = max(1, int(sr * hop_ms / 1000.0))
    win = max(hop, int(sr * win_ms / 1000.0))
    if len(mono) < win:
        return []
    acc = [0.0]
    for v in mono:
        acc.append(acc[-1] + v * v)
    env = []
    for s in range(0, max(1, len(mono) - win + 1), hop):
        e = acc[s + win] - acc[s]
        env.append(math.sqrt(e / win))
    return env


# ── v3: the owner's rule as a PRUNER on v1 nuclei (KS-B, ear-confirmed) ────────────────

def _median(vals: list) -> float:
    s = sorted(vals)
    n = len(s)
    return s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2])


def _env_at(env: List[float], hop_s: float, a: float, b: float, fn) -> float:
    lo = max(0, int(a / hop_s))
    hi = min(len(env), max(lo + 1, int(b / hop_s)))
    seg = env[lo:hi]
    return fn(seg) if seg else 0.0


def _f0_median_st(f0, a: float, b: float) -> Optional[float]:
    if not f0:
        return None
    st = [12.0 * math.log2(float(p["hz"]) / 440.0)
          for p in f0 if a <= float(p["t"]) < b and float(p.get("hz", 0)) > 0]
    return _median(st) if st else None


def _snap16(t: float, bpm: float, tol: float = PRUNE_GRID_TOL) -> Tuple[float, bool]:
    """Snap t to the 16th lattice, preferring 8th/quarter lines when two lines qualify."""
    s16 = (60.0 / bpm) / 4.0 if bpm > 0 else 0.125
    line = round(t / s16)
    cands = [ln for ln in (line - 1, line, line + 1) if abs(t - ln * s16) <= tol * s16]
    if not cands:
        return t, False
    # metric weight: quarter (line%4==0) > 8th (line%2==0) > 16th; then nearest
    best = min(cands, key=lambda ln: ((ln % 4 != 0) + (ln % 2 != 0), abs(t - ln * s16)))
    return best * s16, True


def prune_v1_nuclei(nuclei: List[dict], pitches: List[Optional[int]],
                    env: List[float], f0: Optional[List[dict]],
                    bpm: float) -> dict:
    """v1 nuclei + their parent-note pitches -> merged/snapped nuclei + evidence log.

    For each boundary between consecutive nuclei: keep on gap/note-change/dip evidence
    (snapping evidenced boundaries to the 16th lattice, 8ths preferred), else merge.
    `env` is the take's energy envelope at HOP_MS hops (see energy_envelope) — the
    route computes it in-process so this module stays pure-over-lists."""
    if len(nuclei) <= 1:
        return {"nuclei": [dict(n) for n in nuclei], "pitches": list(pitches),
                "evidence": {"gap": 0, "note": 0, "dip": 0, "offgrid": 0},
                "merged_away": 0}
    hop_s = HOP_MS / 1000.0
    counts = {"gap": 0, "note": 0, "dip": 0, "offgrid": 0}
    out = [dict(nuclei[0])]
    out_p = [pitches[0]]
    merged = 0
    for n, p in zip(nuclei[1:], pitches[1:]):
        a = out[-1]
        t = float(n["start"])
        kind = None
        if t - float(a["end"]) >= PRUNE_GAP_S:
            kind = "gap"
        else:
            pa = _f0_median_st(f0, float(a["start"]), float(a["end"]))
            pb = _f0_median_st(f0, t, float(n["end"]))
            if pa is not None and pb is not None:
                if abs(pb - pa) >= PRUNE_PITCH_ST:
                    kind = "note"
            elif out_p[-1] is not None and p is not None and abs(p - out_p[-1]) >= PRUNE_PITCH_ST:
                kind = "note"
            if kind is None:
                pk_a = _env_at(env, hop_s, max(float(a["start"]), t - 3 * PRUNE_DIP_WIN_S), t, max)
                pk_b = _env_at(env, hop_s, t, min(float(n["end"]), t + 3 * PRUNE_DIP_WIN_S), max)
                valley = _env_at(env, hop_s, t - PRUNE_DIP_WIN_S, t + PRUNE_DIP_WIN_S, min)
                ref = min(pk_a, pk_b)
                if ref > 0 and valley < PRUNE_DIP_FRAC * ref:
                    kind = "dip"
        if kind is None:
            a["end"] = max(float(a["end"]), float(n["end"]))     # merge: no evidence
            a["velocity"] = max(float(a["velocity"]), float(n.get("velocity", 0)))
            merged += 1
            continue
        counts[kind] += 1
        g, on_grid = _snap16(t, bpm)
        if not on_grid:
            counts["offgrid"] += 1
        elif g != t and float(a["start"]) < g < float(n["end"]):
            a["end"] = round(g, 4)                               # slide the cut to the line
            n = dict(n); n["start"] = round(g, 4)
        nn = dict(n); nn["kind"] = kind
        out.append(nn)
        out_p.append(p)
    return {"nuclei": out, "pitches": out_p, "evidence": counts, "merged_away": merged}


def articulation_groups(nuclei: List[dict], pitches: List[Optional[int]]) -> List[dict]:
    """Group v3 nuclei into ARTICULATIONS (owner's rule 2026-07-03: a new note is not a
    new word). A nucleus whose kind is "note" (pitch changed, energy continuous) CONTINUES
    the previous articulation — a melisma segment — while "gap"/"dip"/first-of-take starts
    a new one. Each group = one syllable slot for the lyric grid; `segments` keeps the
    per-note pitch/time detail for the render skeleton."""
    groups: List[dict] = []
    for n, p in zip(nuclei, pitches):
        seg = {"start": float(n["start"]), "end": float(n["end"]),
               "pitch": p if p is not None else 69}
        if groups and n.get("kind") == "note" and \
                float(n["start"]) - groups[-1]["end"] < 1e-6:
            g = groups[-1]
            g["end"] = seg["end"]
            g["velocity"] = max(g["velocity"], float(n.get("velocity", 0)))
            g["segments"].append(seg)
        else:
            groups.append({"start": seg["start"], "end": seg["end"],
                           "velocity": float(n.get("velocity", 0)),
                           "kind": n.get("kind", "attack"),
                           "segments": [seg]})
    return groups


def fuse_asr_budget(groups: List[dict], words: List[dict], bpm: float,
                    tol: float = PRUNE_GRID_TOL) -> Tuple[List[dict], dict]:
    """v4 (owner's idea, 2026-07-03): ASR counts, DSP times. `words` are GENEROUSLY
    decoded ASR words [{start, end, syl}] — wrong words welcome, only their syllable
    budget and span matter. Within each phrase span, surplus articulation groups fold
    into their predecessor (same mechanism as melisma folding: the audio is one word),
    weakest evidence first — off-grid before on-grid, dip-kind before gap-kind. Fewer
    groups than budget -> keep (never invent). Groups outside any phrase span (ASR heard
    silence/no word) pass through verbatim. Pure stdlib; the caller supplies syllable
    counts (phonology stays out of this module)."""
    s16 = (60.0 / bpm) / 4.0 if bpm > 0 else 0.125

    # Budget at PHRASE level (contiguous words, gap < 0.4 s), spans extended to the next
    # phrase's start: word-level spans proved too fine for sung timing (ASR word ends
    # land early on held notes; boundary slots get mis-assigned and over-fold).
    phrases: List[dict] = []
    for w in sorted(words, key=lambda x: float(x["start"])):
        if phrases and float(w["start"]) - phrases[-1]["end"] < 0.4:
            phrases[-1]["end"] = max(phrases[-1]["end"], float(w["end"]))
            phrases[-1]["syl"] += max(1, int(w.get("syl", 1)))
        else:
            phrases.append({"start": float(w["start"]), "end": float(w["end"]),
                            "syl": max(1, int(w.get("syl", 1)))})
    for p, nxt in zip(phrases, phrases[1:]):
        p["span_end"] = nxt["start"]
    if phrases:
        phrases[-1]["span_end"] = phrases[-1]["end"] + 2.0

    def word_of(t: float) -> int:
        for i, p in enumerate(phrases):
            if p["start"] - 0.05 <= t < p["span_end"]:
                return i
        return -1

    out = [dict(g, segments=list(g["segments"])) for g in groups]
    owner = [word_of(g["start"]) for g in out]
    folded = 0
    words_over = words_under = 0
    kind_rank = {"dip": 0, "note": 1, "gap": 2, "attack": 3}
    for wi, w in enumerate(phrases):
        idxs = [i for i, o in enumerate(owner) if o == wi]
        budget = max(1, int(w.get("syl", 1)))
        if len(idxs) < budget:
            words_under += 1
            continue
        if len(idxs) == budget:
            continue
        words_over += 1

        # fold candidates: every group in the span except the first; weakest first
        def weakness(i: int):
            g = out[i]
            off = abs(g["start"] - round(g["start"] / s16) * s16) > tol * s16
            return (0 if off else 1, kind_rank.get(g.get("kind", "gap"), 2), g["start"])
        for i in sorted(idxs[1:], key=weakness)[: len(idxs) - budget]:
            out[i]["_fold"] = True
            folded += 1
    fused: List[dict] = []
    for g in out:
        if g.pop("_fold", False) and fused:
            prev = fused[-1]
            prev["end"] = max(prev["end"], g["end"])
            prev["velocity"] = max(prev["velocity"], g["velocity"])
            prev["segments"] += g["segments"]
        else:
            fused.append(g)
    stats = {"asr_words": len(words), "asr_phrases": len(phrases),
             "words_over": words_over, "words_under": words_under,
             "folded_by_asr": folded,
             "unassigned_groups": sum(1 for o in owner if o < 0)}
    return fused, stats


# ── the LineSpec emitter (+ the Phase-3 render-ready lineScores) ───────────────────────

def _line_scores(groups: List[dict], bpm: float, time_sig, grid: str, algo: str) -> List[dict]:
    """Per-line render-ready score blobs, aligned 1:1 with the spec's lines: the SAME
    `mumble._bin_bars` binning over the same groups guarantees the alignment. Each blob is
    self-contained (bar/bpm/timeSig/grid travel with it) so the Phase-3 render adapter can
    author a target score from one line alone. Slots keep ALL groups in the bar (the take's
    truth) even when the grid clamps the line's syllableTarget — flagged `clamped`."""
    spb = mumble._sec_per_bar(bpm, time_sig)
    per_bar = mumble._grid_per_bar(grid)
    scores = []
    for bar, slots in mumble._bin_bars(groups, spb):
        scores.append({
            "v": 1, "algo": algo, "bar": bar, "bpm": bpm,
            "timeSig": [int(time_sig[0]), int(time_sig[1])] if time_sig else [4, 4],
            "grid": grid, "clamped": len(slots) > per_bar,
            "slots": [{
                "start": round(float(g["start"]), 4), "end": round(float(g["end"]), 4),
                "velocity": float(g.get("velocity", 0)),
                **({"kind": g["kind"]} if g.get("kind") else {}),
                "segments": [{"start": round(float(s["start"]), 4),
                              "end": round(float(s["end"]), 4),
                              "pitch": int(s.get("pitch", 69))}
                             for s in g["segments"]],
            } for g in slots],
        })
    return scores


def build_skeleton_spec(notes: List[dict], f0: Optional[List[dict]] = None, bpm: float = 120.0,
                        time_sig=(4, 4), grid: str = "1/16", topic: str = "", mood: str = "",
                        env: Optional[List[float]] = None,
                        words: Optional[List[dict]] = None,
                        extract_lyrics: bool = False,
                        extract_use_llm: bool = True) -> dict:
    """Notes (+ optional F0 / envelope / ASR words) -> an editable `LineSpec`.

    Reuses `lyrics.mumble.build_spec_from_take` for the bar binning / stress / spec shape,
    then stamps the skeleton provenance and the per-line render-ready `lineScores`.

    Degradation ladder (each rung strictly additive, never breaking):
      env=None                    -> v1: today's behavior, lines byte-identical (floor)
      env                         -> v3: evidence pruner + melisma grouping (KS-B GO)
      env + words                 -> v4: + per-phrase ASR syllable budgets (KS-B GO)
      env + words + extract_lyrics -> + LYRIC EXTRACTION (pipeline correction 2026-07-04):
        his real words are detected and PRESERVED — fully-real covered lines land
        verbatim (`text` + origin "sung"), partly-real lines keep heard words as seed
        anchors (origin "partial"), mumble stays all-gaps. Raw heard words persist per
        line in `lineHeard` (nothing discarded — future splice boundaries + seeds).
    `words` without `env` is ignored (v4 folds by evidence kind, which only the pruner
    assigns — that combination was never measured); extraction requires words+env too."""
    nuclei, pitches = _nuclei_with_pitch(notes, f0)

    if env:
        pr = prune_v1_nuclei(nuclei, pitches, env, f0, bpm)
        groups = articulation_groups(pr["nuclei"], pr["pitches"])
        algo, asr_stats = "v3", None
        if words:
            groups, asr_stats = fuse_asr_budget(groups, words, bpm)
            algo = "v4"

        extraction = None
        if words and extract_lyrics:
            from lyrics import extract as lyric_extract
            extraction = lyric_extract.extract(words, groups, bpm, time_sig=time_sig,
                                               grid=grid, use_llm=extract_use_llm)

        # Anchoring reuses the PROVEN nearest-free-slot machinery in mumble verbatim:
        # the extraction tiers already decided which words qualify, so the confidence
        # threshold is 0.0 (pass exactly those). No extraction -> today's wordless call.
        anchor_words = extraction["kept"] if extraction else []
        spec = mumble.build_spec_from_take(groups, anchor_words, bpm, time_sig=time_sig,
                                           conf_threshold=0.0 if anchor_words else 0.6,
                                           grid=grid, topic=topic, mood=mood)
        if spec.get("ok"):
            spec["source"] = "skeleton"
            spec["editable"] = True
            spec["lineScores"] = _line_scores(groups, bpm, time_sig, grid, algo)
            info = {"algo": algo, "evidence": pr["evidence"], "merged_away": pr["merged_away"],
                    "v1_nuclei": len(nuclei),
                    "melisma_groups": sum(1 for g in groups if len(g["segments"]) > 1)}
            if asr_stats is not None:
                info["asr"] = asr_stats
            if extraction is not None:
                # Lines and extraction verdicts align through the SAME _bin_bars order.
                spb = mumble._sec_per_bar(bpm, time_sig)
                bars = [b for b, _ in mumble._bin_bars(groups, spb)]
                heard = []
                for i, (line, bar) in enumerate(zip(spec["lines"], bars)):
                    text = extraction["line_text"].get(bar)
                    origin = extraction["line_origin"].get(bar)
                    if text:
                        line["text"] = text
                        line["origin"] = "sung"
                    elif origin == "partial":
                        line["origin"] = "partial"
                    heard.append(extraction["line_heard"].get(bar))
                spec["lineHeard"] = heard
                info["extraction"] = extraction["stats"]
            spec["skeleton"] = info
        return spec

    # v1 floor: no readable audio — the lines are BYTE-IDENTICAL to the pre-Stage-1 path
    # (pinned by golden); lineScores still ship (single-segment slots at the note pitch)
    # so the render path exists on degraded installs too.
    spec = mumble.build_spec_from_take(nuclei, [], bpm, time_sig=time_sig, grid=grid,
                                       topic=topic, mood=mood)
    if spec.get("ok"):
        spec["source"] = "skeleton"
        spec["editable"] = True
        v1_groups = [{"start": float(n.get("start", 0.0)), "end": float(n.get("end", 0.0)),
                      "velocity": float(n.get("velocity", 0)),
                      "segments": [{"start": float(n.get("start", 0.0)),
                                    "end": float(n.get("end", 0.0)),
                                    "pitch": p if p is not None else 69}]}
                     for n, p in zip(nuclei, pitches)]
        spec["lineScores"] = _line_scores(v1_groups, bpm, time_sig, grid, "v1")
        spec["skeleton"] = {"algo": "v1"}
    return spec
