"""Acquire a tutorial via yt-dlp into the transient analysis cache (hash-recorded; not a
retained corpus — posture). Optional `section=(start_s,end_s)` downloads only a window,
which keeps a quick teardown small. Gated on yt-dlp.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from ..sourcing.posture import content_hash_file


# 1080p, not 720p: a vision-LLM synth-ID (§5b llm_identify) confuses similar wavetable synths
# (Vital↔Serum) at 720p but is reliable at ≥1080p, and the extra detail also helps OCR/piano-roll.
# Tunable via MOSH_TEARDOWN_MAXH for scrape-at-scale bandwidth economy.
MAX_HEIGHT = int(os.environ.get("MOSH_TEARDOWN_MAXH", "1080") or "1080")


def available() -> bool:
    import importlib.util
    return importlib.util.find_spec("yt_dlp") is not None


def download(url_or_id: str, out_dir, section: Optional[tuple] = None) -> dict:
    import yt_dlp

    url = url_or_id if str(url_or_id).startswith("http") else f"https://www.youtube.com/watch?v={url_or_id}"
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    h = MAX_HEIGHT
    opts = {
        "quiet": True, "no_warnings": True, "noplaylist": True,
        "outtmpl": str(out / "%(id)s.%(ext)s"),
        "format": f"bv*[height<={h}]+ba/b[height<={h}]/b",
        "merge_output_format": "mp4",
    }
    if section:
        s, e = section
        opts["download_ranges"] = yt_dlp.utils.download_range_func(None, [(float(s), float(e))])
        opts["force_keyframes_at_cuts"] = True
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)

    vid = info["id"]
    cands = sorted(out.glob(f"{vid}.*"))
    vp = next((c for c in cands if c.suffix.lower() in (".mp4", ".mkv", ".webm")), cands[0] if cands else None)
    if vp is None:
        raise RuntimeError("download produced no media file")
    return {
        "video_id": vid, "title": info.get("title", ""), "url": url,
        "duration_s": float(info.get("duration") or 0.0),
        "video_path": str(vp), "content_hash": content_hash_file(vp),
    }
