"""Narration transcript via faster-whisper (local). faster-whisper reads media directly
(its own ffmpeg/av), so no separate audio extraction. Gated on the dep + a one-time model
download. Returns {language, segments:[{start,end,text}]}.
"""
from __future__ import annotations


def available() -> bool:
    import importlib.util
    return importlib.util.find_spec("faster_whisper") is not None


def transcribe(media_path, model_size: str = "base.en") -> dict:
    from faster_whisper import WhisperModel

    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, info = model.transcribe(str(media_path))
    segs = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segments]
    return {"language": getattr(info, "language", "?"), "segments": segs}
