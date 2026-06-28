"""Piano-roll detector — is a piano-roll grid on screen (and roughly where). A piano roll
reads as many parallel horizontal lane lines + regular vertical bar lines. v1 uses cv2
edge + Hough-line counting (heuristic; §5 does the precise localize/rectify). Returns
{present, bbox, confidence}.
"""
from __future__ import annotations

import numpy as np


def piano_roll_present(img: np.ndarray) -> dict:
    import cv2

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    h, w = gray.shape[:2]
    if h == 0 or w == 0:
        return {"present": False, "bbox": None, "confidence": 0.0}
    edges = cv2.Canny(gray, 50, 150)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=100,
                            minLineLength=int(w * 0.25), maxLineGap=8)
    if lines is None:
        return {"present": False, "bbox": None, "confidence": 0.0}
    horiz = vert = 0
    xs: list[int] = []
    ys: list[int] = []
    for x1, y1, x2, y2 in lines[:, 0, :]:
        if abs(y2 - y1) <= 3 and abs(x2 - x1) > w * 0.25:
            horiz += 1
            xs += [int(x1), int(x2)]
            ys += [int(y1), int(y2)]
        elif abs(x2 - x1) <= 3 and abs(y2 - y1) > h * 0.12:
            vert += 1
            xs += [int(x1), int(x2)]
            ys += [int(y1), int(y2)]
    present = horiz >= 6 and vert >= 4   # a lane grid + bar lines
    conf = round(min(1.0, (horiz + vert) / 40.0), 3) if present else 0.0
    # bbox = extent of the grid lines (the roll region) — lets §5 crop to the roll instead of
    # masking the whole frame (which would catch every coloured UI element as a "note").
    bbox = None
    if present and xs and ys:
        x0, x1 = max(0, min(xs)), min(w, max(xs))
        y0, y1 = max(0, min(ys)), min(h, max(ys))
        if x1 - x0 >= w * 0.25 and y1 - y0 >= h * 0.1:
            bbox = (x0, y0, x1 - x0, y1 - y0)
    return {"present": present, "bbox": bbox, "confidence": conf}
