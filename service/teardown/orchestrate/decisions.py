"""Agentic micro-decisions — heuristic by default, LLM-enhanced when a key is present.
Labeling, section naming, substitute choice. The LLM proposes; callers validate against the
§0 schema (the LLM never writes the recipe directly).
"""
from __future__ import annotations

import os
from pathlib import Path

_SECTION_ARC = ["intro", "verse", "hook", "bridge", "verse", "hook", "outro"]


def label_element(el) -> str:
    if el.synth_patch.plugin.name:
        return el.synth_patch.plugin.name
    if el.sample_match.matched_path:
        return Path(el.sample_match.matched_path).stem
    return el.role.value


def name_sections(n: int) -> list[str]:
    """Heuristic section arc by position (intro … outro). LLM/transcript refinement optional."""
    if n <= 0:
        return []
    if n == 1:
        return ["loop"]
    out = []
    for i in range(n):
        if i == 0:
            out.append("intro")
        elif i == n - 1:
            out.append("outro")
        else:
            out.append(_SECTION_ARC[min(i, len(_SECTION_ARC) - 2)])
    return out


def choose_substitute(candidates: list) -> object:
    return candidates[0] if candidates else None


def llm_available() -> bool:
    """An OpenAI-compatible key present (mirrors BrainProxy's env posture)."""
    return bool(os.environ.get("OPENAI_API_KEY") or os.environ.get("MOSHI_BRAIN_KEY"))
