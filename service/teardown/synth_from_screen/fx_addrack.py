"""FX add-rack reader — read a synth's DYNAMIC "add-rack" FX page (Serum 2): the ordered list of
effect modules the user has ADDED to the visible bus, plus which bus is active.

This is the add-rack counterpart to `fx_rack.detect_fx_chain` (which handles the FIXED rack of
Vital / Serum 1 — a known set of effects each with an on/off power dot). Serum 2 redesigned FX into
a "+ FX" add-rack: you pick effects from a menu and they STACK top-to-bottom per bus (MAIN / BUS 1 /
BUS 2), empty on Init. So the effect set + order are DATA, not a fixed profile list — and the name
of each module must be READ, not declared.

The read surface is the compact LEFT chain LIST (one row per added module, in order; each row is a
colored accent bar + the effect NAME in clean caps) — cleaner than the expanded module panels. For
each occupied row the NAME is identified by template-matching the name strip against a per-effect
canonical-size template bank (`profiles/<synth>_fxnames/<effect>.png`) — pure CV (no OCR, no runtime
binary), pixel-identical rendering → near-perfect + deterministic, and an UNKNOWN effect degrades to
`name=None / status="unidentified"` rather than a confident-wrong guess.

A profile declares this in an `"fx_addrack"` block on its FX-page profile (see serum.json). All
coords are reference-space and host-corrected by the shared logo landmark (calib), like every reader.

`read_addrack(img, synth)` -> {"bus": "MAIN"|...|None,
                               "chain": [{"name": "Chorus"|None, "on": True,
                                          "confidence": 0.0..1.0, "status": "identified"|"unidentified"}, ...]}
Returns {} (never raises) for an unknown synth, a profile with no fx_addrack block, a non-colour or
empty frame, or None. An empty-but-readable bus returns {"bus": <bus>, "chain": []}.

HONESTY / scope:
  • only the VISIBLE bus is read (switching buses needs a click the reader can't make — the teardown
    pipeline captures each bus separately).
  • per-module BYPASS is not yet detected (the live calibration could not confirm Serum 2's OFF
    visual), so every present module reports on=True; in an add-rack a module's PRESENCE is the
    load-bearing signal.
  • PAGE: the reader trusts the caller (orchestrator §2 page detection) to pass an FX-page frame, but
    uses the active-bus (orange tab) highlight as a cheap gate — no orange bus tab → {"bus": None,
    "chain": []} (it does NOT fabricate rows from a non-FX page's bright labels).
  • NAME id needs roughly native capture resolution: it survives upscaling, but DOWNSCALING the
    frame well below the captured size makes the name text too small to template-match, so names
    degrade to status="unidentified" (the row is still detected as present — never a WRONG name).
"""
from __future__ import annotations

import json
import os

import numpy as np

from .calib import axis_map

PROFILE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "profiles")


def _load_addrack(synth: str) -> dict | None:
    """Load a profile's raw `fx_addrack` block (reference space; scaled per-frame by the caller).
    None if the synth is falsy, the profile is missing, or it has no fx_addrack block."""
    if not synth:
        return None
    path = os.path.join(PROFILE_DIR, f"{synth.lower()}.json")
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        data = json.load(f)
    block = data.get("fx_addrack")
    # honour the "never raises" contract against a corrupt/hand-edited profile: the chain must be a
    # dict (else block["chain"].get(...) below would raise), and reference_size (if present) must be
    # positive (else axis_map's proportional fallback divides by zero). Degrade to None → {}.
    if not block or not isinstance(block.get("chain"), dict) or not block["chain"]:
        return None
    ref = data.get("reference_size")
    if ref is not None:
        try:
            if len(ref) < 2 or float(ref[0]) <= 0 or float(ref[1]) <= 0:
                return None
        except (TypeError, ValueError):
            return None
    return {"data": data, "block": block}


def _load_templates(synth: str, block: dict) -> dict:
    """Load the canonical-size grayscale name templates for `synth` from
    `profiles/<templates_dir>/*.png`. Keyed by the effect's display name (file stem, capitalized).
    Empty dict if the dir is missing/empty — then every row reads `unidentified` (honest)."""
    import cv2

    chain = block.get("chain", {})
    tdir = os.path.join(PROFILE_DIR, chain.get("templates_dir", f"{synth.lower()}_fxnames"))
    if not os.path.isdir(tdir):
        return {}
    display = chain.get("display_names", {})   # file-stem -> display name, for multi-word/slash effects
    out: dict = {}
    for fn in sorted(os.listdir(tdir)):
        if not fn.lower().endswith(".png"):
            continue
        t = cv2.imread(os.path.join(tdir, fn), cv2.IMREAD_GRAYSCALE)
        if t is None:
            continue
        stem = os.path.splitext(fn)[0]
        out[display.get(stem) or (stem[:1].upper() + stem[1:])] = t   # "chorus"->"Chorus"; mapped otherwise
    return out


def _active_bus(img_bgr: np.ndarray, cal, bt: dict) -> str | None:
    """Which bus tab is active? The active tab carries an orange highlight; find the largest orange
    run in the bus-tab band and snap its x-center to the nearest declared anchor. None if no
    highlight (not on an FX page, or an unexpected skin/host where the active colour differs) — and
    read_addrack treats None as "not a confirmed FX page" and reads no chain."""
    import cv2

    band = bt.get("band_y", [0, 0])
    y0, y1 = cal.y(band[0]), cal.y(band[1])
    x0, x1 = cal.x(bt.get("x_min", 0)), cal.x(bt.get("x_max", img_bgr.shape[1]))
    h, w = img_bgr.shape[:2]
    y0, y1 = max(0, min(y0, y1)), min(h, max(y0, y1) + 1)
    x0, x1 = max(0, min(x0, x1)), min(w, max(x0, x1) + 1)
    if y1 <= y0 or x1 <= x0:
        return None
    hsv = cv2.cvtColor(img_bgr[y0:y1, x0:x1], cv2.COLOR_BGR2HSV)
    H, S, V = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    mask = (H <= bt.get("active_hue_max", 25)) & (S >= bt.get("active_sat_min", 120)) & \
           (V >= bt.get("active_val_min", 120))
    xs = np.where(mask.any(axis=0))[0]
    if len(xs) < 3:
        return None
    # Use the LARGEST contiguous run of orange columns, not the mean over all of them: the active
    # (widened) tab is the dominant orange block, so a stray second orange region (a hovered tab, an
    # orange meter/button elsewhere in the band) can't drag the centroid into a wrong bus zone.
    runs, start, prev = [], int(xs[0]), int(xs[0])
    for x in xs[1:]:
        x = int(x)
        if x - prev > 3:
            runs.append((start, prev)); start = x
        prev = x
    runs.append((start, prev))
    a, b = max(runs, key=lambda r: r[1] - r[0])
    cx_frame = x0 + (a + b) // 2
    cx_ref = (cx_frame - cal.dx) / cal.sx if cal.sx else cx_frame   # back to reference x
    anchors = bt.get("anchors", {})
    if not anchors:
        return None
    name, dist = min(((n, abs(v - cx_ref)) for n, v in anchors.items()), key=lambda nd: nd[1])
    # the orange must plausibly BE a bus tab: within half the smallest anchor gap of a known
    # position. A stray orange region far from every anchor → None (not a confirmed FX page),
    # strengthening the page gate beyond "non-FX pages happen to have no orange in this band".
    xs_anchor = sorted(anchors.values())
    gaps = [b2 - a2 for a2, b2 in zip(xs_anchor, xs_anchor[1:])] or [120.0]
    if dist > 0.5 * min(gaps):
        return None
    return name


def read_addrack(img_bgr: np.ndarray, synth: str) -> dict:
    """Read the visible bus's FX add-rack: which effect modules are present, in order, and which bus
    is active. See module docstring for the return shape. {} (never raises) for an unreadable input
    (unknown synth / no fx_addrack block / non-colour or empty frame / None).

    PAGE GATE: the FX add-rack page ALWAYS shows an active (orange) bus tab, so if no bus highlight
    is found the frame is treated as NOT a confirmed FX page and the chain is NOT read — returns
    {"bus": None, "chain": []} rather than fabricating rows from whatever bright UI is on screen.
    The reader still trusts the caller (the orchestrator's §2 page detection) to point it at an FX
    page; the bus gate is a cheap sanity check, not a full page classifier."""
    if (img_bgr is None or getattr(img_bgr, "ndim", 0) != 3 or img_bgr.shape[2] != 3
            or img_bgr.size == 0):
        return {}
    cfg = _load_addrack(synth)
    if not cfg:
        return {}
    import cv2

    data, block = cfg["data"], cfg["block"]
    cal = axis_map(data, img_bgr.shape[1], img_bgr.shape[0], img_bgr)
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)

    bus = _active_bus(img_bgr, cal, block.get("bus_tabs", {}))
    if bus is None:
        # no active bus tab → not a confirmed FX add-rack page → don't fabricate a chain from
        # whatever bright UI is on screen (a GLOBAL/MIX page has bright labels at the row positions).
        return {"bus": None, "chain": []}
    templates = _load_templates(synth, block)

    ch = block["chain"]
    nm = ch.get("name", {})
    cw, chh = int(nm.get("canon_w", 300)), int(nm.get("canon_h", 30))
    bright_min = float(ch.get("name_bright_min", 120))
    present_min = int(ch.get("present_text_min", 30))
    match_min = float(ch.get("match_min", 0.70))
    row0_y, row_h = ch.get("row0_y", 0), ch.get("row_h", 60)
    h, w = gray.shape[:2]

    chain: list[dict] = []
    for i in range(int(ch.get("max_rows", 12))):
        cy = cal.y(row0_y + i * row_h)
        x0, x1 = cal.x(nm.get("x0", 0)), cal.x(nm.get("x1", 0))
        dy = cal.h(nm.get("dy", 16))
        y0, y1 = cy - dy, cy + dy
        if y0 < 0 or y1 > h or x0 < 0 or x1 > w or x1 <= x0:
            break
        crop = gray[y0:y1, x0:x1]
        if int((crop > bright_min).sum()) < present_min:
            break                          # first empty row → end of the contiguous chain
        name, conf, status = None, 0.0, "unidentified"
        if templates:
            # match at a few small vertical offsets and keep the best — tolerates a ±2px landmark
            # misalignment without depending on the row center landing exactly (each offset crop is
            # the same height as the templates, so no scale mismatch). Every crop is the SAME width
            # so canonical resize is consistent.
            voff = max(1, cal.h(2))
            best_n, best_s = None, -1.0
            for off in (-voff, 0, voff):
                yo0, yo1 = y0 + off, y1 + off
                if yo0 < 0 or yo1 > h:
                    continue
                canon = cv2.resize(gray[yo0:yo1, x0:x1], (cw, chh), interpolation=cv2.INTER_AREA)
                for tn, t in templates.items():
                    s = float(cv2.matchTemplate(canon, t, cv2.TM_CCOEFF_NORMED)[0, 0])
                    if s > best_s:
                        best_n, best_s = tn, s
            if best_s >= match_min:
                name, conf, status = best_n, round(best_s, 4), "identified"
            else:
                conf = round(max(best_s, 0.0), 4)
        chain.append({"name": name, "on": True, "confidence": conf, "status": status})

    return {"bus": bus, "chain": chain}
