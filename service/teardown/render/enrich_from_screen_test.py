#!/usr/bin/env python3
"""Test for the §4→§5b auto-wiring (render/from_screen.py:enrich_synths_from_frames) — the seam that
upgrades a skeleton synth element (status 'unknown', plugin named by §4 OCR) into a real read patch by
locating + reading its GUI off the captured keyframes, so it loads + plays at the §9 render. Closes the
live-teardown `synths_loaded 0` gap.

Deterministic + portable (reads the committed vital_init.png fixture + synthetic frames; no binary /
sample-lib / torch). The headline guards:
  • a named-Vital skeleton element is UPGRADED to params_visible with PLUGIN-keyed params from the GUI;
  • CONSTRAINED detection — a plugin with no installed profile (Massive) is left untouched (no blind read);
  • the confidence gate holds — with no confident Vital frame present, nothing upgrades;
  • already-read and non-synth elements are never touched/overwritten; deterministic 3×.

    python3 service/teardown/render/enrich_from_screen_test.py   (needs cv2/numpy)
"""
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

import cv2  # noqa: E402

from teardown import recipe as R  # noqa: E402
from teardown.render.from_screen import (_candidate_profiles, _profile_metas,  # noqa: E402
                                         enrich_synths_from_frames)
from teardown.vision.frames import Frame  # noqa: E402

FIX = os.path.join(_HERE, "..", "synth_from_screen", "fixtures", "vital_init.png")
fails: list[str] = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


def _recipe():
    """A skeleton with a named-but-unread Vital, a named-but-no-profile Massive, an already-read
    Vital (must NOT be re-touched), and a drum element (no synth read)."""
    return R.Recipe(elements=[
        R.Element(element_id="synth_0", role="lead", label="Vital lead",
                  synth_patch=R.SynthPatch(status="unknown", plugin=R.Plugin(name="Vital"))),
        R.Element(element_id="synth_1", role="lead", label="Massive",
                  synth_patch=R.SynthPatch(status="unknown", plugin=R.Plugin(name="Massive"))),
        R.Element(element_id="synth_2", role="lead", label="already read",
                  synth_patch=R.SynthPatch(status="params_visible", plugin=R.Plugin(name="Vital"),
                                           params={"oscillator 1 level": 0.5})),
        R.Element(element_id="kick_0", role="kick", audio_ref="/tmp/k.wav"),
    ])


# ── candidate resolution (constrained, name-driven; never blind) ─────────────────────────────
metas = _profile_metas()
check("installed profiles have detectable tab strips (vital present)", "vital" in metas, str(sorted(metas)))
check("'Vital' resolves to the vital profile only", _candidate_profiles("Vital", metas) == ["vital"],
      str(_candidate_profiles("Vital", metas)))
check("'Serum' resolves to the serum family (serum + serum1), not vital",
      set(_candidate_profiles("Serum", metas)) == {"serum", "serum1"},
      str(_candidate_profiles("Serum", metas)))
check("an un-profiled plugin (Massive) resolves to no candidates",
      _candidate_profiles("Massive", metas) == [], str(_candidate_profiles("Massive", metas)))

if not os.path.isfile(FIX):
    check("vital_init.png fixture present", False, FIX)
    print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
    sys.exit(len(fails))

vital_img = cv2.imread(FIX)
gray = np.full((900, 1400, 3), 40, np.uint8)            # a non-synth frame: no saturated tab strip
frames = [Frame(0.0, gray), Frame(3.0, vital_img), Frame(6.0, gray)]

# ── the upgrade: a named Vital element reads its GUI off the keyframes ───────────────────────
rec = _recipe()
n = enrich_synths_from_frames(rec, frames)
by_id = {e.element_id: e for e in rec.elements}
check("exactly one element upgraded", n == 1, str(n))

s0 = by_id["synth_0"].synth_patch
check("synth_0 (Vital) upgraded to params_visible", s0.status.value == "params_visible", str(s0.status))
check("synth_0 plugin name preserved as Vital", s0.plugin.name == "Vital", str(s0.plugin.name))
check("synth_0 params keyed by PLUGIN names, not §5b control names",
      "envelope 1 sustain" in s0.params and "oscillator 1 level" in s0.params
      and "env1_sustain" not in s0.params, str(sorted(s0.params)[:3]))
check("synth_0 params all normalized [0,1]",
      all(isinstance(v, (int, float)) and 0.0 <= v <= 1.0 for v in s0.params.values()),
      str([v for v in s0.params.values() if not (0.0 <= v <= 1.0)]))
check("synth_0 carries non-trivial values (read landed)", any(v > 0.0 for v in s0.params.values()))

s1 = by_id["synth_1"].synth_patch
check("synth_1 (Massive, no profile) left UNKNOWN — no blind read",
      s1.status.value == "unknown" and not s1.params, str(s1.status))

s2 = by_id["synth_2"].synth_patch
check("synth_2 (already read) NOT overwritten", s2.params == {"oscillator 1 level": 0.5}, str(s2.params))

check("kick_0 (no synth read) untouched", by_id["kick_0"].synth_patch.status.value == "unknown")

# ── confidence gate: no confident Vital frame → no upgrade ───────────────────────────────────
rec2 = _recipe()
n2 = enrich_synths_from_frames(rec2, [Frame(0.0, gray), Frame(1.0, gray)])
check("no synth-GUI frame → nothing upgraded (confidence gate)",
      n2 == 0 and {e.element_id: e for e in rec2.elements}["synth_0"].synth_patch.status.value == "unknown",
      str(n2))

# ── ambiguity guard: when two sibling profiles BOTH fire on the winning frame, skip (no mislabel).
#    Driven via stubs so the guard is proven to ACTIVELY block an upgrade that would otherwise land
#    (serum/serum1 have no real alias yet, so this latent path can't be exercised with fixtures). ──
import teardown.render.from_screen as fs              # noqa: E402
import teardown.synth_from_screen.page_detect as pd   # noqa: E402

_orig_detect, _orig_build = pd.detect_active_tab, fs.synth_element_from_gui


def _stub_build(img, synth, *, element_id="lead", role="lead", label="Lead", **kw):
    # pretend ANY read succeeds — so only the guard can prevent an upgrade
    return R.Element(element_id=element_id, role=role, label=label,
                     synth_patch=R.SynthPatch(status="params_visible",
                                              plugin=R.Plugin(name=fs._plugin_name(synth)),
                                              params={"x": 0.5}))


def _serum_recipe():
    return R.Recipe(elements=[R.Element(element_id="s", role="lead", label="Serum",
                    synth_patch=R.SynthPatch(status="unknown", plugin=R.Plugin(name="Serum")))])


try:
    fs.synth_element_from_gui = _stub_build
    # both serum + serum1 fire confidently on the frame → ambiguous → must skip
    pd.detect_active_tab = lambda img, key: ({"tab": "FX", "confidence": 0.9, "strength": 10.0}
                                             if key in ("serum", "serum1") else {"tab": None})
    rec_amb = _serum_recipe()
    n_amb = enrich_synths_from_frames(rec_amb, [Frame(0.0, gray)])
    check("ambiguous match (Serum→serum+serum1 both fire) → NOT upgraded (guard blocks mislabel)",
          n_amb == 0 and rec_amb.elements[0].synth_patch.status.value == "unknown", str(n_amb))
    # only one sibling fires → unambiguous → the (stubbed) read lands, proving the guard isn't
    # just blocking everything
    pd.detect_active_tab = lambda img, key: ({"tab": "FX", "confidence": 0.9, "strength": 10.0}
                                             if key == "serum" else {"tab": None})
    rec_one = _serum_recipe()
    n_one = enrich_synths_from_frames(rec_one, [Frame(0.0, gray)])
    check("unambiguous single match → upgrades (guard allows the clear case)",
          n_one == 1 and rec_one.elements[0].synth_patch.status.value == "params_visible", str(n_one))
finally:
    pd.detect_active_tab, fs.synth_element_from_gui = _orig_detect, _orig_build

# ── graceful: empty frames / no elements ────────────────────────────────────────────────────
check("empty frame list → 0 (no crash)", enrich_synths_from_frames(_recipe(), []) == 0)
check("empty recipe → 0 (no crash)", enrich_synths_from_frames(R.Recipe(), frames) == 0)

# ── determinism: same upgrade + same params across 3 runs ────────────────────────────────────
outs = []
for _ in range(3):
    r = _recipe()
    cnt = enrich_synths_from_frames(r, frames)
    p = {e.element_id: e for e in r.elements}["synth_0"].synth_patch.params
    outs.append((cnt, tuple(sorted(p.items()))))
check("enrich deterministic x3", outs[0] == outs[1] == outs[2], str(outs[0][0]))

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
