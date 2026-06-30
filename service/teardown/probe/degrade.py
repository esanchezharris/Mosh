#!/usr/bin/env python3
"""Subtle, in-time, NON-broken taste reductions — the low end of the v2 spread.

v1's "bad" candidates were broken (out-of-time) → a structural defect, not taste. v2's degraded
candidates stay on-grid, in-key-ish, and clean, but make a SUBTLE production/arrangement choice a
producer would rate lower: a slightly off 808, a thin or muddy balance, or a dull pattern. The
owner's 1–7 then measures taste, and we see whether `pull` tracks those subtle calls.

Reuses beats._beat_program over the same real pools; each degraded beat applies exactly one flaw.
"""
from __future__ import annotations

import beats as B
import kit as K
import samples as S

# (label, intent, kwargs-override) — each a single subtle flaw over a competent beat.
DEGRADES = [
    ("off_key_bass", "deg_harmony", dict(bass_transpose=1)),                          # 808 a semitone off
    ("thin_mix",     "deg_mix",     dict(keys_db=B.GAINS["keys_db"] - 12, bass_db=B.GAINS["bass_db"] - 10)),  # hollow/weak
    ("loud_muddy",   "deg_mix",     dict(keys_db=B.GAINS["keys_db"] + 6, bass_db=B.GAINS["bass_db"] + 4, drums_db=B.GAINS["drums_db"] + 2)),  # everything fighting
    ("plain_pattern","deg_arr",     None),                                            # dull but on-grid (feel=plain)
]


def build_degraded(n_target: int = 24) -> list[dict]:
    cat = S.catalog()
    kits = K.load_kits()
    e8 = K.eight08s()
    if not (cat and kits and e8):
        return []
    cands, i = [], 0
    for mi, mel in enumerate(cat):
        for off in (0, 1):  # two distinct subtle flaws per melodic loop → ~2× len(cat)
            dl, intent, override = DEGRADES[(mi + off) % len(DEGRADES)]
            kitc = kits[mi % len(kits)]
            e808 = e8[mi % len(e8)]
            gains = dict(B.GAINS)
            feel = "trap"
            kw = dict(seed=4000 + i)
            if dl == "plain_pattern":
                feel = "plain"
            elif override:
                for k, v in override.items():
                    (gains if k.endswith("_db") else kw).__setitem__(k, v)
            prog = B._beat_program(mel, kitc, e808, feel, **gains, **kw)
            cands.append({"cand_id": f"deg_{mel['id']}_{dl}", "group": f"deg_{mel['id']}", "label": dl,
                          "intent": intent, "kind": "program", "program": prog,
                          "meta": {"bpm": mel["bpm"], "key": mel["key"], "kit": kitc["id"], "degrade": dl, "mel": mel["id"]}})
            i += 1
            if len(cands) >= n_target:
                return cands
    return cands


if __name__ == "__main__":
    cs = build_degraded()
    print(f"{len(cs)} degraded beats")
    from collections import Counter
    print("types:", dict(Counter(c["label"] for c in cs)))
