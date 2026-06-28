"""DAW detector — which DAW is on screen (FL/Ableton/Logic). v1 is OCR-assisted: most
tutorials show the DAW name in the title bar / chrome, which is a far more robust cheap
signal than a from-scratch UI classifier. Returns the controlled `meta.daw` vocabulary.
"""
from __future__ import annotations

from .ocr import ocr_text

DAW_SIGNS = {
    "fl_studio": ("fl studio", "image-line", "image line", "fruity loops"),
    "ableton": ("ableton", "ableton live"),
    "logic": ("logic pro",),
}


def daw_detect(img, text: str | None = None) -> dict:
    """`text` lets a caller pass already-OCR'd frame text (avoids re-OCR)."""
    blob = (text if text is not None else ocr_text(img)).lower()
    best, score = "unknown", 0.0
    for daw, signs in DAW_SIGNS.items():
        hits = sum(s in blob for s in signs)
        if hits:
            sc = min(1.0, 0.5 + 0.2 * hits)
            if sc > score:
                best, score = daw, sc
    return {"daw": best, "confidence": round(score, 3)}
