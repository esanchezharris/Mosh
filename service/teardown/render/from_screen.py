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
from teardown.synth_from_screen.page_detect import norm_name, profile_metas


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


def _candidate_profiles(ocr_name: str, metas: dict) -> list:
    """Profiles whose key OR display name relate to an OCR'd plugin name — the CONSTRAINED set we
    test a frame against. We never blind-identify (page_detect.identify_synth cross-fires Vital↔Serum
    and would mislabel); the §4 OCR already named the plugin, so we only ever read a frame with the
    profile(s) that name resolves to. 'Serum' → both serum/serum1 (detect_active_tab disambiguates;
    they don't cross-fire with each other), 'Vital' → vital only."""
    o = norm_name(ocr_name)
    out: list = []
    if not o:
        return out
    for key, disp in metas.items():
        k, d = norm_name(key), norm_name(disp)
        if k and (k in o or o in k):
            out.append(key)
        elif d and (d in o or o in d):
            out.append(key)
    return out


def enrich_synths_from_frames(rec, frames, *, min_conf: float = 0.6) -> int:
    """Upgrade skeleton synth elements from the captured GUI keyframes (the §4→§5b seam).

    For each element whose patch is still UNREAD (status 'unknown') and whose plugin was named by
    §4 OCR, find the keyframe that most confidently shows THAT synth's GUI — testing ONLY the
    profile(s) the plugin name resolves to (constrained, never blind) — and read its params via
    §5b, replacing the element's synth_patch in place. Gated so it's never "worse than no profile":
      • the frame must clear `min_conf` for the named synth;
      • AMBIGUITY GUARD — if a sibling candidate profile (e.g. Serum 1 vs Serum 2, when OCR only
        said "Serum") ALSO clears `min_conf` on that same frame, the synth can't be told apart
        here, so we skip rather than risk reading with the wrong geometry / mislabeling. Makes
        "constrained detection never mislabels" a code invariant, not a CV-calibration accident;
      • the read must yield params (status 'params_visible').
    Otherwise the element is left untouched. The upgraded element's plugin name becomes the matched
    profile's display name (the host-loadable id that §9 resolve_synths loads by) — which, when the
    match is unambiguous, is a STRICTER id than the OCR'd name (it tells Serum 1 from Serum 2).
    Never downgrades, never fabricates a plugin, never adds elements. No-ops gracefully (returns 0)
    when cv2 / profiles / frames are absent. Returns the number of elements upgraded.
    """
    try:
        from teardown.synth_from_screen.page_detect import detect_active_tab
    except Exception:
        return 0
    metas = profile_metas()
    if not metas or not frames:
        return 0

    upgraded = 0
    for el in rec.elements:
        sp = getattr(el, "synth_patch", None)
        if sp is None or getattr(sp.status, "value", sp.status) != "unknown":
            continue
        if not (sp.plugin and sp.plugin.name):
            continue
        cands = _candidate_profiles(sp.plugin.name, metas)
        if not cands:
            continue
        # detect each candidate on each frame; track the global best + per-frame confidences
        # (the latter feeds the ambiguity guard on the winning frame).
        best = None              # (conf, strength, frame_idx, profile_key)
        per_frame: dict = {}     # frame_idx -> {profile_key: confidence}
        imgs: dict = {}          # frame_idx -> image
        for fi, fr in enumerate(frames):
            img = getattr(fr, "image", None)
            if img is None or getattr(img, "ndim", 0) != 3 or getattr(img, "size", 0) == 0:
                continue
            imgs[fi] = img
            for key in cands:
                r = detect_active_tab(img, key)
                # require a LOGO-CONFIRMED calibration — a proportional-fallback tab read (the
                # synth's logo wasn't located) can confidently mis-fire on another synth's GUI.
                if not r.get("tab") or not r.get("host_invariant"):
                    continue
                conf = float(r.get("confidence", 0.0) or 0.0)
                stg = float(r.get("strength", 0.0) or 0.0)
                per_frame.setdefault(fi, {})[key] = conf
                if best is None or (conf, stg) > (best[0], best[1]):
                    best = (conf, stg, fi, key)
        if best is None or best[0] < min_conf:
            continue
        # ambiguity guard: >1 candidate clearing min_conf on the WINNING frame → can't disambiguate
        if sum(1 for c in per_frame.get(best[2], {}).values() if c >= min_conf) > 1:
            continue
        read = synth_element_from_gui(imgs[best[2]], best[3], element_id=el.element_id,
                                      role=getattr(el.role, "value", el.role),
                                      label=el.label or "Lead")
        if getattr(read.synth_patch.status, "value", read.synth_patch.status) == "params_visible":
            el.synth_patch = read.synth_patch
            upgraded += 1
    return upgraded


def _lead_synth_element(rec):
    """The element a screen-read MIDI part should drive: a synth element that still has NO MIDI, or
    the skeleton's bare 'piano-roll' midi placeholder; else None. Never returns an element that
    already carries real MIDI — a rough screen read must not overwrite a better-sourced part
    (e.g. a §7 'extracted' line). Only elements with midi.status 'unknown' are eligible."""
    def unread(e):
        return getattr(e.midi.status, "value", e.midi.status) == "unknown"
    synths = [e for e in rec.elements if getattr(e, "synth_patch", None) and e.synth_patch.plugin
              and e.synth_patch.plugin.name and unread(e)]
    if synths:
        return synths[0]
    for e in rec.elements:                             # the skeleton's 'piano roll part' placeholder
        if unread(e) and getattr(e.role, "value", e.role) == "other":
            return e
    return None


def _is_fine_grid(crop, min_lanes: int = 12) -> bool:
    """True if `crop` is a FINE semitone grid (a piano roll: many closely-spaced horizontal lane
    lines) rather than a COARSE track grid (a DAW arrangement view, whose few tall rows + coloured
    clips would otherwise be mis-read as bogus 'notes'). Counts distinct full-width horizontal lines;
    a piano roll has dozens of semitone lanes, an arrangement only a handful of tracks."""
    try:
        import cv2
        import numpy as np
    except Exception:
        return False
    g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    cw = g.shape[1]
    if cw == 0:
        return False
    edges = cv2.Canny(g, 50, 150)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=80,
                            minLineLength=int(cw * 0.5), maxLineGap=8)
    if lines is None:
        return False
    ys = sorted(int((y1 + y2) / 2) for x1, y1, x2, y2 in lines[:, 0, :]
                if abs(y2 - y1) <= 3 and abs(x2 - x1) > cw * 0.5)
    uniq: list = []
    for y in ys:                                        # dedup near-coincident lane lines
        if not uniq or y - uniq[-1] > 2:
            uniq.append(y)
    return len(uniq) >= min_lanes


def midi_from_frames(rec, frames, *, out_dir, bpm: Optional[float] = None,
                     min_notes: int = 3, max_notes: int = 256) -> dict:
    """Locate the piano-roll in the keyframes, read its notes (§5), and attach the resulting MIDI
    to the lead synth element so the synth plays a part at §9 render (the §4→§5 seam).

    Conservative + gated, but HONESTLY heuristic — it attaches only when a frame passes three
    gates: (1) a roll region is localized (piano_roll_present bbox), (2) the cropped region is a
    FINE semitone grid, not a coarse DAW-arrangement track grid (_is_fine_grid — the arrangement
    view also has grid lines + coloured clips, so this is the load-bearing anti-garbage check),
    and (3) the recovered notes are plausible (count in [min_notes, max_notes], sane pitches,
    positive durations). It still can't guarantee a regular-grid arrangement is never mis-read,
    so the attached part is marked status='partial', confidence 0.4 (NOT presented as high
    confidence) and the recipe stays needs_review. Absolute pitch carries the roll's scroll offset
    (detect_axes' top_midi is a default) — the RHYTHM is the reliable signal, not the octave.
    No-ops gracefully (returns {'attached': False}) without cv2 / a roll / a target element.
    Returns {attached, notes, midi_ref, element_id}.
    """
    try:
        import os as _os

        from teardown.midi_from_screen import detect_notes, write_midi
        from teardown.midi_from_screen.axes import detect_axes
        from teardown.vision.pianoroll import piano_roll_present
    except Exception:
        return {"attached": False}
    if not frames:
        return {"attached": False}

    # the keyframe whose piano-roll is most confidently localized AND is a fine semitone grid
    best = None  # (confidence, crop_image)
    for fr in frames:
        img = getattr(fr, "image", None)
        if img is None or getattr(img, "ndim", 0) != 3 or getattr(img, "size", 0) == 0:
            continue
        pr = piano_roll_present(img)
        if not (pr.get("present") and pr.get("bbox")):
            continue
        x, y, w, h = pr["bbox"]
        crop = img[y:y + h, x:x + w]
        if crop.size == 0 or not _is_fine_grid(crop):
            continue
        if best is None or pr.get("confidence", 0.0) > best[0]:
            best = (pr.get("confidence", 0.0), crop)
    if best is None:
        return {"attached": False}

    try:
        axes = detect_axes(best[1])
        notes = detect_notes(best[1], axes)
    except Exception:
        return {"attached": False}
    notes = [n for n in notes if 12 <= n["pitch"] <= 120 and n["end"] > n["start"]]
    if not (min_notes <= len(notes) <= max_notes):
        return {"attached": False}

    target = _lead_synth_element(rec)
    if target is None:
        return {"attached": False}

    tempo = bpm
    if tempo is None:
        tv = getattr(rec.meta.tempo_bpm, "value", None)
        tempo = float(tv) if tv else 140.0
    _os.makedirs(out_dir, exist_ok=True)
    mid = _os.path.join(out_dir, f"{target.element_id}_from_screen.mid")
    try:
        write_midi(notes, mid, bpm=tempo)
    except Exception:
        return {"attached": False}
    target.midi = Midi(status="partial", midi_ref=mid, note_count=len(notes), confidence=0.4)
    return {"attached": True, "notes": len(notes), "midi_ref": mid, "element_id": target.element_id}
