#!/usr/bin/env python3
from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVICE = HERE.parent
sys.path.insert(0, str(SERVICE))

from teardown.frame_verify import FrameVerifier


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        raise AssertionError(name)


class LocalFrameVerifier(FrameVerifier):
    def __init__(self, frame: Path):
        super().__init__()
        self.frame = frame

    def _sample_frames(self, url: str, root: Path, duration_s: int | None) -> tuple[list[Path], str]:
        return [self.frame], ""


def main() -> int:
    if not shutil.which("tesseract"):
        print("[SKIP] tesseract missing")
        return 0
    try:
        import PIL  # noqa: F401
    except Exception:
        print("[SKIP] Pillow missing")
        return 0
    with tempfile.TemporaryDirectory() as tmp:
        frame = Path(tmp) / "serum-frame.jpg"
        _write_frame(frame)
        probe = LocalFrameVerifier(frame).verify("local-serum", "unused", tmp, duration_s=600)
        check("ocr detects serum", probe.serum_visible, str(probe))
        check("ocr detects preset", probe.readable_preset, str(probe))
        check("ocr detects knobs", probe.readable_knobs, str(probe))
        check("ocr or cv detects chain", probe.plugin_chain_visible, str(probe))
        check("non-roll synth/control frame does not claim piano-roll", not probe.piano_roll_visible, str(probe))
        check("frame evidence records ocr cv detector", any(item.get("detector") == "ocr_cv" for item in probe.evidence), str(probe.evidence))
        roll = Path(tmp) / "piano-roll.jpg"
        _write_piano_roll_frame(roll)
        roll_probe = LocalFrameVerifier(roll).verify("local-roll", "unused", tmp, duration_s=600)
        check("recoverable piano roll is detected", roll_probe.piano_roll_visible, str(roll_probe))
        vital = HERE / "synth_from_screen" / "fixtures" / "vital_init.png"
        if vital.exists():
            vital_tmp = Path(tmp) / "vital_init.png"
            shutil.copyfile(vital, vital_tmp)
            vital_probe = LocalFrameVerifier(vital_tmp).verify("local-vital", "unused", tmp, duration_s=600)
            check("Vital modulation grid does not claim piano-roll", not vital_probe.piano_roll_visible, str(vital_probe))
    print("ALL PASS")
    return 0


def _write_frame(path: Path) -> None:
    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("RGB", (1280, 720), "white")
    draw = ImageDraw.Draw(image)
    font = _font(72)
    draw.text((80, 80), "Serum Preset", fill="black", font=font)
    draw.text((80, 190), "OSC FILTER ENV LFO", fill="black", font=font)
    draw.text((80, 310), "Mixer Insert Rack", fill="black", font=font)
    for x in range(760, 1240, 80):
        draw.rectangle((x, 80, x + 42, 640), outline="black", width=4)
    image.save(path)


def _write_piano_roll_frame(path: Path) -> None:
    import cv2
    import numpy as np

    image = np.full((600, 800, 3), 30, np.uint8)
    ox, oy, width, height = 200, 150, 400, 200
    row_h, ppb, top_midi = 8, 40, 72
    for row in range(height // row_h + 1):
        cv2.line(image, (ox, oy + row * row_h), (ox + width, oy + row * row_h), (60, 60, 60), 1)
    for beat in range(width // ppb + 1):
        cv2.line(image, (ox + beat * ppb, oy), (ox + beat * ppb, oy + height), (80, 80, 80), 1)
    for pitch, start_beat, length_beats in [(60, 0, 2), (64, 2, 1), (67, 4, 2), (71, 6, 1)]:
        note_row = top_midi - pitch
        y1 = oy + int(note_row * row_h)
        x1 = ox + int(start_beat * ppb)
        cv2.rectangle(image, (x1, y1), (x1 + length_beats * ppb - 2, y1 + row_h - 1), (0, 200, 0), -1)
    cv2.imwrite(str(path), image)


def _font(size: int):
    from PIL import ImageFont

    candidates = (
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Helvetica.ttf",
    )
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size)
        except Exception:
            pass
    return ImageFont.load_default()


if __name__ == "__main__":
    raise SystemExit(main())
