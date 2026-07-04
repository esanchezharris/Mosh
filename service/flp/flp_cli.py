#!/usr/bin/env python3
"""FL Studio .flp -> MoshIR JSON, via PyFLP (MIT).

Runs UNDER the dedicated flp venv (~/Library/Mosh/venvs/flp, Python 3.10 — PyFLP breaks on
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
import os
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


def _sg(obj, attr, default=None):
    """Safe attribute read. PyFLP property getters raise KeyError (not
    AttributeError) when an underlying event prop is absent, so getattr's default
    doesn't catch them — wrap broadly."""
    try:
        v = getattr(obj, attr)
        return default if v is None else v
    except Exception:  # noqa: BLE001 — KeyError/AttributeError/etc. from pyflp descriptors
        return default


def _pat_key(pat):
    """Stable identity for a pattern, used to track which patterns the playlist
    walk already placed. FL's pattern index is intrinsic; the NAME is not (FL
    allows duplicate names, and unnamed patterns all read back as None) — keying
    the dedup by name silently treats a *different* same-name pattern as already
    placed and drops it. Prefer the index; fall back to object identity, which
    over-includes (a duplicate, appended sequentially) rather than silently
    dropping when the index can't be read."""
    idx = _sg(pat, "index")
    if isinstance(idx, int) and not isinstance(idx, bool):
        return ("i", idx)
    return ("o", id(pat))


# FL stores sample paths with backslashes and FL env-var roots. Best-effort map to
# absolute macOS paths so the importer emits a real import_clip (files may still be
# missing → relink territory; factory/user roots are install-specific guesses).
_FL_ROOTS = {
    # FL sample paths embed "...\Data\Patches\..." after the factory root, so the root
    # maps to the FL Studio dir (not its Data subfolder) to avoid a doubled "Data".
    "%FLStudioFactoryData%": os.path.expanduser("~/Documents/Image-Line/FL Studio"),
    "%FLStudioUserData%": os.path.expanduser("~/Documents/Image-Line/FL Studio"),
    "%FLStudioInstallDir%": "/Applications/FL Studio.app/Contents/Resources/FL",
}


def _norm_sample_path(p):
    if not p:
        return None
    s = str(p).replace("\\", "/")
    for var, root in _FL_ROOTS.items():
        if s.startswith(var):
            s = root.replace("\\", "/") + s[len(var):]
            break
    return os.path.expanduser(s)


def _note_to_ir(n, ppq, min_len_ticks):
    """One pyflp Note -> an IR note dict (beats from the pattern/clip start), or None."""
    pitch = _key_to_midi(_sg(n, "key"))
    if pitch is None:
        return None
    length_ticks = max(int(_sg(n, "length", 0) or 0), min_len_ticks)
    return {
        "pitch": pitch,
        "start": round(_sg(n, "position", 0) / ppq, 6),
        "length": round(length_ticks / ppq, 6),
        "velocity": int(_clamp(round(_sg(n, "velocity", 100) or 0), 1, 127)),
    }


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

    sec_per_beat = (60.0 / tempo) if tempo else 0.5  # 120 BPM fallback for clip seconds

    # Channels indexed by rack id (notes reference rack_channel == iid; audio playlist
    # items reference a channel directly).
    channels = {}
    for ch in proj.channels:
        iid = _sg(ch, "iid")
        if iid is not None:
            channels[int(iid)] = ch

    # MoshIR tracks are created lazily as clips land on a channel (so we never emit
    # empty tracks). `order` preserves first-touch order for a deterministic result.
    tracks_by_ch = {}
    order = []

    def ensure_track(rc):
        if rc in tracks_by_ch:
            return tracks_by_ch[rc]
        ch = channels.get(rc)
        name = _sg(ch, "name") or _sg(ch, "display_name") or _sg(ch, "internal_name") if ch is not None else None
        track = {"name": name or f"Channel {rc}", "type": "audio", "clips": []}
        if ch is not None:
            pan_raw = _sg(ch, "pan")
            if isinstance(pan_raw, (int, float)):
                track["pan"] = round(_clamp((pan_raw - 6400) / 6400.0, -1, 1), 4)  # FL pan: 0..12800, 6400 center
            if _sg(ch, "enabled") is False:
                track["mute"] = True
        tracks_by_ch[rc] = track
        order.append(rc)
        return track

    def place_pattern(pat, notes, start_beats, length_beats):
        """Emit one MIDI clip per rack_channel the pattern's notes touch, at start_beats."""
        by_ch = {}
        for n in notes:
            irn = _note_to_ir(n, ppq, min_len_ticks)
            if irn is not None:
                by_ch.setdefault(int(_sg(n, "rack_channel", 0)), []).append(irn)
        pat_name = _sg(pat, "name")
        for rc, ir_notes in by_ch.items():
            ensure_track(rc)["clips"].append(
                {"name": pat_name or None, "kind": "midi", "start": round(start_beats * sec_per_beat, 6),
                 "length": round(length_beats * sec_per_beat, 6), "notes": ir_notes}
            )

    def pattern_len_beats(notes):
        ends = [(_sg(n, "position", 0) + max(int(_sg(n, "length", 0) or 0), min_len_ticks)) for n in notes]
        return max(1.0, math.ceil(max(ends) / ppq)) if ends else 1.0

    note_patterns = [(p, ns) for p in proj.patterns for ns in [list(_sg(p, "notes", []) or [])] if ns]

    def placed_end_beats():
        """Latest end (in beats) across everything placed so far — where appended
        sequential content should start."""
        m = 0.0
        for t in tracks_by_ch.values():
            for c in t["clips"]:
                m = max(m, (c["start"] + c["length"]) / sec_per_beat if sec_per_beat else 0.0)
        return m

    def lay_sequential(patterns, cursor):
        for pat, notes in patterns:
            place_pattern(pat, notes, cursor, pattern_len_beats(notes))
            cursor += pattern_len_beats(notes)

    # ---- playlist-accurate placement: walk ONE arrangement's timeline ----
    # Only the current/selected arrangement is the song: FL plays one at a time and each
    # has its own 0-based timeline, so walking all of them would overlap their clips.
    # PyFLP can also raise mid-walk on some files (KeyError building arrangement.tracks),
    # so the walk is guarded and we track whether it completed.
    arr = None
    try:
        arr = proj.arrangements.current
    except Exception:  # noqa: BLE001
        arr = None
    if arr is None:
        arrs = list(proj.arrangements)
        arr = arrs[0] if arrs else None

    placements = 0  # note-bearing pattern placements
    audio_items = 0
    placed_keys = set()  # _pat_key of every pattern the walk placed
    walk_completed = True
    if arr is not None:
        try:
            for plt in arr.tracks:
                for it in plt:
                    pos = _sg(it, "position")
                    if not isinstance(pos, (int, float)):
                        continue
                    start_beats = pos / ppq
                    length = _sg(it, "length")
                    len_beats = (length / ppq) if isinstance(length, (int, float)) and length > 0 else None
                    pat = _sg(it, "pattern")
                    ch = _sg(it, "channel")
                    if pat is not None:
                        pnotes = list(_sg(pat, "notes", []) or [])
                        if not pnotes:
                            continue  # empty pattern placement (spacer) — nothing to emit
                        place_pattern(pat, pnotes, start_beats, len_beats if len_beats else pattern_len_beats(pnotes))
                        placements += 1
                        placed_keys.add(_pat_key(pat))
                    elif ch is not None:
                        sp = _norm_sample_path(_sg(ch, "sample_path"))
                        rc = _sg(ch, "iid")
                        if not sp or rc is None:
                            continue  # a channel clip with no sample (e.g. automation)
                        ensure_track(int(rc))["clips"].append(
                            {"name": _sg(ch, "name") or None, "kind": "wave",
                             "start": round(start_beats * sec_per_beat, 6),
                             "length": round((len_beats if len_beats else 1.0) * sec_per_beat, 6),
                             "sourceFile": sp}
                        )
                        audio_items += 1
        except Exception as e:  # noqa: BLE001 — pyflp can throw building the playlist
            walk_completed = False
            unmappable.append(f"FL playlist read stopped early ({type(e).__name__}); {placements} placement(s) captured before the error")

    # ---- decide what to do with the patterns the walk didn't place ----
    if placements == 0:
        # No pattern placements (no playlist items, all empty, or a crash before the first
        # placement) → lay every note pattern end-to-end so nothing is lost.
        lay_sequential(note_patterns, placed_end_beats())
        if note_patterns:
            unmappable.append(f"no pattern placements on the playlist — {len(note_patterns)} pattern(s) laid sequentially")
    elif not walk_completed:
        # Partial playlist (crashed mid-walk): patterns we never reached would otherwise be
        # dropped, so append the unplaced remainder sequentially after the placed content.
        remainder = [(p, ns) for p, ns in note_patterns if _pat_key(p) not in placed_keys]
        lay_sequential(remainder, placed_end_beats())
        unmappable.append(
            f"FL playlist: {placements} placement(s) + {audio_items} audio clip(s) positioned before the read stopped; "
            f"{len(remainder)} remaining pattern(s) appended sequentially"
        )
    else:
        # Complete read → the playlist is authoritative; patterns it never references are
        # sketches (logged, not imported).
        unplaced = sum(1 for p, _ in note_patterns if _pat_key(p) not in placed_keys)
        unmappable.append(f"FL playlist: {placements} pattern placement(s) + {audio_items} audio clip(s) positioned from the arrangement")
        if unplaced:
            unmappable.append(f"{unplaced} note-bearing pattern(s) not on the playlist (not imported)")

    if audio_items:
        unmappable.append("FL audio sample roots (%FLStudio*Data%) are best-effort absolute paths — may need relinking; clip trim/loop offsets not modeled")
    unmappable.append("channel volumes (FL internal taper) and time signature not mapped")

    tracks = [tracks_by_ch[rc] for rc in order]
    _OUT.write(json.dumps({"ok": True, "session": {"tempo": tempo, "tracks": tracks}, "unmappable": unmappable}))


if __name__ == "__main__":
    main()
