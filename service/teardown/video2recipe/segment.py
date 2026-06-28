"""Shot segmentation + keyframes. Screen-capture tutorials have few hard cuts, so
fixed-cadence sampling is the workhorse (frames.sample_frames); scene cuts (PySceneDetect)
add section hints. Returns Frames for OCR/detection + a list of cut times.
"""
from __future__ import annotations

from ..vision.frames import Frame, sample_frames


def keyframes(video_path, every_s: float = 3.0, max_frames: int = 40) -> list[Frame]:
    return sample_frames(video_path, every_s=every_s, max_frames=max_frames)


def scene_cuts(video_path) -> list[float]:
    """Scene-cut timestamps (seconds). Best-effort — empty if scenedetect is absent or
    the screen is static."""
    try:
        from scenedetect import ContentDetector, detect
        scenes = detect(str(video_path), ContentDetector())
        return [round(s[0].get_seconds(), 2) for s in scenes]
    except Exception:
        return []


def sections_from_cuts(cuts: list[float], duration_s: float) -> list[dict]:
    """Coarse arrangement sections from scene cuts (named generically; §4 refines with
    audio novelty + transcript later)."""
    bounds = [0.0] + [c for c in cuts if 0.0 < c < duration_s] + ([duration_s] if duration_s else [])
    bounds = sorted(set(round(b, 2) for b in bounds))
    out = []
    for i in range(len(bounds) - 1):
        out.append({"name": f"section {i + 1}", "start_s": bounds[i], "end_s": bounds[i + 1], "confidence": 0.2})
    return out
