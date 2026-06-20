#!/usr/bin/env python3
"""FL Studio .flp -> MoshIR JSON, via PyFLP (MIT).

Runs UNDER the dedicated flp venv (service/flp/.venv, Python 3.10 — PyFLP breaks on
3.11+), invoked by the importer frontend (ui/src/import/parseFlp.ts) as a subprocess.
Emits a MoshIR-shaped session to stdout that the TS side wraps into an ImportIR and
feeds the same emitter/verifier the RPP/ALS parsers use:

  {"ok": true,
   "session": {"tempo": float, "tracks": [IRTrack, ...]},
   "unmappable": [str, ...]}
  // IRTrack = {name, type:"audio", pan?, mute?, clips:[IRClip]}
  // IRClip  = {name?, kind:"midi", start(sec), length(sec), notes:[{pitch,start(beats),length(beats),velocity}]}

FL's model is channel-rack + patterns placed on a playlist — NOT linear track-per-clip.
We flatten it (lossy by design, every loss logged in `unmappable`):
  * each rack channel referenced by notes -> one MoshIR track (name/pan/mute);
  * each pattern's notes are grouped by rack_channel; every (channel, pattern) group
    becomes one MIDI clip carrying that channel's notes (note.position is already
    pattern-relative -> beats from clip start);
  * patterns are laid out SEQUENTIALLY (a pattern starts where the previous ended) —
    the real playlist arrangement (repeats, absolute placement, audio/automation
    clips) is logged, not reconstructed. Channel volumes (FL's internal taper) and
    time signature are logged too.

Usage:  flp_cli.py <input.flp>
"""
import json
import math
import re
import sys

# PyFLP can emit parse warnings to stdout; capture the REAL stdout up front and
# route everything else to stderr so stdout carries ONLY our JSON result.
_OUT = sys.stdout
sys.stdout = sys.stderr

_NOTE_BASE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_NOTE_RE = re.compile(r"^([A-Ga-g])([#b]?)(-?\d+)$")


def _emit_fail(msg: str) -> "None":
    _OUT.write(json.dumps({"ok": False, "error": msg}))
    sys.exit(1)


def _key_to_midi(key) -> "int | None":
    """FL key -> MIDI number. PyFLP returns an FL-convention note name (FL displays
    middle C / raw-60 as 'C5'), so octave*12 + semitone reproduces the raw MIDI key.
    Tolerate an int too (older/other PyFLP builds)."""
    if isinstance(key, bool):
        return None
    if isinstance(key, int):
        return max(0, min(127, key))
    m = _NOTE_RE.match(str(key).strip())
    if not m:
        return None
    letter, acc, octv = m.group(1).upper(), m.group(2), int(m.group(3))
    semi = _NOTE_BASE[letter] + (1 if acc == "#" else -1 if acc == "b" else 0)
    midi = octv * 12 + semi  # FL: C5 -> 60
    return max(0, min(127, midi))


def _clamp(x, lo, hi):
    return max(lo, min(hi, x))


def main() -> "None":
    if len(sys.argv) < 2:
        _emit_fail("usage: flp_cli.py <input.flp>")
    path = sys.argv[1]

    try:
        import pyflp
    except Exception as e:  # noqa: BLE001
        _emit_fail(f"pyflp not importable: {e}")

    try:
        proj = pyflp.parse(path)
    except Exception as e:  # noqa: BLE001
        _emit_fail(f"failed to parse {path}: {e}")

    unmappable = []
    ppq = int(getattr(proj, "ppq", 96)) or 96
    tempo = float(getattr(proj, "tempo", 0) or 0) or None
    min_len_ticks = max(1, ppq // 4)  # FL step notes store length 0 -> default to a 16th

    # Channels indexed by their rack id (notes reference rack_channel == iid).
    channels = {}
    for ch in proj.channels:
        iid = getattr(ch, "iid", None)
        if iid is not None:
            channels[int(iid)] = ch

    # Collect note-bearing patterns in document order.
    note_patterns = []
    for pat in proj.patterns:
        notes = list(getattr(pat, "notes", []) or [])
        if notes:
            note_patterns.append((pat, notes))

    # Which rack channels are actually played -> those become MoshIR tracks (iid order).
    used = sorted({int(n.rack_channel) for _, notes in note_patterns for n in notes})

    # Build per-channel track skeletons. (clips filled below.)
    tracks_by_ch = {}
    order = []
    for rc in used:
        ch = channels.get(rc)
        name = None
        if ch is not None:
            name = getattr(ch, "name", None) or getattr(ch, "display_name", None) or getattr(ch, "internal_name", None)
        track = {"name": name or f"Channel {rc}", "type": "audio", "clips": []}
        if ch is not None:
            pan_raw = getattr(ch, "pan", None)
            if isinstance(pan_raw, (int, float)):
                track["pan"] = round(_clamp((pan_raw - 6400) / 6400.0, -1, 1), 4)  # FL pan: 0..12800, 6400 center
            enabled = getattr(ch, "enabled", None)
            if enabled is False:
                track["mute"] = True
        tracks_by_ch[rc] = track
        order.append(rc)

    sec_per_beat = (60.0 / tempo) if tempo else 0.5  # 120 BPM fallback for clip seconds

    # Lay patterns end-to-end; within a pattern, notes keep their (pattern-relative) position.
    cursor_beats = 0.0
    for pat, notes in note_patterns:
        ends = [(n.position + max(int(n.length or 0), min_len_ticks)) for n in notes]
        pat_len_beats = max(1.0, math.ceil((max(ends) / ppq))) if ends else 1.0
        by_ch = {}
        for n in notes:
            pitch = _key_to_midi(getattr(n, "key", None))
            if pitch is None:
                continue
            length_ticks = max(int(getattr(n, "length", 0) or 0), min_len_ticks)
            by_ch.setdefault(int(n.rack_channel), []).append(
                {
                    "pitch": pitch,
                    "start": round(n.position / ppq, 6),  # beats from clip/pattern start
                    "length": round(length_ticks / ppq, 6),
                    "velocity": int(_clamp(round(getattr(n, "velocity", 100) or 0), 1, 127)),
                }
            )
        pat_name = getattr(pat, "name", None)
        for rc, ir_notes in by_ch.items():
            tracks_by_ch[rc]["clips"].append(
                {
                    "name": pat_name or None,
                    "kind": "midi",
                    "start": round(cursor_beats * sec_per_beat, 6),
                    "length": round(pat_len_beats * sec_per_beat, 6),
                    "notes": ir_notes,
                }
            )
        cursor_beats += pat_len_beats

    tracks = [tracks_by_ch[rc] for rc in order]

    # Log the lossy/unmodelled parts (never silently dropped).
    if len(note_patterns) > 1:
        unmappable.append(
            f"FL playlist arrangement flattened: {len(note_patterns)} patterns laid sequentially "
            "(absolute placement / repeats not modeled)"
        )
    skipped = len(list(proj.channels)) - len(order)
    if skipped > 0:
        unmappable.append(f"{skipped} channel(s) with no notes (audio/automation/unused) not imported")
    unmappable.append("channel volumes (FL internal taper) and time signature not mapped")

    _OUT.write(json.dumps({"ok": True, "session": {"tempo": tempo, "tracks": tracks}, "unmappable": unmappable}))


if __name__ == "__main__":
    main()
