#!/usr/bin/env python3
"""Python port of ui/src/ui/drumPatternUtil.ts::parseDrumPattern (the add_drum_pattern
`pattern` string DSL). Ported by READING the TS source, not executing it (ground rule
5 of the r6-sft-data-pass task: Python only + reading TS for validation).

Kept intentionally in lockstep with the TS original's semantics (comment there says
it's already mirrored 1:1 with tests/test_drum_pattern.cpp) — this is a THIRD mirror,
for authoring-time validation only. If drumPatternUtil.ts changes, re-read it and
update this file; do not let it silently drift (the class of bug CLAUDE.md's
"generated files must be regenerated" gotcha warns about, applied to a hand-port
instead of a generator).
"""
from __future__ import annotations

from dataclasses import dataclass

LANE_PITCHES: dict[str, int] = {
    "kick": 36,
    "snare": 38,
    "clap": 39,
    "hat": 42,
    "hihat": 42,
    "closedhat": 42,
    "ch": 42,
    "openhat": 46,
    "oh": 46,
    "lowtom": 45,
    "midtom": 47,
    "crash": 49,
}


def lane_pitch(key: str) -> int:
    norm = "".join(ch for ch in key.lower() if ch not in " _-")
    return LANE_PITCHES.get(norm, -1)


@dataclass
class DrumPatternStep:
    pitch: int
    step: int
    velocity: int


@dataclass
class DrumPatternParse:
    ok: bool
    error: str | None = None
    steps_per_bar: int = 16
    bars: int = 0
    total_steps: int = 0
    steps: list[DrumPatternStep] | None = None
    lane_pitches: list[int] | None = None


def _err(msg: str) -> DrumPatternParse:
    return DrumPatternParse(ok=False, error=msg)


def parse_drum_pattern(pattern: str, steps_per_bar: int = 16, bars: int = 0, velocity: int = 100) -> DrumPatternParse:
    if not isinstance(steps_per_bar, int) or steps_per_bar < 1 or steps_per_bar > 64:
        return _err(f"stepsPerBar must be 1-64 (got {steps_per_bar})")
    if not isinstance(bars, int) or bars < 0 or bars > 16:
        return _err(f"bars must be 1-16 (got {bars})")
    if not isinstance(velocity, int) or velocity < 1 or velocity > 127:
        return _err(f"velocity must be 1-127 (got {velocity})")

    if not isinstance(pattern, str):
        return _err('pattern must be a "lane: steps" string')
    if not pattern.strip():
        return _err("empty pattern")

    entries: list[tuple[str, str]] = []
    for part in __import__("re").split(r"[;\n]", pattern):
        if not part.strip():
            continue
        i = part.find(":")
        if i < 0:
            return _err(f'pattern lane "{part.strip()}" is missing \':\' (expected "lane: steps")')
        entries.append((part[:i], part[i + 1:]))
    if not entries:
        return _err("pattern has no lanes")

    lanes: list[tuple[str, int, str]] = []  # (key, pitch, chars)
    seen: set[int] = set()
    for raw_key, raw_steps in entries:
        key = raw_key.strip()
        if key.lstrip("-").isdigit():
            pitch = int(key)
            if pitch < 0 or pitch > 127:
                return _err(f"lane pitch {key} out of range 0-127")
        else:
            pitch = lane_pitch(key)
            if pitch < 0:
                return _err(f'unknown lane "{key}"')
        if pitch in seen:
            return _err(f'duplicate lane "{key}" (pitch {pitch})')
        seen.add(pitch)
        chars = "".join(ch for ch in raw_steps if ch not in "| \t")
        if not chars:
            return _err(f'lane "{key}" is empty')
        for c in chars:
            if c not in "xX.-":
                return _err(f'lane "{key}" has invalid step char "{c}" (use x X . - |)')
        lanes.append((key, pitch, chars))

    longest = max(len(chars) for _, _, chars in lanes)
    out_bars = bars if bars != 0 else max(1, -(-longest // steps_per_bar))  # ceil div
    if out_bars > 16:
        return _err(f"pattern needs {out_bars} bars (max 16)")
    total_steps = steps_per_bar * out_bars
    for key, _pitch, chars in lanes:
        if len(chars) > total_steps:
            return _err(f'lane "{key}" is {len(chars)} steps but the pattern is {total_steps}')
        if total_steps % len(chars) != 0:
            return _err(f'lane "{key}" ({len(chars)} steps) doesn\'t divide the pattern ({total_steps} steps) — can\'t tile')

    steps: list[DrumPatternStep] = []
    for _key, pitch, chars in lanes:
        for s in range(total_steps):
            c = chars[s % len(chars)]
            if c == "x":
                steps.append(DrumPatternStep(pitch=pitch, step=s, velocity=velocity))
            elif c == "X":
                steps.append(DrumPatternStep(pitch=pitch, step=s, velocity=127))

    return DrumPatternParse(
        ok=True, steps_per_bar=steps_per_bar, bars=out_bars, total_steps=total_steps,
        steps=steps, lane_pitches=[p for _k, p, _c in lanes],
    )
