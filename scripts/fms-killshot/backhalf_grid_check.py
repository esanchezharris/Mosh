#!/usr/bin/env python3
"""Grid verification (strict round, Step 2) — the owner's ear checks the ruler.

Every strictness gate (exact counts, slot snap, mouth targets) measures against the
skeleton's slot grid; the owner says "some counts feel wrong", so before the next paid
render each phrase gets a listenable check: the mumble solo LEFT, the mumble + a click
at every slot start RIGHT. Count the clicks against what you sang. Phrases where the
detector's own evidence disagrees (ASR syllable budget vs slots, heavy melisma folds)
are flagged and listed first.

Reply in chat with corrections ("L3 is 9, L14 is 3") or "grid good".
`apply_grid_corrections` then adjusts slots deterministically into
back-half/skeleton-corrected.json (the original is never mutated):
  count < slots  ->  fold the lowest-velocity slot into its longer neighbor
  count > slots  ->  split the longest slot at its midpoint

Usage:  backhalf_grid_check.py                build clips + flags + page section
        backhalf_grid_check.py apply '{"3": 9, "14": 3}'   write skeleton-corrected.json
"""
from __future__ import annotations

import copy
import json
import math
import struct
import subprocess
import sys
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "service"))

from backhalf_ab_bench import BH, CHORUS, ROOT, THEME, resolve_skeleton  # noqa: E402
from lyrics import flowspec  # noqa: E402
from skeleton import core as skcore  # noqa: E402
from soulx import ab_mix  # noqa: E402

SERVE = ROOT / "asserted-proof"
GRID = SERVE / "grid"
TAKE = BH / "source-backhalf-48k.wav"
MANIFEST = BH / "grid-check.json"
CORRECTED = BH / "skeleton-corrected.json"
GAP_S, MIN_SYL = 0.35, 2         # MUST match the writer round's grouping
PAD_S, TICK_HZ, TICK_S, TICK_GAIN = 0.3, 2000.0, 0.02, 0.4


# ── corrections applier (pure; golden-tested) ──────────────────────────────────────────

def _fold_weakest(ph_slots: list, bar_slots: dict) -> None:
    """Merge the phrase's lowest-velocity slot into its longer neighbor (in place)."""
    k = min(range(len(ph_slots)), key=lambda i: (float(ph_slots[i].get("velocity", 0)), i))
    nbrs = [i for i in (k - 1, k + 1) if 0 <= i < len(ph_slots)]
    if not nbrs:
        raise ValueError("cannot fold a single-slot phrase")
    n = max(nbrs, key=lambda i: (float(ph_slots[i].get("end", 0)) - float(ph_slots[i].get("start", 0)), -i))
    weak, keep = ph_slots[k], ph_slots[n]
    keep["start"] = min(float(keep["start"]), float(weak["start"]))
    keep["end"] = max(float(keep["end"]), float(weak["end"]))
    keep["segments"] = sorted((keep.get("segments") or []) + (weak.get("segments") or []),
                              key=lambda g: float(g.get("start", 0)))
    for slots in bar_slots.values():
        if any(s is weak for s in slots):
            slots.remove(weak)
    ph_slots.pop(k)


def _split_longest(ph_slots: list, bar_slots: dict) -> None:
    """Split the phrase's longest slot at its midpoint (in place); halves inherit
    pitch/velocity; segments partition at the midpoint."""
    k = max(range(len(ph_slots)),
            key=lambda i: (float(ph_slots[i].get("end", 0)) - float(ph_slots[i].get("start", 0)), -i))
    src = ph_slots[k]
    a, b = float(src["start"]), float(src["end"])
    mid = round((a + b) / 2.0, 4)
    halves = []
    for (h0, h1) in ((a, mid), (mid, b)):
        segs = []
        for g in src.get("segments") or []:
            g0, g1 = float(g.get("start", h0)), float(g.get("end", h1))
            if g1 <= h0 or g0 >= h1:
                continue
            segs.append({**g, "start": round(max(g0, h0), 4), "end": round(min(g1, h1), 4)})
        if not segs:
            pitch = (src.get("segments") or [{}])[0].get("pitch")
            segs = [{"start": h0, "end": h1, "pitch": pitch}]
        halves.append({**{kk: vv for kk, vv in src.items() if kk != "segments"},
                       "start": h0, "end": h1, "segments": segs})
    for slots in bar_slots.values():
        for i, s in enumerate(slots):
            if s is src:
                slots[i:i + 1] = halves
                break
    ph_slots[k:k + 1] = halves


def apply_grid_corrections(skeleton: dict, corrections: dict, *,
                           gap_s: float = GAP_S, min_syllables: int = MIN_SYL) -> dict:
    """Return a corrected COPY of the skeleton with each phrase's slot count set to the
    owner's verdict. Phrase indices follow the round's grouping (gap_s/min_syllables)."""
    out = copy.deepcopy(skeleton)
    phrases = flowspec.group_by_rest(out.get("lineScores") or [],
                                     gap_s=gap_s, min_syllables=min_syllables)
    bar_slots = {ls.get("bar"): ls.get("slots")
                 for ls in out.get("lineScores") or [] if isinstance(ls, dict)}
    for pi, want in sorted((int(k), int(v)) for k, v in corrections.items()):
        if pi < 0 or pi >= len(phrases):
            raise ValueError(f"unknown phrase index {pi} (round has {len(phrases)} phrases)")
        if want < 1:
            raise ValueError(f"phrase {pi}: count must be >= 1")
        ph = phrases[pi]
        while len(ph["slots"]) > want:
            _fold_weakest(ph["slots"], bar_slots)
        while len(ph["slots"]) < want:
            _split_longest(ph["slots"], bar_slots)
    return out


# ── artifacts: per-phrase clips + click overlays + suspicion flags ─────────────────────

def _write_mono(path: Path, mono: list, sr: int) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"".join(struct.pack("<h", max(-32767, min(32767, int(v * 32767))))
                               for v in mono))


def build() -> int:
    skel_path = resolve_skeleton()
    print(f"grid check against: {skel_path.name}", flush=True)
    skel = json.loads(skel_path.read_text())
    spec = flowspec.build_flow_spec(skel, chorus=CHORUS, theme=THEME, gap_s=GAP_S,
                                    min_syllables=MIN_SYL, preserve_words=True)
    take, sr = skcore.read_pcm_mono(str(TAKE))
    GRID.mkdir(parents=True, exist_ok=True)
    rows = []
    for l in spec["lines"]:
        i, slots = l["index"], l["score"]["slots"]
        t0 = max(0.0, l["startS"] - PAD_S)
        t1 = min(len(take) / sr, l["endS"] + PAD_S)
        clip = take[int(t0 * sr):int(t1 * sr)]
        ticked = list(clip)
        tick_n = int(TICK_S * sr)
        for s in slots:
            at = int((float(s["start"]) - t0) * sr)
            for j in range(tick_n):
                if 0 <= at + j < len(ticked):
                    envl = 1.0 - j / tick_n
                    ticked[at + j] += TICK_GAIN * envl * math.sin(2 * math.pi * TICK_HZ * j / sr)
        plain, mixed = GRID / f"clip-L{i:02d}.wav", GRID / f"ticks-L{i:02d}.wav"
        _write_mono(plain, clip, sr)
        _write_mono(mixed, ticked, sr)
        ab_mix.stereo_ab(str(plain), str(mixed), str(GRID / f"grid-L{i:02d}.wav"), sr=sr)

        budget = len(l["mouthTargets"]) or None   # ASR syllable budget (slot-scoped)
        melisma = sum(1 for s in slots if len(s.get("segments") or []) >= 3)
        reasons = []
        if budget is not None and abs(budget - len(slots)) >= 2:
            reasons.append(f"ASR heard ~{budget} syllables vs {len(slots)} slots")
        if melisma:
            reasons.append(f"{melisma} heavy melisma fold{'s' if melisma > 1 else ''}")
        rows.append({"index": i, "slots": len(slots), "startS": l["startS"], "endS": l["endS"],
                     "heardText": l.get("mouthText", ""), "asrBudget": budget,
                     "suspect": bool(reasons), "reasons": reasons,
                     "wav": f"grid/grid-L{i:02d}.wav"})
    MANIFEST.write_text(json.dumps({"gapS": GAP_S, "minSyllables": MIN_SYL, "rows": rows}, indent=2))
    n_sus = sum(1 for r in rows if r["suspect"])
    print(f"{len(rows)} phrases, {n_sus} flagged suspect -> {MANIFEST}", flush=True)
    import backhalf_perform as bp
    bp.page()
    return 0


def apply_cli(arg: str) -> int:
    skel_path = resolve_skeleton()
    print(f"corrections against: {skel_path.name}", flush=True)
    skel = json.loads(skel_path.read_text())
    corrections = json.loads(arg)
    out = apply_grid_corrections(skel, corrections)
    CORRECTED.write_text(json.dumps(out, indent=1))
    counts = [len(p["slots"]) for p in flowspec.group_by_rest(out.get("lineScores") or [],
                                                              gap_s=GAP_S, min_syllables=MIN_SYL)]
    print(f"corrected skeleton -> {CORRECTED} · phrase counts now {counts}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(apply_cli(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[1] == "apply" else build())
