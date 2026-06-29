#!/usr/bin/env python3
"""§11 gold ANCHORS from DAW project files — the clean validation corpus for the keystone test.

Reuses the EXISTING TS importer (ui `npm run import -- <f> --json`) to parse .als/.flp/.rpp into
MoshIR (does NOT reimplement the parser), then extracts REAL per-role drum GROOVES (the actual clip
/ note onsets) and renders per-element stems with role-matched §1 library samples. The groove is
exact (straight from the project file); the samples are library-mapped because project sample paths
are frequently cross-platform-unresolvable (e.g. Windows F:/ paths on a Mac). This is the upgrade
that matters for the keystone: REAL, genre-diverse arrangements instead of 3 hardcoded patterns,
held out BY SOURCE FILE.

Output: an AnchorStore of Anchors with `reconstruction_class="exact"` and per-role stem wavs.

    PYTHONPATH=service python3 service/teardown/flywheel/project_anchors.py <store_dir> <file_or_dir>...
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from teardown.drummatch.index import SampleIndex  # noqa: E402
from teardown.flywheel.anchors import Anchor, AnchorStore  # noqa: E402

SR = 44100
UI_DIR = Path(__file__).resolve().parents[3] / "ui"
INDEX_DIR = os.environ.get("REWARD_INDEX_DIR", "/tmp/td-reward-index")

# track/sample name keyword → drum role. Longest/first match wins; order matters (check 808 before bass).
ROLE_KEYWORDS = [
    ("808", "808"), ("sub", "808"),
    ("kick", "kick"), ("bd ", "kick"), ("bassdrum", "kick"),
    ("snare", "snare"), ("snr", "snare"),
    ("clap", "clap"), ("snap", "clap"),
    ("hat", "hat"), ("hh", "hat"), ("hihat", "hat"), ("cymbal", "hat"), ("ride", "hat"),
    ("perc", "perc"), ("shaker", "perc"), ("tom", "perc"), ("rim", "perc"), ("conga", "perc"),
]

# General MIDI percussion map (channel-10 / drum-rack default) → role. Lets us read a MIDI DRUM RACK
# (one track triggering many drums by pitch) without relying on the track name — the big yield win.
GM_DRUM = {
    35: "kick", 36: "kick",
    38: "snare", 40: "snare", 37: "perc",
    39: "clap",
    42: "hat", 44: "hat", 46: "hat", 49: "hat", 51: "hat", 52: "hat", 53: "hat", 55: "hat", 57: "hat", 59: "hat",
    41: "perc", 43: "perc", 45: "perc", 47: "perc", 48: "perc", 50: "perc",
    54: "perc", 56: "perc", 58: "perc", 69: "perc", 70: "perc", 75: "perc",
}


def _role_of(*names: str) -> str | None:
    blob = " ".join(n.lower() for n in names if n)
    for kw, role in ROLE_KEYWORDS:
        if kw in blob:
            return role
    return None


def _track_role_onsets(track: dict, tempo: float) -> dict[str, list[float]]:
    """Per-role hit onsets (s) for ONE track. Priority: (1) a drum-role track NAME tags ALL its hits
    to that role (handles named single-role tracks incl. melodic 808 lines); else (2) a MIDI track
    whose notes are mostly GM drum pitches is a DRUM RACK → split its notes by pitch→role. Non-drum
    tracks → {}."""
    spb = 60.0 / max(1e-6, tempo)
    sample_names = " ".join(os.path.basename(c.get("sourceFile", "")) for c in track.get("clips", []))
    named = _role_of(track.get("name", ""), sample_names)
    wave_hits, midi_hits = [], []
    for c in track.get("clips", []):
        cs = float(c.get("start") or 0.0)
        if c.get("kind") == "wave":
            wave_hits.append(cs)
        else:
            for n in (c.get("notes") or []):
                midi_hits.append((cs + float(n.get("start") or 0.0) * spb, int(n.get("pitch") or 0)))
    out: dict[str, list[float]] = {}
    if named:
        for cs in wave_hits:
            out.setdefault(named, []).append(cs)
        for (o, _p) in midi_hits:
            out.setdefault(named, []).append(o)
        return out
    if midi_hits:                                    # unnamed → try GM drum-rack split
        gm = [(o, GM_DRUM[p]) for (o, p) in midi_hits if p in GM_DRUM]
        if gm and len(gm) >= 0.5 * len(midi_hits):   # mostly GM drums ⇒ a drum rack
            for (o, role) in gm:
                out.setdefault(role, []).append(o)
    return out


def _load_sample(path: str, max_s: float = 1.5) -> np.ndarray:
    import librosa
    import soundfile as sf
    y, fsr = sf.read(path, dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    if fsr != SR:
        y = librosa.resample(y, orig_sr=fsr, target_sr=SR)
    y = y[: int(max_s * SR)]
    peak = float(np.max(np.abs(y))) if y.size else 0.0
    return (y / peak).astype(np.float32) if peak > 0 else y.astype(np.float32)


def import_ir(project_file: str, out_json: str) -> dict | None:
    """Run the existing TS importer → MoshIR JSON. Returns the parsed IR (or None on failure)."""
    try:
        subprocess.run(["npm", "run", "import", "--", project_file, "--json", out_json],
                       cwd=str(UI_DIR), capture_output=True, text=True, timeout=180)
        if os.path.exists(out_json):
            return json.load(open(out_json)).get("ir")
    except Exception as e:
        print(f"  import failed for {project_file}: {type(e).__name__}: {e}", file=sys.stderr)
    return None


class _Pools:
    def __init__(self, index_dir: str = INDEX_DIR):
        self.idx = SampleIndex()
        if os.path.isdir(index_dir):
            self.idx.load(index_dir)
        self.pools: dict[str, list[str]] = {}
        for p, r in zip(self.idx.paths, self.idx.roles):
            self.pools.setdefault(r, []).append(p)

    def pick(self, role: str, seed: str) -> str | None:
        ps = self.pools.get(role) or self.pools.get("perc") or []
        if not ps:
            return None
        h = int(hashlib.sha1(seed.encode()).hexdigest(), 16)
        return ps[h % len(ps)]


def _densest_window(onsets_by_role: dict[str, list[float]], bar_s: float, bars: int = 4) -> float:
    """Start (s) of the `bars`-bar window holding the most total hits (the main groove, not the intro)."""
    win = bar_s * bars
    all_on = sorted(t for v in onsets_by_role.values() for t in v)
    if not all_on:
        return 0.0
    best_start, best_n = 0.0, -1
    for cand in all_on:
        n = sum(1 for t in all_on if cand <= t < cand + win)
        if n > best_n:
            best_n, best_start = n, cand
    return best_start


def render_stem(onsets: list[float], sample: np.ndarray, n: int) -> np.ndarray:
    """Place `sample` at each onset (seconds) in an n-sample buffer, peak-normalized. Shared by the
    anchor builder and the §11 ablation re-render (swap = same onsets, different sample)."""
    buf = np.zeros(n, np.float32)
    for t in onsets:
        i = int(t * SR)
        seg = sample[: max(0, n - i)]
        if 0 <= i < n and seg.size:
            buf[i:i + seg.size] += seg
    peak = float(np.max(np.abs(buf))) or 1.0
    return (buf / peak * 0.9).astype(np.float32)


def build_anchor(ir: dict, source_id: str, pools: _Pools, stem_dir: Path,
                 bars: int = 4, min_roles: int = 3, min_hits: int = 2) -> Anchor | None:
    s = ir.get("session") or {}
    tempo = float(s.get("tempo") or 120.0)
    bar_s = 4.0 * 60.0 / tempo
    by_role: dict[str, list[float]] = {}
    for t in s.get("tracks") or []:
        for role, ons in _track_role_onsets(t, tempo).items():
            by_role.setdefault(role, []).extend(ons)
    by_role = {r: sorted(v) for r, v in by_role.items() if len(v) >= min_hits}
    if len(by_role) < min_roles:
        return None
    w0 = _densest_window(by_role, bar_s, bars)
    w1 = w0 + bar_s * bars
    window_s = bar_s * bars
    n = int(window_s * SR)
    import soundfile as sf
    stems: dict[str, str] = {}
    onsets_local: dict[str, list[float]] = {}
    for role, ons in by_role.items():
        local = [round(t - w0, 4) for t in ons if w0 <= t < w1]
        if len(local) < 1:
            continue
        samp = pools.pick(role, f"{source_id}:{role}")
        if not samp:
            continue
        try:
            sample = _load_sample(samp)
        except Exception:
            continue
        sp = stem_dir / f"{source_id}__{role}.wav"
        sf.write(str(sp), render_stem(local, sample, n), SR)
        stems[role] = str(sp)
        onsets_local[role] = local
    if len(stems) < min_roles:
        return None
    return Anchor(anchor_id=source_id, source_audio="", reconstruction_audio="",
                  stems=stems, reconstruction_class="exact", yield_overall=1.0,
                  onsets=onsets_local, window_s=round(window_s, 4))


def _iter_project_files(args: list[str]):
    exts = (".als", ".flp", ".rpp")
    for a in args:
        p = Path(a)
        if p.is_dir():
            for f in sorted(p.rglob("*")):
                if f.suffix.lower() in exts and "Backup" not in f.parts:
                    yield str(f)
        elif p.suffix.lower() in exts:
            yield str(p)


def main(argv=None) -> int:
    argv = argv or sys.argv[1:]
    if len(argv) < 2:
        print("usage: project_anchors.py <store_dir> <file_or_dir>...", file=sys.stderr)
        return 2
    store_dir = Path(argv[0])
    stem_dir = store_dir / "stems"
    stem_dir.mkdir(parents=True, exist_ok=True)
    store = AnchorStore(store_dir)
    pools = _Pools()
    if not pools.pools:
        print("  no §1 index pools — build /tmp/td-reward-index first", file=sys.stderr)
        return 1
    ir_tmp = str(store_dir / "_ir.json")
    added, skipped = 0, 0
    for pf in _iter_project_files(argv[1:]):
        sid = hashlib.sha1(pf.encode()).hexdigest()[:10] + "_" + Path(pf).stem.replace(" ", "_")[:24]
        ir = import_ir(pf, ir_tmp)
        if not ir:
            skipped += 1
            continue
        a = build_anchor(ir, sid, pools, stem_dir)
        if a and store.add(a):
            added += 1
            print(f"  + anchor {sid}  roles={sorted(a.stems)}", flush=True)
        else:
            skipped += 1
    print(f"\n  anchors added {added}, skipped {skipped}; store gold={len(store.gold())} "
          f"(reconstruction_class=exact counts as gold? -> {[a.reconstruction_class for a in store.all()][:1]})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
