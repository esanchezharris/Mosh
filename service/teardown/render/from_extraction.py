from __future__ import annotations

from typing import Optional

from teardown.recipe import (Element, Meta, MetaField, Recipe, ReconstructionClass,
                             Role, SampleMatch)

_VALID_ROLES = {r.value for r in Role}


def recipe_from_extraction(matches: list, *, meta_signals: Optional[dict] = None,
                           matched_threshold: float = 0.5) -> Recipe:
    by_role: dict[str, list] = {}
    for m in matches:
        if not m.get("match"):
            continue
        if m.get("distance") is not None and float(m["distance"]) > matched_threshold:
            continue
        by_role.setdefault(str(m.get("role", "other")), []).append(m)

    elements = []
    for role, ms in sorted(by_role.items()):
        rep = min(ms, key=lambda x: x.get("distance") if x.get("distance") is not None else 9.0)
        onsets = sorted(round(float(m["t_s"]), 4) for m in ms)
        elements.append(Element(
            element_id=role,
            role=role if role in _VALID_ROLES else "perc",
            label=role.title(),
            sample_match=SampleMatch(status="matched", matched_path=rep["match"],
                                     distance=float(rep.get("distance") or 0.0)),
            onsets=onsets,
            confidence=0.6))

    meta = Meta()
    if meta_signals:
        if meta_signals.get("tempo"):
            meta.tempo_bpm = MetaField(value=int(meta_signals["tempo"]), confidence=0.5)
        if meta_signals.get("key"):
            meta.key = MetaField(value=meta_signals["key"], confidence=0.4)

    return Recipe(meta=meta, elements=elements,
                  reconstruction_class=ReconstructionClass.inferred)
