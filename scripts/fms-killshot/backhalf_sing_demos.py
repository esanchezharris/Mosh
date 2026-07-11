#!/usr/bin/env python3
"""Demo scores — isolate WHERE the SoulX word-lane falls short: the lyrics/alignment, or the engine?

Owner's hypothesis after hearing the first render: the engine is close; the problem is the
LYRICS and how they align to the syllables (+ a few wrong notes). Four scores, same section,
same voice ref, same pipeline — only the score content varies:

  d1-control     the exact score already heard (LLM words, current alignment) — re-rendered
                 in the same pod session so every demo shares identical conditions.
  d2-take-words  the mumble's OWN words on their own slots ("la" in the gaps). If this sits
                 naturally, engine+melody are fine -> the problem is which words we wrote.
  d3-hand-fit    hand-written lyric, exactly 1 syllable per slot, natural stress, echoing the
                 take's kept words. If d3 >> d1 -> lyrics/alignment is the lever.
  d4-pitch-clean d3's words with pitch HYGIENE: every note snapped to B major, octave
                 outliers clamped. If the wrong notes vanish -> they're Basic-Pitch
                 measurement noise in the skeleton, deterministically fixable.

Deterministic; asserts every hand line hits its slot count exactly. Writes into the same
sing-handoff dir remote_sing_multi.sh consumes. Nothing enters git.
"""
from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from backhalf_ab_bench import BH, CHORUS, SECT0, SECT1, THEME, slice_and_rebase  # noqa: E402
from backhalf_flowfit_ab import authored_for  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "service"))
from lyrics import core as lcore  # noqa: E402
from lyrics import flowspec  # noqa: E402
from soulx import score as sx  # noqa: E402

HANDOFF = BH / "sing-handoff"
SCORES = HANDOFF / "scores"

# B major pitch classes (B C# D# E F# G# A#)
SCALE = {11, 1, 3, 4, 6, 8, 10}

# d3 hand-fit: exact syllable counts per phrase-line (asserted below), echoing the take's
# kept words (scars/scarver · sorry · burns/timeline · gone · can't) with natural stress.
HAND_LINES = [
    "Scars, I feel like Scarver, old flame gone",   # 9
    "I'm still sorry",                               # 4
    "old burns on my timeline",                      # 6
    "we're too far gone",                            # 4
    "still can't pray",                              # 3
]


def snap_scale(p: int) -> int:
    """Nearest B-major pitch (ties prefer the lower neighbor). Deterministic."""
    for k in sorted(range(-6, 7), key=lambda k: (abs(k), k)):
        if (p + k) % 12 in SCALE:
            return p + k
    return p


def pitch_clean(slots: list) -> list:
    """Snap every segment pitch to B major + clamp octave outliers toward the line median."""
    all_p = [snap_scale(int(g.get("pitch", 69))) for s in slots for g in s.get("segments") or []]
    med = statistics.median(all_p) if all_p else 69
    out = []
    for s in slots:
        segs = []
        for g in s.get("segments") or []:
            p = snap_scale(int(g.get("pitch", 69)))
            while p - med > 7:
                p -= 12
            while med - p > 7:
                p += 12
            segs.append({**g, "pitch": p})
        out.append({**s, "segments": segs})
    return out


def author(name: str, lines: list) -> None:
    r = sx.author_score(lines)
    assert r.get("ok"), (name, r)
    (SCORES / f"{name}.json").write_text(json.dumps(r["score"], indent=1))
    print(f"  {name}: {r['words']} words / {r['rests']} rests / {r['duration_s']}s")


def main() -> int:
    SCORES.mkdir(parents=True, exist_ok=True)
    for old in SCORES.glob("*.json"):
        old.unlink()

    skel = json.loads((BH / "skeleton.json").read_text())
    sec = slice_and_rebase(skel, SECT0, SECT1)
    spec = flowspec.build_flow_spec(sec, chorus=CHORUS, theme=THEME, gap_s=0.35,
                                    min_syllables=2, preserve_words=True)
    lines = spec["lines"]
    targets = [l["syllableTarget"] for l in lines]
    print(f"section lines: {targets} (seeds: {[l['seedText'] for l in lines]})")

    # d1 — control: the exact score the owner already heard
    saved = {w["index"]: w["text"] for w in json.loads((BH / "flowfit-ab.json").read_text())["words"]}
    d1 = [{"index": l["index"], "text": saved[l["index"]], "score": l["score"]}
          for l in lines if saved.get(l["index"])]
    author("d1-control", authored_for(d1, condition=True))

    # d2 — the take's own words at their own slots; gaps sung as "la"
    d2 = [{"index": l["index"],
           "text": " ".join(t if t != "___" else "la" for t in l["seedText"].split()),
           "score": l["score"]} for l in lines]
    author("d2-take-words", authored_for(d2, condition=True))

    # d3 — hand-fit: EXACT slot counts, natural stress (hard-asserted)
    assert len(HAND_LINES) == len(lines), f"{len(HAND_LINES)} hand lines vs {len(lines)} phrases"
    for text, tgt in zip(HAND_LINES, targets):
        got = lcore.syllables(text)
        assert got == tgt, f"hand line {text!r}: {got} syllables, slot count is {tgt}"
    d3 = [{"index": l["index"], "text": t, "score": l["score"]}
          for l, t in zip(lines, HAND_LINES)]
    author("d3-hand-fit", authored_for(d3, condition=True))

    # d4 — d3's words, pitch-cleaned slots
    d4 = []
    for entry in authored_for(d3, condition=True):
        d4.append({**entry, "score": {**entry["score"], "slots": pitch_clean(entry["score"]["slots"])}})
    author("d4-pitch-clean", d4)

    print(f"\nscores staged -> {SCORES}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
