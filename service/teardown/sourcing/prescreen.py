"""Cheap metadata pre-screen (no download) — title/description/tags NLP + structure
signals → a prescreen score and a keep/drop decision. The cheap filter that predicts
achievable yield before an expensive teardown.
"""
from __future__ import annotations

from dataclasses import dataclass

TUTORIAL_KWS = ("tutorial", "how to make", "how i made", "making a", "from scratch",
                "start to finish", "beat breakdown", "cook up", "cookup", "in the studio",
                "how to produce", "making of")
FROM_SCRATCH_KWS = ("from scratch", "start to finish", "how i made", "cook up", "cookup")
DAW_KWS = {
    "fl_studio": ("fl studio", "image-line", "flp"),
    "ableton": ("ableton", "ableton live"),
    "logic": ("logic pro", "logic pro x"),
}
PLUGIN_KWS = ("serum", "vital", "omnisphere", "kontakt", "massive", "sylenth", "nexus",
              "pigments", "phaseplant", "phase plant", "gross beat", "808")
GENRE_KWS = ("trap", "drill", "rage", "hyperpop", "boom bap", "lo-fi", "lofi", "jersey",
             "plugg", "r&b", "hip hop", "hip-hop", "afrobeat", "house", "phonk", "ambient")
NEG_KWS = ("reaction", "review", "top 10", "tier list", "unboxing", "podcast", "interview",
           "gameplay", "vlog", "tier-list", "first listen")


@dataclass
class PrescreenResult:
    score: float
    keep: bool
    signals: dict


def prescreen(meta) -> PrescreenResult:
    blob = f"{meta.title}\n{meta.description}\n{' '.join(meta.tags)}".lower()
    is_tutorial = any(k in blob for k in TUTORIAL_KWS)
    from_scratch = any(k in blob for k in FROM_SCRATCH_KWS)
    daw = next((d for d, kws in DAW_KWS.items() if any(k in blob for k in kws)), None)
    plugins = sorted({p for p in PLUGIN_KWS if p in blob})
    genre = next((g for g in GENRE_KWS if g in blob), None)
    negative = any(k in blob for k in NEG_KWS)
    has_chapters = meta.chapters > 0
    has_captions = bool(meta.has_captions)
    dur_ok = 120.0 <= meta.duration_s <= 3600.0
    dur_ideal = 300.0 <= meta.duration_s <= 1800.0

    s = 0.0
    s += 0.35 if is_tutorial else 0.0
    s += 0.15 if from_scratch else 0.0
    s += 0.10 if daw else 0.0
    s += min(0.12, 0.04 * len(plugins))
    s += 0.06 if genre else 0.0
    s += 0.08 if has_chapters else 0.0
    s += 0.06 if has_captions else 0.0
    s += 0.05 if dur_ideal else (0.0 if dur_ok else -0.15)
    s -= 0.40 if negative else 0.0
    score = max(0.0, min(1.0, s))
    keep = is_tutorial and dur_ok and not negative

    signals = {
        "is_tutorial": is_tutorial, "from_scratch": from_scratch, "daw": daw,
        "plugins": plugins, "genre": genre, "negative": negative,
        "has_chapters": has_chapters, "has_captions": has_captions,
        "duration_s": meta.duration_s, "dur_ok": dur_ok,
    }
    return PrescreenResult(round(score, 4), keep, signals)
