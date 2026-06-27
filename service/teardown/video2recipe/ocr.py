"""OCR parsing — pull tempo / key / plugin names out of frame text, and `scan_meta` to
vote across keyframes. The parsers are pure (text → values, unit-tested); scan_meta drives
the §2 detectors over Frames.
"""
from __future__ import annotations

import re
from typing import Optional

from ..vision.synthgui import SYNTH_SIGNS

_TEMPO = re.compile(r"(\d{2,3})\s*bpm", re.I)
_KEY = re.compile(r"\b([A-Ga-g][#b]?)\s*[- ]?\s*(maj(?:or)?|min(?:or)?|m)\b", re.I)


def parse_tempo(text: str) -> Optional[int]:
    for m in _TEMPO.finditer(text or ""):
        v = int(m.group(1))
        if 40 <= v <= 300:
            return v
    return None


def parse_key(text: str) -> Optional[str]:
    m = _KEY.search(text or "")
    if not m:
        return None
    letter = m.group(1)[0].upper()
    acc = m.group(1)[1:]
    mode = "major" if m.group(2).lower().startswith("maj") else "minor"
    return f"{letter}{acc} {mode}"


def parse_plugins(text: str) -> list[str]:
    t = (text or "").lower()
    return [name for name, signs in SYNTH_SIGNS.items() if any(s in t for s in signs)]


def scan_meta(frames) -> dict:
    """OCR each Frame once; vote tempo/key/DAW + accumulate plugins + piano-roll presence."""
    from ..vision.daw import daw_detect
    from ..vision.ocr import ocr_text
    from ..vision.pianoroll import piano_roll_present

    tempo_votes: dict[int, int] = {}
    key_votes: dict[str, int] = {}
    daw_votes: dict[str, float] = {}
    plugins: set[str] = set()
    pianoroll = False
    tempo_ev: list[str] = []

    for fr in frames:
        txt = ocr_text(fr.image)
        t = parse_tempo(txt)
        if t:
            tempo_votes[t] = tempo_votes.get(t, 0) + 1
            tempo_ev.append(f"frame@{fr.t_s}s")
        k = parse_key(txt)
        if k:
            key_votes[k] = key_votes.get(k, 0) + 1
        plugins.update(parse_plugins(txt))
        d = daw_detect(fr.image, text=txt)
        if d["daw"] != "unknown":
            daw_votes[d["daw"]] = daw_votes.get(d["daw"], 0.0) + d["confidence"]
        if not pianoroll and piano_roll_present(fr.image)["present"]:
            pianoroll = True

    tempo = max(tempo_votes, key=tempo_votes.get) if tempo_votes else None
    key = max(key_votes, key=key_votes.get) if key_votes else None
    daw = max(daw_votes, key=daw_votes.get) if daw_votes else "unknown"
    return {
        "tempo": tempo,
        "tempo_conf": round(min(1.0, 0.4 + 0.2 * tempo_votes.get(tempo, 0)), 3) if tempo else 0.0,
        "tempo_evidence": tempo_ev[:3],
        "key": key, "key_conf": 0.5 if key else 0.0,
        "daw": daw, "daw_conf": round(min(1.0, daw_votes.get(daw, 0.0)), 3) if daw != "unknown" else 0.0,
        "plugins": sorted(plugins), "pianoroll": pianoroll,
    }
