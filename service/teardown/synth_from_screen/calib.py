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
    """Locate the profile's logo landmark in `img` via template matching and return
    {"s", "dx", "dy", "score"} — the host-invariant map params — or None to fall back to
    proportional scaling. Never raises (a bad profile/template/frame degrades, it doesn't crash)."""
    lm = data.get("landmark")
    if not lm or img is None or getattr(img, "ndim", 0) != 3:
        return None
    try:
        import cv2

        tpath = os.path.join(PROFILE_DIR, lm.get("template", ""))
        if not os.path.isfile(tpath):
            return None
        tmpl = cv2.imread(tpath)
        bbox = lm.get("bbox")
        if tmpl is None or not bbox or len(bbox) < 2:
            return None
        ref = data.get("reference_size", [img.shape[1], img.shape[0]])
        ref_w = float(ref[0])
        tscale = float(lm.get("template_scale", 1.0)) or 1.0
        bx, by = bbox[0], bbox[1]
        ref_x, ref_y = bx / tscale, by / tscale      # logo top-left in reference px
        fh, fw = img.shape[:2]
        if ref_w <= 0:
            return None
        s = fw / ref_w
        s_rel = s / tscale                           # resize the stored template to frame scale
        nw, nh = max(1, int(round(tmpl.shape[1] * s_rel))), max(1, int(round(tmpl.shape[0] * s_rel)))
        nt = cv2.resize(tmpl, (nw, nh), interpolation=cv2.INTER_AREA)
        # the logo is top-left; search the top band + left portion (keeps a spurious right-side
        # bright region from stealing the match, and is cheaper).
        sh = max(nh + 1, int(0.30 * fh))
        sw = max(nw + 1, int(0.55 * fw))
        region = img[:sh, :sw]
        if region.shape[0] < nh or region.shape[1] < nw:
            return None
        res = cv2.matchTemplate(region, nt, cv2.TM_CCOEFF_NORMED)
        _, score, _, loc = cv2.minMaxLoc(res)
        if score < float(lm.get("min_score", 0.55)):
            return None
        dx = loc[0] - ref_x * s
        dy = loc[1] - ref_y * s
        # the logo can only translate by the chrome delta: x has no chrome (|dx| tiny), y a modest
        # title-bar difference. A large offset means a wrong match → reject, fall back to proportional.
        if abs(dx) > 0.04 * fw or abs(dy) > 0.12 * fh:
            return None
        return {"s": s, "dx": float(dx), "dy": float(dy), "score": float(score)}
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
