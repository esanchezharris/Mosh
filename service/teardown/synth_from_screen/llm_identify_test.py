#!/usr/bin/env python3
"""Hermetic test for the vision-LLM synth identifier (§5b). No network: the per-frame vision call is
injected with canned JSON. Asserts the per-video majority VOTE, the display-name → profile-key map
(Serum 2→serum, Serum→serum1, Vital→vital, unknown→None), one-off-misread rejection, the no-key
'could not run' (None) vs ran-but-empty ([]) contract, and determinism.

    python3 service/teardown/synth_from_screen/llm_identify_test.py   (needs cv2/numpy)
"""
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown.synth_from_screen.llm_identify import identify_synths, _profile_key  # noqa: E402

fails: list[str] = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


def frames(n):
    # distinct tiny images; content is irrelevant (the call is injected) but must encode as JPEG
    return [np.full((16, 16, 3), (i * 7) % 255, np.uint8) for i in range(n)]


def canned(responses):
    """A call() that returns the next canned JSON string per frame, then repeats the last."""
    box = {"i": 0}

    def call(_b64):
        i = min(box["i"], len(responses) - 1)
        box["i"] += 1
        return responses[i]
    return call


# keep the ambient GEMINI_API_KEY out of the way so the no-key path is truly hermetic
_saved = os.environ.pop("GEMINI_API_KEY", None)
try:
    J = lambda name, conf=1.0, known=True, comps='["wavetable","filter"]': (
        f'{{"name":{("null" if name is None else chr(34)+name+chr(34))},"known":{str(known).lower()},'
        f'"confidence":{conf},"components":{comps}}}')

    # ── majority vote + one-off rejection ─────────────────────────────────────────────────────
    r = identify_synths(frames(10), call=canned([J("Vital")] * 9 + [J("Serum")]), max_frames=20)
    check("vote: 9×Vital + 1×Serum → Vital only (one-off Serum dropped)",
          [x["name"] for x in r] == ["Vital"], str(r))
    check("Vital → profile_key 'vital', known, components carried",
          r[0]["profile_key"] == "vital" and r[0]["known"] and "wavetable" in r[0]["components"])

    # ── display-name → profile-key map (the Serum1/Serum2 distinction the pixel methods missed) ──
    check("'Serum 2' → profile 'serum'",
          identify_synths(frames(4), call=canned([J("Serum 2")]), max_frames=20)[0]["profile_key"] == "serum")
    check("'Serum' → profile 'serum1'",
          identify_synths(frames(4), call=canned([J("Serum")]), max_frames=20)[0]["profile_key"] == "serum1")
    check("'Xfer Records Serum' normalizes (xfer prefix stripped) → serum1",
          identify_synths(frames(4), call=canned([J("Xfer Records Serum")]), max_frames=20)[0]["profile_key"] == "serum1")

    # ── the UNKNOWN seventh synth: named, no profile, components returned (for §8 substitute) ────
    u = identify_synths(frames(4), call=canned([J("Pigments", known=False, comps='["wavetable","granular","filter"]')]),
                        max_frames=20)
    check("unknown synth 'Pigments' → kept, profile_key None, known False, components present",
          u and u[0]["name"] == "Pigments" and u[0]["profile_key"] is None and not u[0]["known"]
          and "granular" in u[0]["components"], str(u))

    # ── low-confidence ignored ─────────────────────────────────────────────────────────────────
    check("a synth seen only at low confidence is ignored",
          identify_synths(frames(6), call=canned([J("Vital", conf=0.3)] * 6), max_frames=20) == [])

    # ── two genuine synths both clear the share floor ──────────────────────────────────────────
    two = identify_synths(frames(10), call=canned([J("Vital")] * 5 + [J("Serum 2")] * 5), max_frames=20)
    check("two synths each on half the frames → both returned",
          {x["profile_key"] for x in two} == {"vital", "serum"}, str(two))

    # ── ran-but-no-synth ([]) vs could-not-run (None) ──────────────────────────────────────────
    check("all frames null → [] (ran, no synth)",
          identify_synths(frames(5), call=canned([J(None)] * 5), max_frames=20) == [])
    check("no key and no injected call → None (could not run → caller falls back)",
          identify_synths(frames(3), key="", call=None) is None)
    check("every call errors → None (could not run)",
          identify_synths(frames(3), call=(lambda b: (_ for _ in ()).throw(RuntimeError("net")))) is None)

    # ── determinism ────────────────────────────────────────────────────────────────────────────
    runs = {tuple((x["name"], x["profile_key"], x["votes"]) for x in
                  identify_synths(frames(10), call=canned([J("Vital")] * 9 + [J("Serum")]), max_frames=20))
            for _ in range(3)}
    check("deterministic x3", len(runs) == 1)

    # ── _profile_key unit ──────────────────────────────────────────────────────────────────────
    check("_profile_key maps", (_profile_key("Serum 2"), _profile_key("serum"), _profile_key("Vital"),
                                 _profile_key("Massive")) == ("serum", "serum1", "vital", None))
finally:
    if _saved is not None:
        os.environ["GEMINI_API_KEY"] = _saved

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
