"""The Oracle facade: render a MoshOps command sequence to audio, score it, cache it.

`render()` drives the engine's headless replay (`Mosh --run-script`, which reads a JSONL
from MOSH_RUN_SCRIPT and lands an `export_audio`), so it needs the built binary — gated
by `available()` (set MOSH_BIN, else /Applications/Mosh.app). `score()` / the cache are
pure Python and work standalone. SMART's result is the tractability proof: rendering is
not the bottleneck at RL scale.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Optional, Union

import numpy as np

DEFAULT_BIN = "/Applications/Mosh.app/Contents/MacOS/Mosh"
CommandList = list  # list[dict] of {"command","args"[, "capture"]}


def _mosh_bin() -> str:
    return os.environ.get("MOSH_BIN", "").strip() or DEFAULT_BIN


def _as_mono(a) -> np.ndarray:
    if isinstance(a, tuple):
        a = a[0]
    return np.asarray(a, dtype=np.float32)


class Oracle:
    def __init__(self, scorer=None, cache=None, bin_path: Optional[str] = None,
                 range_s: float = 10.0, timeout_s: int = 120) -> None:
        from .score import EmbeddingScorer

        self.scorer = scorer or EmbeddingScorer()
        self.cache = cache
        self.bin = bin_path or _mosh_bin()
        self.range_s = range_s
        self.timeout_s = timeout_s

    def available(self) -> bool:
        return os.path.isfile(self.bin)

    @staticmethod
    def _resolve_render(commands: CommandList, out_wav: Optional[Union[str, Path]]) -> tuple[list, Path, Optional[Path]]:
        """Pure: decide the export target + temp-to-clean. Three cases —
        (a) commands already export → read THAT command's args.file as the target;
        (b) out_wav given → export there;
        (c) neither → a temp wav (returned as the 3rd element so the caller cleans it).
        Kept side-effect-light + testable without the engine binary."""
        cmds = list(commands)
        existing = next((c for c in cmds if c.get("command") == "export_audio"), None)
        if existing is not None:
            target = (existing.get("args") or {}).get("file")
            if not target:
                raise ValueError("commands include export_audio with no args.file")
            return cmds, Path(target), None
        if out_wav is not None:
            out = Path(out_wav)
        else:
            fd, tmp_path = tempfile.mkstemp(suffix=".wav")
            os.close(fd)            # close immediately — no fd leak
            out = Path(tmp_path)
        cmds.append({"command": "export_audio", "args": {"file": str(out), "format": "wav"}})
        return cmds, out, (None if out_wav is not None else out)

    def render(self, commands: CommandList, out_wav: Optional[Union[str, Path]] = None) -> tuple[np.ndarray, int]:
        """Replay `commands` through MoshOps and return the rendered (mono, sr).

        Uses the caller's `export_audio` target if present, else `out_wav`, else a temp
        wav (which is cleaned up after reading)."""
        if not self.available():
            raise RuntimeError(f"Mosh binary not found at {self.bin!r} (set MOSH_BIN to enable render)")
        import soundfile as sf

        cmds, out, tmp_wav = self._resolve_render(commands, out_wav)
        fd, script = tempfile.mkstemp(suffix=".jsonl")
        try:
            with os.fdopen(fd, "w") as f:
                for c in cmds:
                    f.write(json.dumps(c) + "\n")
            env = dict(os.environ, MOSH_RUN_SCRIPT=script)
            proc = subprocess.run([self.bin, "--run-script"], env=env, capture_output=True,
                                  text=True, timeout=self.timeout_s, check=False)
            # --run-script returns the command-failure count as its exit code: nonzero means a
            # command in the rollout failed → the render is invalid, don't silently score a
            # stale/partial WAV (reward corruption for the RL oracle).
            if proc.returncode != 0:
                raise RuntimeError(f"Mosh render failed (exit {proc.returncode}): "
                                   f"{(proc.stderr or '').strip()[-400:]!r}")
            if not out.exists() or out.stat().st_size == 0:
                raise RuntimeError("render produced no/empty output wav (script must reach export_audio)")
            data, sr = sf.read(str(out), dtype="float32", always_2d=True)
            return data.mean(axis=1).astype(np.float32), sr
        finally:
            if os.path.exists(script):
                os.unlink(script)
            if tmp_wav is not None and tmp_wav.exists():
                tmp_wav.unlink()

    def score(self, a, b) -> float:
        return self.scorer.score(a, b)

    def render_and_score(self, commands: CommandList, target, out_wav=None) -> tuple[tuple[np.ndarray, int], float]:
        y, sr = self.render(commands, out_wav)
        key = None
        if self.cache is not None:
            from .cache import wav_hash
            key = f"{self.scorer.version}|{wav_hash(y)}|{wav_hash(_as_mono(target))}"
            hit = self.cache.get(key)
            if hit is not None:
                return (y, sr), float(hit)
        s = self.score((y, sr), target)
        if self.cache is not None and key is not None:
            self.cache.put(key, s)
        return (y, sr), s
