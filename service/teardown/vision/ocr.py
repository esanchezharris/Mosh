"""OCR primitive — image (or a sub-region) → text via Tesseract. Upscales + grayscales
for small DAW/plugin UI text. Region is (x, y, w, h), fractional (≤1) or pixel.
"""
from __future__ import annotations

from typing import Optional

import numpy as np


def _crop(img: np.ndarray, region: Optional[tuple]) -> np.ndarray:
    if region is None:
        return img
    h, w = img.shape[:2]
    x, y, rw, rh = region
    if max(region) <= 1.0:  # fractional
        x, y, rw, rh = int(x * w), int(y * h), int(rw * w), int(rh * h)
    x, y = max(0, int(x)), max(0, int(y))
    return img[y:y + int(rh), x:x + int(rw)]


def ocr_text(img: np.ndarray, region: Optional[tuple] = None) -> str:
    import cv2
    import pytesseract

    crop = _crop(img, region)
    if crop.size == 0:
        return ""
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    gray = cv2.resize(gray, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
    try:
        return pytesseract.image_to_string(gray) or ""
    except Exception:  # tesseract missing / failure → empty, never fatal
        return ""
