"""Tab/page detection — which page of a synth GUI is on screen, so §5b loads the right page
profile. Reads the active-tab indicator (a coloured underline in Vital, a green dot in Serum)
from the tab strip and maps it to the nearest tab anchor. Pure CV (no OCR) → hermetic.

A synth profile declares its tab strip in a `"tabs"` block (reference-pixel space, scaled to
the frame like the control coords):
    "tabs": {"band": [y0, y1], "highlight": "green"|"saturated", "anchors": {name: x, ...}}

`detect_active_tab(img, synth)` returns {"tab", "confidence", "peak_x"}. The synth is normally
known from §4 (the tutorial's plugin-name OCR/metadata); `identify_synth` is a best-effort
fallback that picks whichever profile yields the strongest, cleanest highlight.
"""
from __future__ import annotations

import json
import os
import re

import numpy as np

from .calib import axis_map

PROFILE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "profiles")


def norm_name(s: str) -> str:
    """Normalize a synth name for matching (lowercase, alnum only)."""
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def profile_metas() -> dict:
    """{profile_key: display_name} for installed profiles that declare a DETECTABLE tab strip
    (a `tabs.anchors` block) — only those can be located on a frame by detect_active_tab."""
    metas: dict = {}
    if not os.path.isdir(PROFILE_DIR):
        return metas
    for f in os.listdir(PROFILE_DIR):
        if not f.endswith(".json"):
            continue
        try:
            with open(os.path.join(PROFILE_DIR, f)) as fh:
                d = json.load(fh)
        except Exception:
            continue
        if (d.get("tabs") or {}).get("anchors"):
            key = f[:-5]
            metas[key] = d.get("synth", key) or key
    return metas


def name_synths_in_frames(images, *, min_conf: float = 0.6) -> list:
    """Display names of synths whose GUI is UNIQUELY + confidently detected across `images`
    (BGR arrays) — the VISUAL complement to OCR plugin-name detection (§2), for when the
    on-screen name is only a stylized logo tesseract can't read. Uniqueness-gated PER FRAME
    (exactly one profile clears `min_conf` on a frame) so the blind Vital↔Serum cross-fire that
    defeats identify_synth cannot mislabel here. (min_conf 0.6 is also where the cross-fire is
    excluded — a Vital frame trips the Serum profile at ~0.56, so a lower gate would wrongly read
    'ambiguous'.) Returns sorted display names."""
    metas = profile_metas()
    if not metas:
        return []
    found: dict = {}
    for img in images:
        if img is None or getattr(img, "ndim", 0) != 3 or getattr(img, "size", 0) == 0:
            continue
        fired: dict = {}
        for key in metas:
            r = detect_active_tab(img, key)
            # require a LOGO-CONFIRMED calibration: a proportional-fallback tab read (logo not
            # found) can land a confident-but-spurious tab on a DIFFERENT synth's GUI → a cross-synth
            # mislabel. Naming demands the synth's own logo be located first.
            if r.get("tab") and r.get("host_invariant") and float(r.get("confidence", 0.0) or 0.0) >= min_conf:
                fired[key] = float(r["confidence"])
        if len(fired) == 1:                     # unambiguous on this frame
            disp = metas[next(iter(fired))]
            found[disp] = max(found.get(disp, 0.0), next(iter(fired.values())))
    return sorted(found)


def _load_tabs(synth: str, img: np.ndarray) -> dict | None:
    """Load + map a profile's tab strip onto the actual frame, HOST-INVARIANTLY (the tab band's
    y is offset by the logo-landmark match, so it lands on the dots row regardless of the host's
    title-bar height — a band located by proportional scaling alone slides off the strip when the
    chrome differs, e.g. Ableton vs Mosh). None if the profile has no tabs block."""
    path = os.path.join(PROFILE_DIR, f"{synth.lower()}.json")
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        data = json.load(f)
    tabs = data.get("tabs")
    if not tabs or not tabs.get("anchors"):
        return None
    cal = axis_map(data, img.shape[1], img.shape[0], img)
    ref_w = data.get("reference_size", [img.shape[1], img.shape[0]])[0]
    y0, y1 = tabs.get("band", [0, 0])
    return {
        "band": [cal.y(y0), cal.y(y1)],
        "highlight": tabs.get("highlight", "saturated"),
        # x-window (scaled) restricts the search to the tab row, excluding the synth logo on
        # the left and the preset/menu area on the right (both can carry saturated pixels).
        "x_min": cal.x(tabs.get("x_min", 0)),
        "x_max": cal.x(tabs.get("x_max", ref_w)),
        "anchors": {n: cal.x(x) for n, x in tabs["anchors"].items()},
        "min_count": tabs.get("min_count", 2),
        # whether the calibration was LOGO-CONFIRMED (the synth's own logo was located) vs the
        # proportional fallback. Naming/identification must only trust logo-confirmed reads — a
        # proportional-fallback tab band can land on a saturated region of a DIFFERENT synth's GUI
        # and read a confident-but-spurious tab (a cross-synth mislabel on real frames).
        "host_invariant": cal.host_invariant,
    }


def _highlight_columns(img: np.ndarray, band: list[int], kind: str) -> np.ndarray:
    """Per-column count of active-indicator pixels in the tab-strip band. The cutoff is ADAPTIVE
    (band-median + margin), so it stands the indicator out across skins/accent strengths rather
    than assuming one absolute level."""
    import cv2

    y0, y1 = max(0, band[0]), min(img.shape[0], band[1])
    if y1 <= y0 or img.ndim != 3:
        return np.zeros(img.shape[1] if img.ndim >= 2 else 1, np.float32)
    hsv = cv2.cvtColor(img[y0:y1], cv2.COLOR_BGR2HSV)
    H, S, V = hsv[..., 0].astype(np.float32), hsv[..., 1].astype(np.float32), hsv[..., 2].astype(np.float32)
    s_thr = max(45.0, float(np.median(S)) + 35.0)        # adaptive: the indicator out-saturates the strip
    if kind == "green":
        mask = (S > s_thr) & (V > 60.0) & (H > 30.0) & (H < 95.0)
    elif kind == "bright":
        # hue+saturation AGNOSTIC: the active dot is simply BRIGHTER than the dim grey inactive
        # dots, whatever its hue. Serum's active-tab dot renders green (Mosh/standalone), blue
        # (Ableton), OR white (the MIX tab) — only brightness is invariant across all of them.
        v_thr = max(120.0, float(np.median(V)) + 60.0)
        mask = V > v_thr
    else:  # "saturated" — the accent underline/dot vs the grey inactive tabs
        mask = (S > s_thr) & (V > 60.0)
    return mask.sum(axis=0).astype(np.float32)


def detect_active_tab(img: np.ndarray, synth: str) -> dict:
    """Which tab is active in this `synth` frame. {"tab", "confidence", "peak_x"}; tab=None if
    no indicator is found (wrong synth / occluded / not a GUI frame). The x-window keeps the synth
    logo / preset area out; the saturation cutoff is adaptive (see _highlight_columns)."""
    cfg = _load_tabs(synth, img)
    if not cfg:
        return {"tab": None, "confidence": 0.0, "peak_x": None, "host_invariant": False}
    hi = bool(cfg.get("host_invariant"))
    cols = _highlight_columns(img, cfg["band"], cfg["highlight"])
    x0 = max(0, cfg["x_min"])
    x1 = min(len(cols), cfg["x_max"]) if cfg["x_max"] > 0 else len(cols)
    cols[:x0] = 0.0
    cols[x1:] = 0.0
    strength = float(cols.max())
    if strength < cfg["min_count"]:
        return {"tab": None, "confidence": 0.0, "peak_x": None, "strength": 0.0, "host_invariant": hi}
    peak_x = int(np.argmax(cols))
    name, dist = min(((n, abs(peak_x - x)) for n, x in cfg["anchors"].items()), key=lambda t: t[1])
    xs = sorted(cfg["anchors"].values())
    spacing = min((b - a for a, b in zip(xs, xs[1:])), default=float(img.shape[1]))
    conf = max(0.0, min(1.0, 1.0 - (dist / (0.5 * spacing)))) if spacing > 0 else 0.0
    return {"tab": name, "confidence": round(conf, 3), "peak_x": peak_x, "strength": strength,
            "host_invariant": hi}


def identify_synth(img: np.ndarray, candidates: list[str] | None = None) -> dict:
    """Best-effort: try each candidate profile's tab detection and return the synth whose active
    indicator is both well-localized AND strongest. Ranking by strength×confidence (not distance
    alone) disambiguates a wrong synth whose misaligned band catches a faint spurious peak near
    one of its anchors. {"synth", "tab", "confidence"}."""
    if candidates is None:
        candidates = [f[:-5] for f in os.listdir(PROFILE_DIR) if f.endswith(".json")]
    best = {"synth": None, "tab": None, "confidence": 0.0, "_score": 0.0}
    for synth in candidates:
        r = detect_active_tab(img, synth)
        if not r["tab"]:
            continue
        score = r["confidence"] * r.get("strength", 0.0)
        if score > best["_score"]:
            best = {"synth": synth, "tab": r["tab"], "confidence": r["confidence"], "_score": score}
    return {"synth": best["synth"], "tab": best["tab"], "confidence": best["confidence"]}
