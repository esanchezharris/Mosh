#!/usr/bin/env python3
"""v2 auto real-instrument beat builder — competent, in-time, in-key beats.

Each beat = a real drum kit (assign_sample one-shots) + a real 808 bassline (one 808 repitched
in-key via MIDI) + a tempo/key-matched melodic Splice loop, all quantized on-grid and gain-staged
for headroom. These are the "competent" middle of the v2 spread; `degrade.py` derives subtle-worse
variants and `gold.py` supplies the owner's own beats as the top. Timing/structure are held
constant (everything on-grid, in-key, clean) so the owner's ratings measure TASTE, not brokenness.

Returns program-based candidate specs: {cand_id, group, label, intent:"auto", kind:"program",
program, meta}. The melodic loop carries bpm+key (from samples.catalog); the 808 (key C) is
repitched to that key; the drum pattern fills the window on a beat grid.
"""
from __future__ import annotations

import random

import kit as K
import samples as S

WINDOW_S = 10.0
NOTE = {"C": 0, "C#": 1, "DB": 1, "D": 2, "D#": 3, "EB": 3, "E": 4, "F": 5, "F#": 6, "GB": 6,
        "G": 7, "G#": 8, "AB": 8, "A": 9, "A#": 10, "BB": 10, "B": 11}
MINOR = [0, 2, 3, 5, 7, 8, 10]
MAJOR = [0, 2, 4, 5, 7, 9, 11]


def parse_key(k: str) -> tuple[int, bool]:
    """'Cm'/'A#m'/'Bmaj'/'F#' → (root_semitone, is_minor). Defaults to minor (trap/lofi norm)."""
    s = k.strip()
    root = s[:2] if len(s) >= 2 and s[1] in "#b" else s[:1]
    return NOTE.get(root.upper(), 0), ("maj" not in s.lower())


def _drum_notes(bpm: float, feel: str, seed: int) -> list[dict]:
    rng = random.Random(seed)
    n_beats = int(WINDOW_S * bpm / 60.0) + 4
    n_bars = n_beats // 4 + 1
    notes = []
    for bar in range(n_bars):
        b = bar * 4.0
        if feel == "plain":  # dull but on-grid: 4-on-floor kick, backbeat snare, quarter hats
            notes += [{"pitch": 36, "start": b + s, "length": 0.5, "velocity": 110} for s in range(4)]
            notes += [{"pitch": 38, "start": b + 1, "length": 0.5, "velocity": 108},
                      {"pitch": 38, "start": b + 3, "length": 0.5, "velocity": 108}]
            for s in range(4):
                notes.append({"pitch": 42, "start": b + s * 1.0, "length": 0.25, "velocity": 72})
        elif feel == "sparse":
            notes += [{"pitch": 36, "start": b + 0, "length": 0.5, "velocity": 116},
                      {"pitch": 38, "start": b + 2, "length": 0.5, "velocity": 108}]
            for s in range(4):
                notes.append({"pitch": 42, "start": b + s * 1.0, "length": 0.25, "velocity": 70})
        elif feel == "boombap":
            notes += [{"pitch": 36, "start": b + 0, "length": 0.5, "velocity": 116},
                      {"pitch": 36, "start": b + 2.5, "length": 0.5, "velocity": 104},
                      {"pitch": 38, "start": b + 1, "length": 0.5, "velocity": 110},
                      {"pitch": 38, "start": b + 3, "length": 0.5, "velocity": 110}]
            for s in range(8):
                notes.append({"pitch": 42, "start": b + s * 0.5, "length": 0.2, "velocity": 66 + (12 if s % 2 == 0 else 0)})
        else:  # trap
            notes += [{"pitch": 36, "start": b + 0, "length": 0.5, "velocity": 118},
                      {"pitch": 36, "start": b + 1.5, "length": 0.5, "velocity": 100},
                      {"pitch": 36, "start": b + 2.75, "length": 0.5, "velocity": 96},
                      {"pitch": 38, "start": b + 1, "length": 0.5, "velocity": 112},
                      {"pitch": 38, "start": b + 3, "length": 0.5, "velocity": 112}]
            for s in range(8):
                notes.append({"pitch": 42, "start": b + s * 0.5, "length": 0.18, "velocity": 64 + (14 if s % 2 == 0 else 0)})
            if bar % 2 == 1:  # a tasteful 16th hat roll into the bar end
                for s in range(4):
                    notes.append({"pitch": 42, "start": b + 3.0 + s * 0.25, "length": 0.12, "velocity": 60})
    return [n for n in notes if n["start"] <= n_beats]


def _bass_notes(root_note: int, is_minor: bool, bpm: float, seed: int) -> list[dict]:
    """A simple in-key 808 riff (root-heavy, sustained), on a beat grid."""
    rng = random.Random(seed)
    scale = MINOR if is_minor else MAJOR
    n_beats = int(WINDOW_S * bpm / 60.0) + 4
    # a repeating 4-beat figure: root, root, fifth, flat-7/sixth — trap 808 movement
    deg = [0, 0, 4, 5] if is_minor else [0, 0, 4, 3]
    notes, t, i = [], 0.0, 0
    while t <= n_beats:
        d = deg[i % len(deg)]
        pitch = root_note + scale[d % 7]
        notes.append({"pitch": int(pitch), "start": round(t, 3), "length": 1.0, "velocity": 112})
        t += rng.choice([1.0, 1.0, 1.5, 0.75])
        i += 1
    return notes


def _bass_root(target_semi: int, own_semi: int) -> int:
    note = 36 + ((target_semi - own_semi) % 12)
    return note - 12 if note > 43 else note


def _mel_imports(track_var: str, asset: str, dur: float) -> list[dict]:
    cmds, t = [], 0.0
    while t < WINDOW_S - 0.05:
        cmds.append({"command": "import_clip", "args": {"trackId": track_var, "file": asset, "startSeconds": round(t, 3)}})
        t += dur
    return cmds


def _beat_program(mel: dict, kit: dict, e808: dict, feel: str, *, drums_db, bass_db, keys_db,
                  seed: int, bass_transpose: int = 0) -> list[dict]:
    semi, is_minor = parse_key(mel["key"])
    own = NOTE.get(e808["key"].upper(), 0)
    broot = _bass_root(semi, own) + int(bass_transpose)
    prog = [{"command": "set_tempo", "args": {"bpm": mel["bpm"]}}]
    # drums
    prog += [{"command": "create_track", "args": {"name": "Drums", "type": "drum"}, "capture": {"D": "trackId"}}]
    prog += K.kit_assign_fragment("${D}", kit)
    prog += [{"command": "add_midi_clip", "args": {"trackId": "${D}", "start": 0, "length": WINDOW_S,
                                                   "notes": _drum_notes(mel["bpm"], feel, seed)}, "capture": {"DC": "clipId"}},
             {"command": "quantize_notes", "args": {"clipId": "${DC}", "division": 0.25, "strength": 1.0}},
             {"command": "set_track_volume", "args": {"trackId": "${D}", "db": drums_db}}]
    # 808
    prog += [{"command": "create_track", "args": {"name": "808", "type": "drum"}, "capture": {"B": "trackId"}},
             {"command": "assign_sample", "args": {"trackId": "${B}", "file": e808["asset"], "note": 36, "name": "808"}},
             {"command": "add_midi_clip", "args": {"trackId": "${B}", "start": 0, "length": WINDOW_S,
                                                   "notes": _bass_notes(broot, is_minor, mel["bpm"], seed + 7)}, "capture": {"BC": "clipId"}},
             {"command": "quantize_notes", "args": {"clipId": "${BC}", "division": 0.5, "strength": 1.0}},
             {"command": "set_track_volume", "args": {"trackId": "${B}", "db": bass_db}}]
    # melodic loop
    prog += [{"command": "create_track", "args": {"name": "Keys", "type": "audio"}, "capture": {"K": "trackId"}}]
    prog += _mel_imports("${K}", mel["asset"], mel["dur"])
    prog += [{"command": "set_track_volume", "args": {"trackId": "${K}", "db": keys_db}}]
    return prog


# conservative gain staging → headroom (no clipping); build_pack2 still has a headroom retry.
GAINS = dict(drums_db=-7.0, bass_db=-8.0, keys_db=-11.0)


def build_auto(n_target: int = 30) -> list[dict]:
    cat = S.catalog()
    kits = K.load_kits()
    e8 = K.eight08s()
    if not (cat and kits and e8):
        return []
    feels = ["trap", "boombap", "sparse"]
    cands = []
    i = 0
    for mi, mel in enumerate(cat):
        for v in range(3):  # 3 competent variants per melodic loop (different kit/feel)
            if len(cands) >= n_target:
                break
            kitc = kits[(mi + v) % len(kits)]
            e808 = e8[(mi + v) % len(e8)]
            feel = feels[v % len(feels)]
            prog = _beat_program(mel, kitc, e808, feel, seed=1000 + i, **GAINS)
            cid = f"auto_{mel['id']}_{feel}"
            cands.append({"cand_id": cid, "group": f"auto_{mel['id']}", "label": f"{feel}/{kitc['id']}",
                          "intent": "auto", "kind": "program", "program": prog,
                          "meta": {"bpm": mel["bpm"], "key": mel["key"], "kit": kitc["id"], "feel": feel,
                                   "mel": mel["id"], "e808": e808["id"]}})
            i += 1
    return cands[:n_target]


if __name__ == "__main__":
    cs = build_auto()
    print(f"{len(cs)} auto beats")
    from collections import Counter
    print("feels:", dict(Counter(c["meta"]["feel"] for c in cs)))
    print("kits:", dict(Counter(c["meta"]["kit"] for c in cs)))
    print("keys:", dict(Counter(c["meta"]["key"] for c in cs)))
