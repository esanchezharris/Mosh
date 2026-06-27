"""Frame access — read/sample frames from a video (cv2) or load an image. Shared by §3
visual-verify, §4 keyframe sampling, §5/§5b region work.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Union

import numpy as np


@dataclass
class Frame:
    t_s: float
    image: np.ndarray  # BGR, HxWx3


def load_image(path: Union[str, Path]) -> np.ndarray:
    import cv2
    img = cv2.imread(str(path))
    if img is None:
        raise ValueError(f"cannot read image {path}")
    return img


def sample_frames(video_path: Union[str, Path], every_s: float = 2.0, max_frames: int = 120) -> list[Frame]:
    """Fixed-cadence frame sampling (every `every_s` seconds, capped)."""
    import cv2
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise ValueError(f"cannot open video {video_path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    dur = (total / fps) if fps else 0.0
    out: list[Frame] = []
    t = 0.0
    while (dur == 0.0 or t <= dur) and len(out) < max_frames:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
        ok, fr = cap.read()
        if not ok or fr is None:
            break
        out.append(Frame(round(t, 3), fr))
        t += every_s
    cap.release()
    return out


def grab_frame(video_path: Union[str, Path], t_s: float) -> np.ndarray:
    import cv2
    cap = cv2.VideoCapture(str(video_path))
    cap.set(cv2.CAP_PROP_POS_MSEC, t_s * 1000.0)
    ok, fr = cap.read()
    cap.release()
    if not ok or fr is None:
        raise ValueError(f"cannot grab frame at {t_s}s of {video_path}")
    return fr
