"""Live render-in-the-loop driver for §8: a real hosted synth (Serum/Vital/...) as the
verification oracle.

`LiveSynthRenderer` emits a MoshOps command rollout that loads the synth ONCE, feeds it a
fixed MIDI phrase, then — for each candidate patch — sets the params and exports a WAV, all
in a *single* `Mosh --run-script` launch. That amortizes the (dominant) binary-startup +
plugin-instantiation cost across the whole population, which is what makes CMA-ES against a
real VST tractable (the spec's "render-in-the-loop with the real synth" claim, measured).

Indices are the plugin's automatable-parameter indices (the same index `set_plugin_param`
and the snapshot's per-plugin `params[]` use). `screen_audible()` finds which indices
actually move the sound so the optimizer never wastes renders on inert knobs.

Needs the built binary (set MOSH_BIN, else /Applications/Mosh.app). Pure-Python read-back
via soundfile; no torch/torchaudio.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Iterable, Optional

import numpy as np

DEFAULT_BIN = "/Applications/Mosh.app/Contents/MacOS/Mosh"

# A single sustained note → steady timbre, the cleanest target for patch matching.
DEFAULT_NOTES = [{"pitch": 60, "start": 0.0, "length": 3.5, "velocity": 110}]


def mosh_bin(bin_path: Optional[str] = None) -> str:
    return bin_path or os.environ.get("MOSH_BIN", "").strip() or DEFAULT_BIN


class LiveSynthRenderer:
    """Render real-synth patches by replaying MoshOps. `render`/`render_batch` return
    (mono float32, sr) tuples — drop-in for the §8 `SynthRenderer` protocol + §6 scorer."""

    def __init__(self, plugin_id: str, *, notes: Optional[list] = None,
                 bin_path: Optional[str] = None, midi_length: float = 4.0,
                 name: str = "Synth", timeout_s: int = 600,
                 session_dir: Optional[str] = None) -> None:
        self.plugin_id = plugin_id
        self.notes = notes if notes is not None else DEFAULT_NOTES
        self.bin = mosh_bin(bin_path)
        self.midi_length = midi_length
        self.name = name
        self.timeout_s = timeout_s
        self.session_dir = session_dir
        self.last_results: list = []

    def available(self) -> bool:
        return os.path.isfile(self.bin)

    def _base_cmds(self) -> list:
        return [
            {"command": "create_track", "args": {"name": self.name, "type": "audio"},
             "capture": {"T": "trackId"}},
            {"command": "load_plugin", "args": {"trackId": "${T}", "pluginId": self.plugin_id,
                                                "index": 0}},
            {"command": "add_midi_clip", "args": {"trackId": "${T}", "start": 0,
                                                  "length": self.midi_length, "notes": self.notes}},
        ]

    def render_batch(self, param_dicts: list[dict], out_dir: Optional[str] = None
                     ) -> list[tuple[np.ndarray, int]]:
        """Render every candidate patch in ONE engine launch. `param_dicts[i]` maps an
        int param-index → normalized value (0..1). Returns one (audio, sr) per candidate."""
        if not self.available():
            raise RuntimeError(f"Mosh binary not found at {self.bin!r} (set MOSH_BIN)")
        import soundfile as sf

        work = Path(out_dir) if out_dir else Path(tempfile.mkdtemp(prefix="live-synth-"))
        work.mkdir(parents=True, exist_ok=True)
        cmds = self._base_cmds()
        outs: list[Path] = []
        for i, params in enumerate(param_dicts):
            for idx, val in params.items():
                cmds.append({"command": "set_plugin_param",
                             "args": {"trackId": "${T}", "index": 0,
                                      "paramIndex": int(idx), "value": float(val)}})
            out_i = work / f"cand_{i:04d}.wav"
            outs.append(out_i)
            cmds.append({"command": "export_audio", "args": {"file": str(out_i)}})

        script = work / "rollout.jsonl"
        results = work / "results.jsonl"
        with open(script, "w") as f:
            for c in cmds:
                f.write(json.dumps(c) + "\n")
        env = dict(os.environ, MOSH_RUN_SCRIPT=str(script), MOSH_RUN_SCRIPT_OUT=str(results))
        if self.session_dir:
            env["MOSH_SESSION_DIR"] = self.session_dir
        proc = subprocess.run([self.bin, "--run-script"], env=env, capture_output=True,
                              text=True, timeout=self.timeout_s, check=False)
        if proc.returncode != 0:
            raise RuntimeError(f"live render failed (exit {proc.returncode}): "
                               f"{(proc.stderr or '').strip()[-400:]!r}")
        self.last_results = []
        if results.exists():
            self.last_results = [json.loads(ln) for ln in results.read_text().splitlines() if ln.strip()]

        rendered: list[tuple[np.ndarray, int]] = []
        for out_i in outs:
            if not out_i.exists() or out_i.stat().st_size == 0:
                raise RuntimeError(f"candidate render missing: {out_i}")
            data, sr = sf.read(str(out_i), dtype="float32", always_2d=True)
            rendered.append((data.mean(axis=1).astype(np.float32), sr))
        return rendered

    def render(self, params: dict) -> tuple[np.ndarray, int]:
        return self.render_batch([params])[0]

    def snapshot_params(self) -> list[dict]:
        """Load the synth and return its first-16 automatable params [{index,name,value}].
        One launch; used to discover real param names/indices before optimizing."""
        if not self.available():
            raise RuntimeError(f"Mosh binary not found at {self.bin!r} (set MOSH_BIN)")
        work = Path(tempfile.mkdtemp(prefix="live-snap-"))
        cmds = self._base_cmds() + [{"command": "get_snapshot", "args": {}}]
        script = work / "s.jsonl"
        results = work / "r.jsonl"
        with open(script, "w") as f:
            for c in cmds:
                f.write(json.dumps(c) + "\n")
        env = dict(os.environ, MOSH_RUN_SCRIPT=str(script), MOSH_RUN_SCRIPT_OUT=str(results))
        if self.session_dir:
            env["MOSH_SESSION_DIR"] = self.session_dir
        proc = subprocess.run([self.bin, "--run-script"], env=env, capture_output=True,
                              text=True, timeout=self.timeout_s, check=False)
        if proc.returncode != 0:
            raise RuntimeError(f"snapshot failed (exit {proc.returncode}): "
                               f"{(proc.stderr or '').strip()[-300:]!r}")
        snap = None
        for ln in results.read_text().splitlines():
            if not ln.strip():
                continue
            r = json.loads(ln)
            if r.get("command") == "get_snapshot":
                snap = r.get("data")
        if not snap:
            raise RuntimeError("no snapshot in results")
        for trk in snap.get("tracks", []):
            for pl in trk.get("plugins", []):
                if pl.get("params"):
                    return pl["params"]
        return []


def screen_audible(renderer: LiveSynthRenderer, scorer, indices: Iterable[int],
                   lo: float = 0.2, hi: float = 0.8) -> list[tuple[int, float]]:
    """Render each index at `lo` vs `hi` (all in one launch) and rank by the embedding
    distance the swing produces. Inert knobs (≈0) get dropped before optimization."""
    indices = list(indices)
    batch = []
    for idx in indices:
        batch.append({idx: lo})
        batch.append({idx: hi})
    rendered = renderer.render_batch(batch)
    out = []
    for k, idx in enumerate(indices):
        a, b = rendered[2 * k], rendered[2 * k + 1]
        out.append((idx, float(scorer.score(a, b))))
    out.sort(key=lambda t: -t[1])
    return out
