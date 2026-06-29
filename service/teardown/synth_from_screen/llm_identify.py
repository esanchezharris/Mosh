"""§5b synth IDENTIFICATION via a vision LLM (Gemini) — the robust way to tell Serum 1 / Serum 2 /
Vital apart, and to NAME an unknown synth + its components, surviving the facecam occlusion, inset
windows and skin variance that defeat logo-template and tab-OCR matching.

Why this and not pixel matching (learned the hard way on real tutorials): a stylized corner logo gets
occluded by the YouTuber's facecam and templated-matched onto DAW chrome; tab labels OCR onto a
precision/recall knife-edge. A vision model just READS the picture — it identifies the plugin across
skins/overlays and, for a synth it doesn't know, returns the visible COMPONENTS (so §8 can substitute).

How: one vision call per sampled keyframe + a PER-VIDEO MAJORITY VOTE (a single frame can err — e.g. at
720p Gemini confused Vital↔Serum; at ≥1080p it is reliable, and voting absorbs the rest).

Posture: gated on GEMINI_API_KEY — sends frames to Google's Gemini API, so it's opt-in by key presence
(no key → returns None and the caller keeps its local fallback). The HTTP call is injectable (`call=`)
so tests are fully hermetic. `identify_synths` returns:
  • None  → could not run (no key / no injected call) — caller should fall back,
  • []    → ran but saw no synth in the video,
  • [ {name, profile_key, known, confidence, components, votes} , ... ]  → voted synths, best first.
"""
from __future__ import annotations

import base64
import json
import os
import re
import urllib.request
from collections import Counter
from typing import Callable, Optional

DEFAULT_MODEL = "gemini-2.5-flash"
_API = "https://generativelanguage.googleapis.com/v1beta/models"

_PROMPT = (
    "This is a frame from a music-production video. IGNORE any webcam/facecam, the channel "
    "logo or watermark, and text overlays — those are NOT the plugin. Identify ONLY the "
    "SYNTHESIZER PLUGIN whose GUI is shown (e.g. Serum, Serum 2, Vital, Massive, Phase Plant, "
    "Pigments, Diva, Sylenth1, Omnisphere). Use colour scheme, tab names and layout to tell "
    "similar wavetable synths apart (Vital is teal with VOICE/EFFECTS/MATRIX/ADVANCED tabs; "
    "Serum has OSC/MIX/FX/MATRIX/GLOBAL). If no synthesizer GUI is clearly visible, name=null. "
    "If a synth GUI is shown but you don't recognise the exact product, give your best guess or "
    "null with known=false and list its visible components. Reply ONLY compact JSON: "
    '{"name":<string|null>,"known":<bool>,"confidence":<0-1>,'
    '"components":["oscillator","wavetable","filter","adsr_envelope","lfo","fx_rack","mod_matrix"]}'
)


def _profile_key(name: str) -> Optional[str]:
    """Map an LLM display name → a bundled §5b profile key (for geometry reads), or None if we have
    no profile (an unknown / unprofiled synth — still named, handled by §8 substitute)."""
    n = name.lower()
    if "serum" in n and "2" in n:
        return "serum"
    if "serum" in n:
        return "serum1"
    if "vital" in n:
        return "vital"
    return None


def _gemini_call(b64_jpeg: str, *, key: str, model: str, timeout: float = 90.0) -> str:
    body = {"contents": [{"parts": [{"text": _PROMPT},
                                    {"inline_data": {"mime_type": "image/jpeg", "data": b64_jpeg}}]}],
            "generationConfig": {"temperature": 0}}
    url = f"{_API}/{model}:generateContent?key={key}"
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # nosec - fixed Gemini host
        data = json.load(r)
    return data["candidates"][0]["content"]["parts"][0]["text"]


def _parse(text: str) -> dict:
    if not text:
        return {}
    m = re.search(r"\{.*\}", text, re.S)
    try:
        return json.loads(m.group(0)) if m else {}
    except Exception:
        return {}


def _encode(img) -> Optional[str]:
    try:
        import cv2
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])
        return base64.b64encode(buf).decode() if ok else None
    except Exception:
        return None


def identify_synths(frames, *, key: Optional[str] = None, model: Optional[str] = None,
                    call: Optional[Callable[[str], str]] = None, max_frames: int = 8,
                    min_conf: float = 0.6):
    """Per-frame vision ID + per-video majority vote. See module docstring for the return contract."""
    key = key or os.environ.get("GEMINI_API_KEY", "")
    if not key and call is None:
        return None  # cannot run → caller falls back to local naming
    model = (model or os.environ.get("MOSH_AGENT_MODEL", DEFAULT_MODEL) or DEFAULT_MODEL).strip().strip('"')
    do_call = call or (lambda b64: _gemini_call(b64, key=key, model=model))

    frames = list(frames or [])
    if frames and len(frames) > max_frames:                 # sample evenly across the video
        step = len(frames) / float(max_frames)
        frames = [frames[int(i * step)] for i in range(max_frames)]

    votes: Counter = Counter()
    rep: dict = {}      # normalized-key → a representative parsed response (for components/display)
    answered = 0
    for fr in frames:
        img = getattr(fr, "image", fr)
        b64 = _encode(img)
        if b64 is None:
            continue
        try:
            r = _parse(do_call(b64))
        except Exception:
            continue
        answered += 1
        name = (r.get("name") or "").strip()
        if not name or name.lower() in ("null", "none", "unknown"):
            continue
        if float(r.get("confidence", 0) or 0) < min_conf:
            continue
        norm = re.sub(r"^xfer( records)?\s+", "", name.lower()).strip()
        votes[norm] += 1
        rep.setdefault(norm, {"name": name, "resp": r})

    if answered == 0:
        return None  # every call failed (network/key) → treat as "could not run"
    if not votes:
        return []    # ran, saw no synth

    # keep names with a real share of the frames (kills one-off misreads / a stray watermark guess)
    floor = max(2, int(round(0.34 * answered)))
    out = []
    for norm, n in votes.most_common():
        if n < floor:
            continue
        r = rep[norm]["resp"]
        disp = rep[norm]["name"]
        out.append({"name": disp, "profile_key": _profile_key(disp),
                    "known": bool(r.get("known", False)), "confidence": float(r.get("confidence", 0) or 0),
                    "components": list(r.get("components") or []), "votes": n})
    return out
