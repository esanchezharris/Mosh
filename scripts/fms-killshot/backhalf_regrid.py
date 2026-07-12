#!/usr/bin/env python3
"""Re-grid (grid audit round) — rebuild the syllable grid from energy+ASR evidence.

The shipped ladder derives syllable EXISTENCE from Basic Pitch notes and every later
rung only REMOVES (prune/fold) — on the soft back-half mumble it under-counts and the
owner hears "pretty much all off". Here: syllable existence comes from the ENERGY
envelope (gate attacks + dips between peaks — segment_v2's proven pieces) and ASR
anchors; pitch detectors only ATTACH pitch afterwards.

Candidates (all emit lineScores-shaped slots so downstream machinery is unchanged):
  C  control — the current skeleton.json grid
  E  envelope-first — gate/dip nuclei, median-F0 pitch (BP-note fallback)
  F  fusion — E ∪ BP onsets ∪ ASR syllable anchors, 60ms clustering, witness voting

Subcommands:
  evidence     run BP/FCPE/whisper ONCE on the take -> back-half/evidence.json
  counts       per-phrase count table C vs E vs F -> regrid-manifest.json
  calibrate    4 blind test phrases x 3 click-overlay variants -> page section
  rebuild <E|F|C>   full skeleton-regrid.json from the winning detector

Nothing under ~/mosh-fms-ksb enters git.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "service"))

import diagnose as dg                      # noqa: E402  (venv plumbing + ASR cache)
import segment_v2 as sv2                   # noqa: E402  (gate_events / dip_events)
from backhalf_ab_bench import BH, ROOT     # noqa: E402
from lyrics import flowspec                # noqa: E402
from skeleton import core as skcore       # noqa: E402

SERVE = ROOT / "asserted-proof"
TAKE = BH / "source-backhalf-48k.wav"
SKELETON = BH / "skeleton.json"
EVIDENCE = BH / "evidence.json"
MANIFEST = BH / "regrid-manifest.json"
CAL_JSON = BH / "regrid-calibrate.json"
REGRID = BH / "skeleton-regrid.json"
TRUTH = BH / "ground-truth.json"                 # the owner's hand-marked onsets
SKELETON_TRUTH = BH / "skeleton-truth.json"      # the grid built from them

HOP_S = 0.01
MIN_NUCLEUS_S = 0.04      # sub-40ms nuclei are glitches (mirrors tidy_segments)
CLUSTER_S = 0.06          # fusion: anchors within this are one syllable
JITTER_S = 0.08           # a BP/ASR anchor within this of an energy boundary is the
                          # SAME syllable measured late — below the 16th at 138bpm
                          # (108ms) so fast syllables still split
ATTACK_LAG_S = 0.15       # BP/ASR lag behind a span's attack by up to this much; an
                          # extra cluster in that shadow (with no energy bound between)
                          # is the attack itself, not a second syllable. Fast 16ths are
                          # unaffected: they split via E's dip boundaries, not extras.
DEFAULT_PITCH = 57        # A3 — the take's register center


# ── pure detectors ─────────────────────────────────────────────────────────────────────

def _pitch_for(a: float, b: float, f0, notes, prev: int | None) -> int:
    """Median F0 inside [a,b) -> MIDI; fallback overlapping BP note; then neighbor."""
    if f0:
        st = [69.0 + 12.0 * math.log2(float(p["hz"]) / 440.0)
              for p in f0 if a <= float(p.get("t", -1)) < b and float(p.get("hz", 0)) > 0]
        if st:
            st.sort()
            n = len(st)
            med = st[n // 2] if n % 2 else 0.5 * (st[n // 2 - 1] + st[n // 2])
            return int(round(med))
    for nt in notes or []:
        if float(nt.get("start", 0)) < b and float(nt.get("end", 0)) > a:
            return int(nt.get("pitch", DEFAULT_PITCH))
    return prev if prev is not None else DEFAULT_PITCH


def _slots_from_edges(env, hop_s, span_edges, f0, notes, min_nucleus_s=MIN_NUCLEUS_S):
    """span_edges: [(sa, sb, [interior split times])] -> lineScores-shaped slots.
    Each span's first nucleus starts at the span's ATTACK (sa); interior times split."""
    p95 = sv2._pctl(sorted(env), 95) or 1.0
    slots, prev_pitch = [], None
    for (sa, sb, interior) in span_edges:
        edges = [sa] + sorted(t for t in interior if sa < t < sb) + [sb]
        for i in range(len(edges) - 1):
            a, b = edges[i], edges[i + 1]
            if b - a < min_nucleus_s:
                continue
            lo, hi = int(a / hop_s), max(int(a / hop_s) + 1, int(b / hop_s))
            peak = max(env[lo:hi]) if env[lo:hi] else 0.0
            vel = max(1, min(127, int(round(127.0 * min(1.0, peak / p95)))))
            pitch = _pitch_for(a, b, f0, notes, prev_pitch)
            prev_pitch = pitch
            slots.append({"start": round(a, 4), "end": round(b, 4), "velocity": vel,
                          "kind": "gap",
                          "segments": [{"start": round(a, 4), "end": round(b, 4),
                                        "pitch": pitch}]})
    return slots


def detect_e(env, hop_s, *, f0=None, notes=None):
    """Envelope-first nuclei: gate attacks open voiced spans; dips between peaks split
    syllables inside them. Pitch attached AFTER detection (median F0 -> BP -> neighbor)."""
    attacks, spans = sv2.gate_events(env, hop_s)
    dips = sv2.dip_events(env, hop_s, spans)
    return _slots_from_edges(env, hop_s,
                             [(sa, sb, [d for d in dips if sa < d < sb])
                              for (sa, sb) in spans], f0, notes)


def detect_f(env, hop_s, *, e_nuclei, notes=None, words=None, f0=None):
    """Fusion: E's energy boundaries are the PRECISE spine; BP onsets and ASR syllable
    anchors (clustered within 60ms) propose ADDITIONAL splits — accepted only when
    farther than one jitter from every energy boundary (else they are the same syllable
    measured late) and backed by >=2 witnesses or voiced audio. Within each span, the
    first boundary is the span's attack; later boundaries split."""
    _, spans = sv2.gate_events(env, hop_s)
    e_bounds = sorted(float(s["start"]) for s in e_nuclei or [])

    extras = []
    for nt in notes or []:
        extras.append((float(nt.get("start", 0)), "BP"))
    for w in words or []:
        n = max(1, int(w.get("syl", 1) or 1))
        a, b = float(w.get("start", 0)), float(w.get("end", 0))
        step = (b - a) / n if b > a else 0.0
        for k in range(n):
            extras.append((a + k * step, "ASR"))
    extras.sort()
    clusters = []
    for t, src in extras:
        if clusters and t - clusters[-1]["ts"][-1] <= CLUSTER_S:
            clusters[-1]["ts"].append(t)
            clusters[-1]["src"].add(src)
        else:
            clusters.append({"ts": [t], "src": {src}})

    def span_of(t: float):
        return next(((sa, sb) for (sa, sb) in spans if sa <= t < sb), None)

    bounds = list(e_bounds)
    for c in clusters:
        t = c["ts"][len(c["ts"]) // 2]
        if any(abs(t - eb) <= JITTER_S for eb in bounds):
            continue                       # same syllable as an energy bound
        sp = span_of(t)
        if sp is None:
            continue                       # outside every voiced span: not singing
        sa = sp[0]
        if t - sa <= ATTACK_LAG_S and not any(sa < eb < t for eb in bounds):
            continue                       # the span's own attack, measured late
        # extras must CORROBORATE each other: spans are voiced by definition, so a lone
        # BP note or ASR anchor is no evidence of a NEW syllable (a lone-accept rule
        # ballooned the real take to 267 splits) — only BP+ASR agreement adds one
        if len(c["src"]) >= 2:
            bounds.append(t)
    bounds.sort()
    # E bounds are PRECISE: every in-span bound splits (E's first nucleus starts at the
    # span attack itself, so nothing legitimate gets absorbed here)
    span_edges = [(sa, sb, [t for t in bounds if sa < t < sb]) for (sa, sb) in spans]
    return _slots_from_edges(env, hop_s, span_edges, f0, notes)


# ── evidence capture (one-time subprocess runs, then instant iteration) ────────────────

def evidence() -> int:
    take, sr = skcore.read_pcm_mono(str(TAKE))
    env = skcore.energy_envelope(take, sr)
    bp_py = dg._venv_python("transcribe/.transcribe.env", "BASIC_PITCH_PY")
    sk_py = dg._venv_python("skeleton/.skeleton.env", "SKELETON_PY")
    if not bp_py:
        raise SystemExit("Basic Pitch venv missing (service/transcribe/setup-transcribe.sh)")
    notes, f0 = dg._fetch_models(str(TAKE), bp_py, sk_py)
    words = dg._asr_words(str(TAKE), str(BH / "asr-words-cache.json"), "small")
    EVIDENCE.write_text(json.dumps({
        "takeS": round(len(take) / sr, 3), "hopS": HOP_S,
        "env": [round(v, 6) for v in env],
        "notes": notes, "f0": f0 or [], "words": words or [],
    }, indent=None))
    print(f"evidence: {len(notes)} BP notes · {len(f0 or [])} f0 frames · "
          f"{len(words or [])} ASR words · {len(env)} env frames -> {EVIDENCE}", flush=True)
    return 0


def _load_evidence() -> dict:
    if not EVIDENCE.is_file():
        raise SystemExit("run `backhalf_regrid.py evidence` first")
    return json.loads(EVIDENCE.read_text())


def _candidate_slots(ev: dict, skeleton: dict | None = None) -> dict:
    """All three candidates' slots on the take timeline. `skeleton` overrides the on-disk
    skeleton.json (keeps callers pure/testable)."""
    skel = skeleton if skeleton is not None else json.loads(SKELETON.read_text())
    c_slots = [s for ls in skel.get("lineScores") or [] if isinstance(ls, dict)
               for s in ls.get("slots") or []]
    e = detect_e(ev["env"], ev["hopS"], f0=ev["f0"], notes=ev["notes"])
    f = detect_f(ev["env"], ev["hopS"], e_nuclei=e, notes=ev["notes"],
                 words=ev["words"], f0=ev["f0"])
    return {"C": sorted(c_slots, key=lambda s: float(s["start"])), "E": e, "F": f}


def counts() -> int:
    ev = _load_evidence()
    cands = _candidate_slots(ev)
    skel = json.loads(SKELETON.read_text())
    phrases = flowspec.group_by_rest(skel.get("lineScores") or [], gap_s=0.35, min_syllables=2)
    table = []
    print(f"{'L':>3} {'C':>3} {'E':>3} {'F':>3}  span")
    for i, ph in enumerate(phrases):
        a, b = float(ph["start"]) - 0.05, float(ph["end"]) + 0.05
        row = {"index": i, "startS": round(float(ph["start"]), 3),
               "endS": round(float(ph["end"]), 3)}
        for k in ("C", "E", "F"):
            row[k] = sum(1 for s in cands[k] if a <= float(s["start"]) < b)
        table.append(row)
        print(f"L{i:>2} {row['C']:>3} {row['E']:>3} {row['F']:>3}  {a:.1f}-{b:.1f}s")
    totals = {k: len(cands[k]) for k in cands}
    print(f"TOTALS {totals}")
    MANIFEST.write_text(json.dumps({"totals": totals, "phrases": table}, indent=2))
    return 0


# ── Phase B: blind calibration (4 phrases x 3 variants) ────────────────────────────────

CAL_PHRASES = [9, 7, 2, 4]     # worst under-counts, owner-heard trouble, agreement control


def calibrate() -> int:
    import backhalf_grid_check as gcheck
    ev = _load_evidence()
    cands = _candidate_slots(ev)
    skel = json.loads(SKELETON.read_text())
    phrases = flowspec.group_by_rest(skel.get("lineScores") or [], gap_s=0.35, min_syllables=2)
    take, sr = skcore.read_pcm_mono(str(TAKE))
    gcheck.GRID.mkdir(parents=True, exist_ok=True)
    order = ["C", "E", "F"]
    entries = []
    for pi in CAL_PHRASES:
        ph = phrases[pi]
        t0 = max(0.0, float(ph["start"]) - gcheck.PAD_S)
        t1 = min(len(take) / sr, float(ph["end"]) + gcheck.PAD_S)
        clip = take[int(t0 * sr):int(t1 * sr)]
        plain = gcheck.GRID / f"cal-L{pi:02d}-plain.wav"
        gcheck._write_mono(plain, clip, sr)
        rot = pi % 3                       # deterministic blind shuffle per phrase
        variants = order[rot:] + order[:rot]
        vrows = []
        for vi, key in enumerate(variants, start=1):
            # tick ONLY the phrase span (the counts-table definition) — the padded clip
            # region would add neighbor phrases' clicks and corrupt the count
            starts = [float(s["start"]) for s in cands[key]
                      if float(ph["start"]) - 0.05 <= float(s["start"]) < float(ph["end"]) + 0.05]
            ticked = list(clip)
            tick_n = int(gcheck.TICK_S * sr)
            for st in starts:
                at = int((st - t0) * sr)
                for j in range(tick_n):
                    if 0 <= at + j < len(ticked):
                        envl = 1.0 - j / tick_n
                        ticked[at + j] += gcheck.TICK_GAIN * envl * math.sin(
                            2 * math.pi * gcheck.TICK_HZ * j / sr)
            mixed = gcheck.GRID / f"cal-L{pi:02d}-v{vi}.wav"
            gcheck._write_mono(mixed, ticked, sr)
            from soulx import ab_mix
            ab_mix.stereo_ab(str(plain), str(mixed),
                             str(gcheck.GRID / f"cal-L{pi:02d}-var{vi}.wav"), sr=sr)
            vrows.append({"variant": vi, "candidate": key, "clicks": len(starts),
                          "wav": f"grid/cal-L{pi:02d}-var{vi}.wav"})
        entries.append({"index": pi, "startS": round(t0, 2), "endS": round(t1, 2),
                        "variants": vrows})
    CAL_JSON.write_text(json.dumps({"phrases": entries}, indent=2))
    print(f"calibration: {len(entries)} phrases x 3 blind variants -> {CAL_JSON}", flush=True)
    import backhalf_perform as bp
    bp.page()
    return 0


# ── Phase C: full re-grid from the winning detector, or from hand-marked truth ─────────

def truth_slots(ev: dict, skeleton: dict, ground_truth: dict) -> list:
    """The owner's hand-marked onsets (ground-truth.json) as lineScores-shaped slots:
    within each phrase, onsets are the slot starts; each runs to the next onset (last to
    the phrase end). Pitch/velocity attached from evidence like the detectors. An
    unmarked phrase (rest) contributes nothing."""
    phrases = flowspec.group_by_rest(skeleton.get("lineScores") or [],
                                     gap_s=0.35, min_syllables=2)
    gt = ground_truth.get("phrases") or {}
    span_edges = []
    for i, ph in enumerate(phrases):
        onsets = sorted(set(round(float(t), 4) for t in gt.get(str(i), [])))
        if not onsets:
            continue
        end = max(float(ph["end"]), onsets[-1] + 0.08)   # the last syllable holds to phrase end
        span_edges.append((onsets[0], end, onsets[1:]))
    return _slots_from_edges(ev["env"], ev["hopS"], span_edges, ev["f0"], ev["notes"],
                             min_nucleus_s=0.005)


def _slots_to_skeleton(slots: list, skel: dict, ev: dict, algo: str, dest: Path):
    """slots (any origin) -> a skeleton.json-shaped doc: bar-binned lineScores +
    per-line seedText (kept words re-anchored by evidence timestamps) + lineHeard.
    Writes to `dest` and returns (doc, line_scores)."""
    bpm = 138.0
    for ls in skel.get("lineScores") or []:
        if isinstance(ls, dict) and ls.get("bpm"):
            bpm = float(ls["bpm"])
            break
    bar_s = 4.0 * 60.0 / bpm
    by_bar: dict = {}
    for s in slots:
        by_bar.setdefault(int(float(s["start"]) // bar_s), []).append(s)
    kept_words = set()
    for lh in skel.get("lineHeard") or []:
        if isinstance(lh, dict):
            for w in lh.get("words") or []:
                if w.get("kept"):
                    kept_words.add((lh.get("bar"), flowspec._clean_tok(w.get("word"))))
    line_scores, lines, line_heard = [], [], []
    for bar in sorted(by_bar):
        bslots = sorted(by_bar[bar], key=lambda s: float(s["start"]))
        line_scores.append({"v": 1, "algo": algo, "bar": bar, "bpm": bpm,
                            "timeSig": [4, 4], "grid": "1/16", "clamped": False,
                            "slots": bslots})
        toks = ["___"] * len(bslots)
        heard_rows = []
        for w in ev["words"] or []:
            ws = float(w.get("start", 0))
            if not (bar * bar_s <= ws < (bar + 1) * bar_s) or not bslots:
                continue
            idx = min(range(len(bslots)), key=lambda i: abs(float(bslots[i]["start"]) - ws))
            tok = flowspec._clean_tok(w.get("word"))
            kept = (bar, tok) in kept_words
            if kept and toks[idx] == "___":
                toks[idx] = tok
            heard_rows.append({"word": w.get("word"), "slot": idx,
                               "conf": round(float(w.get("conf", 0) or 0), 3),
                               "kept": kept, "syl": int(w.get("syl", 1) or 1)})
        lines.append({"index": bar, "seedText": " ".join(toks), "syllableTarget": len(bslots)})
        if heard_rows:
            line_heard.append({"v": 1, "bar": bar, "words": heard_rows})
    doc = {**{k: v for k, v in skel.items() if k not in ("lineScores", "lines", "lineHeard")},
           "lineScores": line_scores, "lines": lines, "lineHeard": line_heard}
    if dest is not None:
        dest.write_text(json.dumps(doc, indent=1))
    return doc, line_scores


def rebuild(winner: str) -> int:
    ev = _load_evidence()
    skel = json.loads(SKELETON.read_text())
    if winner == "truth":
        if not TRUTH.is_file():
            raise SystemExit("no ground-truth.json — mark the take in the annotator first")
        slots = truth_slots(ev, skel, json.loads(TRUTH.read_text()))
        algo, dest = "truth", SKELETON_TRUTH
    else:
        cands = _candidate_slots(ev, skel)
        if winner not in cands:
            raise SystemExit(f"winner must be one of {sorted(cands) + ['truth']}")
        slots, algo, dest = cands[winner], f"regrid-{winner}", REGRID
    _, line_scores = _slots_to_skeleton(slots, skel, ev, algo, dest)
    phrases = flowspec.group_by_rest(line_scores, gap_s=0.35, min_syllables=2)
    print(f"{algo}: {len(slots)} slots, {len(line_scores)} bars, "
          f"{len(phrases)} phrases -> {dest}", flush=True)
    return 0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "counts"
    if cmd == "evidence":
        sys.exit(evidence())
    if cmd == "counts":
        sys.exit(counts())
    if cmd == "calibrate":
        sys.exit(calibrate())
    if cmd == "rebuild":
        sys.exit(rebuild(sys.argv[2] if len(sys.argv) > 2 else "truth"))
    raise SystemExit(f"unknown subcommand {cmd!r}")
