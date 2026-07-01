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
    with tempfile.TemporaryDirectory() as tmp:
        frame = Path(tmp) / "serum-frame.jpg"
        _write_frame(frame)
        probe = LocalFrameVerifier(frame).verify("local-serum", "unused", tmp, duration_s=600)
        check("ocr detects serum", probe.serum_visible, str(probe))
        check("ocr detects preset", probe.readable_preset, str(probe))
        check("ocr detects knobs", probe.readable_knobs, str(probe))
        check("ocr or cv detects chain", probe.plugin_chain_visible, str(probe))
        check("frame evidence records ocr cv detector", any(item.get("detector") == "ocr_cv" for item in probe.evidence), str(probe.evidence))
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
