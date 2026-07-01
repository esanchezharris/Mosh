"""Assemble a §0 Recipe skeleton from detected signals — pure (structured inputs → Recipe),
so it's golden-testable without any CV. ALWAYS schema-valid: missing signals stay null and
become `unresolved`, never a failure. reconstruction_class='partial' (a skeleton; §5/§5b/§9
upgrade it).
"""
from __future__ import annotations

from typing import Optional

from ..recipe import (Arrangement, Element, Meta, MetaField, Midi, Plugin, Recipe,
                      Section, Source, SynthPatch, Unresolved)


def assemble_skeleton(*, source: dict, meta_signals: Optional[dict] = None,
                      sections: Optional[list[dict]] = None) -> Recipe:
    ms = meta_signals or {}
    src = Source(video_id=source.get("video_id", ""), url=source.get("url", ""),
                 title=source.get("title", ""), duration_s=float(source.get("duration_s") or 0.0),
                 content_hash=source.get("content_hash"))
    rec = Recipe(source=src, reconstruction_class="partial")

    if ms.get("daw") and ms["daw"] != "unknown":
        rec.meta.daw = MetaField(value=ms["daw"], confidence=ms.get("daw_conf", 0.6))
    if ms.get("tempo"):
        rec.meta.tempo_bpm = MetaField(value=ms["tempo"], confidence=ms.get("tempo_conf", 0.6),
                                       evidence=list(ms.get("tempo_evidence") or []))
    if ms.get("key"):
        rec.meta.key = MetaField(value=ms["key"], confidence=ms.get("key_conf", 0.5))

    if sections:
        rec.arrangement = Arrangement(sections=[Section(**s) for s in sections])

    # skeleton elements: one per detected synth (status unknown → §5b reads params / §8 matches)
    for i, pl in enumerate(ms.get("plugins") or []):
        rec.elements.append(Element(
            element_id=f"synth_{i}", role="lead", label=pl,
            synth_patch=SynthPatch(status="unknown", plugin=Plugin(name=pl, available_locally=False)),
        ))
    if ms.get("pianoroll"):
        rec.elements.append(Element(element_id="midi_0", role="other", label="piano-roll part",
                                    midi=Midi(status="unknown")))
        rec.unresolved.append(Unresolved(issue="piano roll seen but not extracted", element_id="midi_0",
                                         suggested_action="run §5 MIDI-from-screen on the located region"))

    if not rec.elements:
        rec.unresolved.append(Unresolved(issue="no on-screen elements detected",
                                         suggested_action="manual review / §7 audio extraction"))
    return rec
