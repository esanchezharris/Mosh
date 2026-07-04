#!/usr/bin/env python3
"""Real drum kits + 808s from the user's musica/Splice libraries, for v2 auto beats.

v1 used the bundled 8-pad kit + a sine sub — not production-grade ("the drums and bass need a
lot more attention"). v2 builds beats from REAL one-shots via `assign_sample` (load a sample onto
a MIDI note in a repitching Sampler). This module:
  • scans a few curated kit folders, picks one kick/snare/hat/clap each (robust to exact names),
  • exposes a pool of keyed 808 one-shots,
  • resamples every chosen one-shot to 44.1k/PCM_16 (the headless-render SR gotcha applies to
    sampler sources too — keep everything at engine SR),
  • emits the `assign_sample` command fragments for a kit / an 808.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

import numpy as np
import soundfile as sf

MUSICA = Path(os.path.expanduser("~/Downloads/musica"))
SPLICE = Path(os.path.expanduser(os.environ.get("MOSH_SAMPLE_LIBRARY", "~/Splice/sounds/packs")))
ASSET_DIR = Path(__file__).resolve().parent / ".assets"
SR = 44100

# Drum-pad GM notes
KICK_N, SNARE_N, CLAP_N, HAT_N = 36, 38, 39, 42

# Curated kit roots (folders under ~/Downloads/musica). Each is scanned recursively; the first
# wav whose name matches a role keyword (and not an anti-keyword) wins. Kits missing kick/snare/hat
# are skipped at load time.
KIT_ROOTS = [
    ("h34v3n",   "! H34V3N DRUM KIT VOL 1"),
    ("mainkit3", "The Main Kit 3"),
    ("bayarea",  "!BAY AREA ESSENTIALS 2"),
    ("ikiru",    "Dana Collyd & Anill – Ikiru [Drum Kit] Demo"),
    ("chemi",    "@curlygotcha - Chemi Drum Kit (Over 200 Unique Sounds)"),
]

# Keyed 808 one-shots (Splice, mostly key C → easy repitch). (rel-under-SPLICE, key-letter).
EIGHT08S = [
    ("OS_ATL_808_pure_C",  "ZONE 6 - ATLANTA TRAP/Origin_Sound_-_ZONE_6_-_ATLANTA_TRAP/one_shots/808s/OS_ATL_808_pure_C.wav", "C"),
    ("MO_QW_808_lucky_C",  "Patch Provider, a qwaston moment/Moment_qwaston_Patch_Provider/one_shots/tonal_one_shots/808s/MO_QW_bass_808_lucky_C.wav", "C"),
    ("CHAKRA_808_baby_C",  "Chakra - ARIA Ultra Trap Vol. 1/Traktrain_-_Chakra_-_ARIA_-_Ultra_Trap_Vol._1/One_Shots/Bass_One_Shots/808_Bass_One_Shots/TRKTRN_CHAKRA_808_Bass_Baby_C.wav", "C"),
    ("OS_WCW_808_reso_C",  "WEST COAST WAVES/Origin_Sound_-_WEST_COAST_WAVES/one_shots/808/OS_WCW__808_reso_C.wav", "C"),
]

ROLE_KW = {
    "kick":  (["kick", "808 kick"], ["808", "loop", "snare", "hat", "clap", "perc"]),
    "snare": (["snare"], ["loop", "reverse"]),
    "hat":   (["hat", "hi-hat", "hihat", "hi hat"], ["open", "loop"]),
    "clap":  (["clap"], ["loop"]),
}


def _resample(p: str) -> str | None:
    if not p or not os.path.isfile(p):
        return None
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    dst = ASSET_DIR / f"{hashlib.sha1(p.encode()).hexdigest()[:16]}.wav"
    if dst.is_file():
        return str(dst)
    try:
        y, sr = sf.read(p, always_2d=True, dtype="float32")
    except Exception:
        return None
    if sr != SR:
        n = int(round(y.shape[0] * SR / sr))
        xi = np.linspace(0, y.shape[0] - 1, n)
        idx = np.arange(y.shape[0])
        y = np.stack([np.interp(xi, idx, y[:, c]) for c in range(y.shape[1])], axis=1).astype(np.float32)
    sf.write(str(dst), y, SR, subtype="PCM_16")
    return str(dst)


def _find_role(root: Path, role: str) -> str | None:
    kws, anti = ROLE_KW[role]
    best = None
    for f in sorted(root.rglob("*.wav")):
        name = f.name.lower()
        if any(a in name for a in anti):
            continue
        if any(k in name for k in kws):
            best = str(f)
            break
    return best


def load_kits() -> list[dict]:
    """Return usable kits: {id, kick, snare, hat, clap?} with resampled 44.1k asset paths."""
    out = []
    for kid, rel in KIT_ROOTS:
        root = MUSICA / rel
        if not root.is_dir():
            continue
        parts = {r: _resample(_find_role(root, r)) for r in ("kick", "snare", "hat", "clap")}
        if parts["kick"] and parts["snare"] and parts["hat"]:
            out.append({"id": kid, **{k: v for k, v in parts.items() if v}})
    return out


def eight08s() -> list[dict]:
    out = []
    for sid, rel, key in EIGHT08S:
        p = _resample(str(SPLICE / rel))
        if p:
            out.append({"id": sid, "asset": p, "key": key})
    return out


def kit_assign_fragment(track_var: str, kit: dict) -> list[dict]:
    cmds = [{"command": "assign_sample", "args": {"trackId": track_var, "file": kit["kick"], "note": KICK_N, "name": "Kick"}},
            {"command": "assign_sample", "args": {"trackId": track_var, "file": kit["snare"], "note": SNARE_N, "name": "Snare"}},
            {"command": "assign_sample", "args": {"trackId": track_var, "file": kit["hat"], "note": HAT_N, "name": "Hat"}}]
    if kit.get("clap"):
        cmds.append({"command": "assign_sample", "args": {"trackId": track_var, "file": kit["clap"], "note": CLAP_N, "name": "Clap"}})
    return cmds


if __name__ == "__main__":
    ks = load_kits()
    print(f"kits: {len(ks)}")
    for k in ks:
        print(f"  {k['id']:10s} kick={Path(k['kick']).name[:24]!r:26} snare✓ hat✓ clap={'✓' if k.get('clap') else '—'}")
    print(f"808s: {[e['id'] for e in eight08s()]}")
