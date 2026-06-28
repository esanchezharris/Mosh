"""Host-invariant calibration — map a profile's reference-space coords onto an actual frame,
correcting for the host's title-bar height (Mosh, Ableton, standalone… each puts a different
amount of chrome above the plugin, so the SAME synth content sits at a different y).

The problem with pure proportional scaling (`sx=frame_w/ref_w, sy=frame_h/ref_h`): the title bar
is host chrome, NOT part of the synth GUI, and it does not scale with the content — it TRANSLATES
it. So a control near the top reads ~20px off when the same plugin is hosted somewhere with a
different title bar (Mosh's Serum window is ~26px taller than Ableton's at full res → every
content y is shifted, and proportional scaling smears that shift across the whole height).

The fix: detect a synth-INTRINSIC landmark — the plugin's own logo, which sits just below the
chrome, is present on every page, and never changes with tab / accent / preset — via template
matching, and express every control as `coord*s + offset` relative to where the logo actually
landed. Width has no chrome (the window's left edge == the content's left edge), so the content
scale `s = frame_w / ref_w` is reliable, and the logo's matched (dx, dy) carries the chrome
offset. dx≈0 always (a sanity gate on the match); dy is the real correction.

Graceful: no `landmark` block, no cv2, no template, or a low-confidence / implausible match →
return None and the caller falls back to the exact prior proportional behaviour. So this is a
strict generalization — identical reads when the frame preserves the reference aspect (the
single-host case), corrected reads only when a different host shifts the content.
"""
from __future__ import annotations

import os

PROFILE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "profiles")


class Calib:
    """An affine reference→frame map. `host_invariant=True` → uniform scale `s` + a logo-derived
    (dx,dy) offset; else the legacy per-axis proportional scale (dx=dy=0). Callers use .x/.y for
    points and .length for radii/spans, so the same call site works either way."""

    __slots__ = ("sx", "sy", "dx", "dy", "s", "host_invariant", "score")

    def __init__(self, sx: float, sy: float, dx: float = 0.0, dy: float = 0.0,
                 host_invariant: bool = False, score: float = 0.0):
        self.sx, self.sy, self.dx, self.dy = sx, sy, dx, dy
        self.s = (sx + sy) / 2.0
        self.host_invariant = host_invariant
        self.score = score

    def x(self, v: float) -> int:
        return int(round(v * self.sx + self.dx))

    def y(self, v: float) -> int:
        return int(round(v * self.sy + self.dy))

    def w(self, v: float) -> int:
        """Scale a horizontal SPAN (no offset) — along x."""
        return int(round(v * self.sx))

    def h(self, v: float) -> int:
        """Scale a vertical SPAN (no offset) — along y."""
        return int(round(v * self.sy))

    def length(self, v: float) -> float:
        return v * self.s

    def length_i(self, v: float) -> int:
        return int(round(v * self.s))


def compute_calibration(data: dict, img) -> dict | None:
    """Locate the profile's logo landmark in `img` via MULTI-SCALE template matching and return
    {"s", "dx", "dy", "score"} — the host-invariant map params — or None to fall back to
    proportional scaling. Never raises (a bad profile/template/frame degrades, it doesn't crash).

    Multi-scale + translation-tolerant so it works whether the synth GUI fills the frame (a
    standalone capture) OR is an EMBEDDED plugin window smaller than, and anywhere within, a DAW
    screenshot. The old single-scale assumption (content scale == frame_w/ref_w) only held for the
    full-frame case → an embedded window failed the match and fell back to (wrong) proportional
    scaling, reading tabs/knobs at ~0.5 confidence. Here we sweep the content scale, match the logo
    over the whole frame at each, and take the best — `s` is the SCALE the logo actually matched at
    (not the frame width), so anchors land on the real window regardless of its size/position. The
    geometric-consistency gate (the content box at that scale must fit in the frame) + a solid
    min_score replace the old dx≈0 chrome-offset gate (which assumed a full-width window)."""
    lm = data.get("landmark")
    if not lm or img is None or getattr(img, "ndim", 0) != 3:
        return None
    try:
        import cv2
        import numpy as np

        tpath = os.path.join(PROFILE_DIR, lm.get("template", ""))
        if not os.path.isfile(tpath):
            return None
        tmpl = cv2.imread(tpath)
        bbox = lm.get("bbox")
        if tmpl is None or not bbox or len(bbox) < 2:
            return None
        ref = data.get("reference_size", [img.shape[1], img.shape[0]])
        ref_w, ref_h = float(ref[0]), float(ref[1] if len(ref) > 1 else img.shape[0])
        tscale = float(lm.get("template_scale", 1.0)) or 1.0
        bx, by = bbox[0], bbox[1]
        ref_x, ref_y = bx / tscale, by / tscale      # logo top-left in reference px
        fh, fw = img.shape[:2]
        if ref_w <= 0 or ref_h <= 0:
            return None
        base = fw / ref_w                            # content scale IF the window fills the frame width
        min_score = float(lm.get("min_score", 0.55))

        def _resize(s: float):
            nw, nh = int(round(tmpl.shape[1] * s / tscale)), int(round(tmpl.shape[0] * s / tscale))
            if nw < 8 or nh < 6 or nw > fw or nh > fh:
                return None
            return cv2.resize(tmpl, (nw, nh), interpolation=cv2.INTER_AREA)

        def _accept(score: float, s: float, loc) -> dict | None:
            dx, dy = loc[0] - ref_x * s, loc[1] - ref_y * s
            # geometric consistency: the whole content box at this scale+offset must fit in the
            # frame (a wrong scale/match would place content off-frame).
            m = 0.03 * max(fw, fh)
            if dx < -m or dy < -m or dx + ref_w * s > fw + m or dy + ref_h * s > fh + m:
                return None
            return {"s": s, "dx": float(dx), "dy": float(dy), "score": float(score)}

        # FAST PATH — the common case (and the EXACT prior behaviour): the GUI fills the frame
        # (a standalone/host capture), so the logo sits at base scale in the top-left band. One
        # cheap match; accept if it clears min_score. Full-screen captures + clear negatives both
        # resolve here in a single matchTemplate, so this change adds NO cost to anything the old
        # single-scale code already handled — the slow path below is purely additive.
        nt = _resize(base)
        if nt is not None:
            sh, sw = max(nt.shape[0] + 1, int(0.30 * fh)), max(nt.shape[1] + 1, int(0.55 * fw))
            region = img[:sh, :sw]
            if region.shape[0] >= nt.shape[0] and region.shape[1] >= nt.shape[1]:
                res = cv2.matchTemplate(region, nt, cv2.TM_CCOEFF_NORMED)
                _, score, _, loc = cv2.minMaxLoc(res)
                if score >= min_score:
                    acc = _accept(score, base, loc)
                    if acc:
                        return acc

        # SLOW PATH — an EMBEDDED window smaller than / anywhere in the frame (the fast path's
        # full-width-at-base assumption fails on it). Sweep the content scale over the WHOLE frame,
        # but on a DOWNSCALED copy so a big DAW screenshot costs ~tens of ms, not seconds; then
        # refine the winner once at full res for anchor precision. (This also runs on a true
        # negative — synth absent — but the downscaled search rejects it cheaply.)
        ds = min(1.0, 480.0 / fw)
        small = (cv2.resize(img, (max(1, int(round(fw * ds))), max(1, int(round(fh * ds)))),
                            interpolation=cv2.INTER_AREA) if ds < 1.0 else img)
        sh2, sw2 = small.shape[:2]
        best = None  # (score, s_full, loc_small)
        for k in range(15):
            s = base * (0.30 + 0.05 * k)             # full-res content scale
            nw = int(round(tmpl.shape[1] * (s * ds) / tscale))
            nh = int(round(tmpl.shape[0] * (s * ds) / tscale))
            if nw < 6 or nh < 5 or nw > sw2 or nh > sh2:
                continue
            nt = cv2.resize(tmpl, (nw, nh), interpolation=cv2.INTER_AREA)
            res = cv2.matchTemplate(small, nt, cv2.TM_CCOEFF_NORMED)
            _, score, _, loc = cv2.minMaxLoc(res)
            if best is None or score > best[0]:
                best = (float(score), s, loc)
            if score >= 0.97:                        # found the window — stop sweeping
                break
        # the slow path is multi-scale + translation-free, so it CAN find a spurious low-score
        # match on a logo-less frame (a synthetic strip, an unrelated panel). The logo is
        # distinctive — a real embedded window matches ~0.95+, spurious texture ~0.5-0.6 — so
        # require a STRICT score here (vs the fast path's min_score, which is safe only because a
        # full-frame logo at base scale is unambiguous). Below it → no calib → proportional fallback.
        slow_min = max(min_score, 0.78)
        if best is None or best[0] < slow_min:
            return None
        score, s, loc_small = best
        loc = (int(round(loc_small[0] / ds)), int(round(loc_small[1] / ds)))
        nt_full = _resize(s)                          # refine at full res in a window around the hit
        if nt_full is not None:
            pad = int(round(8 / ds)) + 4
            x0, y0 = max(0, loc[0] - pad), max(0, loc[1] - pad)
            x1 = min(fw, loc[0] + nt_full.shape[1] + pad)
            y1 = min(fh, loc[1] + nt_full.shape[0] + pad)
            win = img[y0:y1, x0:x1]
            if win.shape[0] >= nt_full.shape[0] and win.shape[1] >= nt_full.shape[1]:
                res = cv2.matchTemplate(win, nt_full, cv2.TM_CCOEFF_NORMED)
                _, score2, _, loc2 = cv2.minMaxLoc(res)
                loc, score = (x0 + loc2[0], y0 + loc2[1]), float(score2)
        return _accept(score, s, loc)
    except Exception:
        # a malformed-but-PRESENT landmark (short/non-numeric bbox, bad template_scale, a zero or
        # missing reference_size, any cv2 quirk) must DEGRADE to proportional, never crash — this
        # is the "never raises" contract axis_map + the four coord-loaders rely on.
        return None


def axis_map(data: dict, frame_w: int, frame_h: int, img=None) -> Calib:
    """The one entry point every coord-loader uses. With `img` and a usable landmark → a
    host-invariant Calib (uniform scale + logo offset); otherwise the legacy proportional Calib
    (sx=frame_w/ref_w, sy=frame_h/ref_h).

    Proportional-fallback parity: point + radius coords (.x/.y via int(round(·)), .length_i) are
    byte-identical to the prior load_profile. bbox SPANS (.w/.h) now also round, where the old code
    truncated them (int(w*sx)) — a deliberate change that makes spans consistent with the points
    they sit beside (the legacy code rounded cx/cy but truncated bbox, a ≤1px internal
    inconsistency). No bundled profile uses bbox controls, so this shifts nothing today."""
    ref_w, ref_h = data.get("reference_size", [frame_w, frame_h])
    sx, sy = frame_w / float(ref_w), frame_h / float(ref_h)
    if img is not None:
        c = compute_calibration(data, img)
        if c:
            return Calib(c["s"], c["s"], c["dx"], c["dy"], host_invariant=True, score=c["score"])
    return Calib(sx, sy, 0.0, 0.0, host_invariant=False)
