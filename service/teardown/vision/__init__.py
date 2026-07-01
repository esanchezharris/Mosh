"""§2 Shared vision package — three reused detectors so they don't drift across §3/§4/§5/§5b.

- daw_detect(frame)        → {daw, confidence}        (which DAW; OCR-assisted)
- piano_roll_present(frame)→ {present, bbox, confidence} (grid + gutter heuristic; §5 consumes)
- synth_gui_present(frame) → {present, plugin, confidence} (synth recognizer; §5b/§4 evidence)

Detectors are heuristic (OCR keyword match + cv2 grid detection) — robust enough to FLAG,
not a trained classifier; accuracy improves with per-DAW/synth templates. frames.py + ocr.py
are the shared primitives.
"""
from .frames import Frame, grab_frame, load_image, sample_frames  # noqa: F401
from .ocr import ocr_text  # noqa: F401
from .daw import daw_detect  # noqa: F401
from .pianoroll import piano_roll_present  # noqa: F401
from .synthgui import SYNTH_SIGNS, synth_gui_present  # noqa: F401
