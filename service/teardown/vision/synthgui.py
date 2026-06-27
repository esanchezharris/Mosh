"""Synth-GUI recognizer — is a known soft-synth's window on screen, and which one. v1 is
OCR keyword matching (synth names appear in the plugin header). Feeds §3 yield + §4
evidence + tells §5b which per-synth profile to load.
"""
from __future__ import annotations

from .ocr import ocr_text

# canonical name → OCR substrings (lowercased)
SYNTH_SIGNS = {
    "Serum": ("serum",),
    "Vital": ("vital",),
    "Omnisphere": ("omnisphere",),
    "Massive": ("massive x", "massive"),
    "Sylenth1": ("sylenth",),
    "Pigments": ("pigments",),
    "Nexus": ("nexus",),
    "Kontakt": ("kontakt",),
    "Phase Plant": ("phase plant", "phaseplant"),
}


def synth_gui_present(img, text: str | None = None) -> dict:
    blob = (text if text is not None else ocr_text(img)).lower()
    for name, signs in SYNTH_SIGNS.items():
        if any(s in blob for s in signs):
            return {"present": True, "plugin": name, "confidence": 0.6}
    return {"present": False, "plugin": None, "confidence": 0.0}
