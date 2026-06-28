"""Bridge §5b synth-GUI read (+ optional §5 screen-read MIDI) → a §0 Recipe synth Element, so a
GUI read actually DRIVES the §9 render. This is the synth analog of from_extraction.py (which builds
drum elements from §1 matches).

The load-bearing step is the §5b-control-name → plugin-param-name translation: §5b profiles read
controls under their own keys ("env1_sustain", "osc1_level"), but §9's resolve_synths maps
synth_patch.params by the plugin's ACTUAL param name. The profile's `plugin_params` alias bridges
them (synth_from_screen.export.plugin_params), so the read lands on set_plugin_param instead of in
`unresolved`. Only controls with a known alias AND a normalized [0,1] value are kept (toggles/menus
and out-of-range reads are dropped — honest: they couldn't be applied as a normalized param anyway).
"""
from __future__ import annotations

import json
import os
from typing import Optional

from teardown.recipe import Element, Midi, Plugin, SynthPatch
from teardown.synth_from_screen.export import (PROFILE_DIR, load_profile, plugin_params,
                                               read_patch)


def _plugin_name(synth: str) -> str:
    """The hosted plugin's display name to resolve by (profile `synth` field, e.g. 'Vital',
    'Serum 2'); falls back to the profile key."""
    path = os.path.join(PROFILE_DIR, f"{synth.lower()}.json")
    if os.path.isfile(path):
        with open(path) as f:
            return json.load(f).get("synth", synth) or synth
    return synth


def synth_element_from_gui(img, synth: str, *, element_id: str = "lead", role: str = "lead",
                           label: str = "Lead", midi_ref: Optional[str] = None,
                           note_count: int = 0) -> Element:
    """Read `img` (a BGR array or a path) with the `synth` §5b profile → a synth Element whose
    params are keyed by the plugin's REAL param names (via the profile's plugin_params alias) and
    clamped to the normalized [0,1] set_plugin_param accepts. status=params_visible when any param
    survives, else unknown. Never raises on a bad image (→ empty params)."""
    import cv2

    if isinstance(img, str):
        img = cv2.imread(img)

    params: dict = {}
    if img is not None and getattr(img, "ndim", 0) == 3:
        try:
            prof = load_profile(synth, img.shape[1], img.shape[0], img)
            read = read_patch(img, prof)
            alias = plugin_params(synth)
            for cname, val in (read.get("params") or {}).items():
                if isinstance(val, bool) or not isinstance(val, (int, float)):
                    continue                       # toggles/menus aren't normalized params
                if not (0.0 <= float(val) <= 1.0):
                    continue
                pname = alias.get(cname)
                if pname:                          # keep only controls with a known plugin mapping
                    params[pname] = round(float(val), 4)
        except Exception:                          # a profile/read quirk must not break Recipe build
            params = {}

    sp = SynthPatch(status="params_visible" if params else "unknown",
                    plugin=Plugin(name=_plugin_name(synth), available_locally=True),
                    params=params)
    midi = (Midi(status="extracted", midi_ref=midi_ref, note_count=note_count, confidence=0.8)
            if midi_ref else Midi())
    return Element(element_id=element_id, role=role, label=label, midi=midi, synth_patch=sp,
                   confidence=0.7)
