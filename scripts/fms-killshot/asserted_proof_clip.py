from __future__ import annotations


def contained_pairs(tokens: list[dict], aligned: list[dict], *, clip_start: float, clip_end: float) -> list[tuple[dict, dict]]:
    return [
        (token, span)
        for token, span in zip(tokens, aligned)
        if float(span["start"]) >= clip_start and float(span["end"]) <= clip_end
    ]
