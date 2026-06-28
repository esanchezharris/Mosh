#!/usr/bin/env python3
"""Test for the §5b synth-GUI → §0 Recipe synth-element builder (render/from_screen.py) — the seam
that makes a GUI read DRIVE the §9 render. Deterministic + portable (reads the committed
vital_init.png fixture; no binary / sample-lib / torch). The full render+reward of these params is
the real-data smoke teardown_e2e.py (VERIFY_REAL.md).

Headline guards:
  • the read params are keyed by the PLUGIN's real param names (via the profile's plugin_params
    alias), NOT the §5b control names — i.e. a render's resolve_synths can actually map them;
  • every alias control resolves (no §5b control silently dropped for Vital);
  • graceful on a bad image; deterministic 3×.

    python3 service/teardown/render/from_screen_test.py   (needs cv2/numpy)
"""
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

import cv2  # noqa: E402

from teardown.render.from_screen import synth_element_from_gui  # noqa: E402
from teardown.synth_from_screen.export import plugin_params  # noqa: E402

FIX = os.path.join(_HERE, "..", "synth_from_screen", "fixtures", "vital_init.png")
fails: list[str] = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


# ── the Vital plugin_params alias map is complete + plausible ──────────────────────────────
alias = plugin_params("vital")
check("vital plugin_params maps all 17 §5b controls", len(alias) == 17, str(len(alias)))
check("alias values look like real Vital params (envelope/oscillator/filter ...)",
      all(any(t in v for t in ("envelope", "oscillator", "filter")) for v in alias.values()),
      str(sorted(set(alias.values()))[:3]))
check("alias keys are the §5b control names (env1_*/osc1_*/filter_*)",
      {"env1_sustain", "osc1_level", "filter_drive"} <= set(alias), str(sorted(alias)[:4]))

# ── REAL fixture: vital_init.png → synth Element with PLUGIN-keyed params ────────────────────
if os.path.isfile(FIX):
    el = synth_element_from_gui(FIX, "vital", midi_ref="/tmp/x.mid", note_count=4)
    params = el.synth_patch.params
    check("synth element built (plugin Vital, status params_visible)",
          el.synth_patch.plugin.name == "Vital" and el.synth_patch.status.value == "params_visible",
          f"{el.synth_patch.plugin.name}/{el.synth_patch.status}")
    check("17 params read + translated", len(params) == 17, str(len(params)))
    check("params keyed by PLUGIN names, not §5b control names",
          all(k not in ("env1_sustain", "osc1_level", "filter_drive") for k in params)
          and "envelope 1 sustain" in params and "oscillator 1 level" in params, str(sorted(params)[:3]))
    check("every param normalized to [0,1] (set_plugin_param accepts)",
          all(isinstance(v, (int, float)) and 0.0 <= v <= 1.0 for v in params.values()),
          str([v for v in params.values() if not (0.0 <= v <= 1.0)]))
    check("the read carries non-trivial values (not all 0)",
          any(v > 0.0 for v in params.values()), str(params))
    check("midi wired through (status extracted, ref + count)",
          el.midi.status.value == "extracted" and el.midi.midi_ref == "/tmp/x.mid"
          and el.midi.note_count == 4, str(el.midi))
    check("role/label/id set", el.role.value == "lead" and el.label == "Lead" and el.element_id == "lead")
else:
    check("vital_init.png fixture present", False, FIX)

# ── graceful: a bad/empty image → unknown status, no params, no crash ────────────────────────
bad = synth_element_from_gui(np.zeros((4, 0, 3), np.uint8), "vital")
check("zero-dim image → unknown, empty params (no crash)",
      bad.synth_patch.status.value == "unknown" and not bad.synth_patch.params, str(bad.synth_patch))
none_el = synth_element_from_gui(None, "vital")
check("None image → unknown, empty params (no crash)",
      none_el.synth_patch.status.value == "unknown" and not none_el.synth_patch.params)
unknown_synth = synth_element_from_gui(cv2.imread(FIX) if os.path.isfile(FIX) else
                                       np.full((10, 10, 3), 20, np.uint8), "nope_not_a_synth")
check("unknown synth profile → unknown, empty params (no crash)",
      unknown_synth.synth_patch.status.value == "unknown" and not unknown_synth.synth_patch.params)

# ── determinism: identical params across 3 builds ───────────────────────────────────────────
if os.path.isfile(FIX):
    outs = [synth_element_from_gui(FIX, "vital").synth_patch.params for _ in range(3)]
    check("from_screen deterministic x3", outs[0] == outs[1] == outs[2])

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
