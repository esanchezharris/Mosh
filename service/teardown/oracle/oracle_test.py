#!/usr/bin/env python3
"""Tests for the §6 oracle scorer + cache (render needs the binary; tested via gating).

Self-contained — synthesizes signals, no model/binary:
    python3 service/teardown/oracle/oracle_test.py   (exit 0 = all pass)

Guards the spec's baked-in rules: loudness-normalize BEFORE scoring (the cheapest
reward hack closed — a gain change must not move the score), embedding distance is
discriminative + deterministic, the cache keys by rendered-WAV hash, and render()
degrades cleanly when the engine binary is absent.
"""
import os
import sys
import tempfile
from pathlib import Path

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown.oracle import EmbeddingScorer, Oracle, RenderCache, loudness_normalize, wav_hash  # noqa: E402

SR = 44100
fails: list[str] = []


def check(name: str, cond: bool, extra: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


def synth(kind: str, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    if kind == "kick":
        n = int(0.35 * SR); t = np.arange(n) / SR
        f = 50 + 70 * np.exp(-t * 30)
        y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 10)
    else:  # hat
        n = int(0.08 * SR)
        y = np.diff(rng.standard_normal(n + 1)) * np.exp(-np.arange(n) / SR * 110)
    return (y / (np.max(np.abs(y)) or 1.0) * 0.9).astype(np.float32)


kick = synth("kick", 1)
kick2 = synth("kick", 2)
hat = synth("hat", 100)
scorer = EmbeddingScorer()

# ── 1. distance semantics ────────────────────────────────────────────────────
check("identical → distance ~0", abs(scorer.score(kick, kick)) < 1e-6, f"{scorer.score(kick, kick):.2e}")
d_same = scorer.score(kick, kick2)
d_diff = scorer.score(kick, hat)
check("same-type closer than cross-type", d_same < d_diff, f"same={d_same:.3f} diff={d_diff:.3f}")
check("distances are non-negative", d_same >= -1e-9 and d_diff >= -1e-9)

# ── 2. loudness invariance (the cheapest reward hack, closed) ────────────────
quiet = (kick * 0.03).astype(np.float32)
loud = (kick * 5.0).astype(np.float32)  # would clip raw; normalize handles it
d_quiet = scorer.score(quiet, hat)
d_loud = scorer.score(loud, hat)
check("gain change does not move the score", abs(d_quiet - d_diff) < 1e-4 and abs(d_loud - d_diff) < 1e-4,
      f"quiet={d_quiet:.4f} loud={d_loud:.4f} ref={d_diff:.4f}")
norm = loudness_normalize(quiet, SR)
rms = float(np.sqrt(np.mean(norm.astype(np.float64) ** 2)))
check("loudness_normalize hits target RMS", abs(20 * np.log10(rms) - (-20.0)) < 0.5, f"{20*np.log10(rms):.2f} dBFS")
check("silent input passes through normalize", np.array_equal(loudness_normalize(np.zeros(100, np.float32), SR),
                                                              np.zeros(100, np.float32)))

# ── 3. determinism ───────────────────────────────────────────────────────────
check("score is deterministic x3", len({scorer.score(kick, hat) for _ in range(3)}) == 1)
check("scorer.version is set", bool(scorer.version) and "embcos" in scorer.version)

# ── 4. cache keyed by rendered-WAV hash ──────────────────────────────────────
check("wav_hash stable for identical buffers", wav_hash(kick) == wav_hash(kick.copy()))
check("wav_hash differs for different buffers", wav_hash(kick) != wav_hash(hat))
with tempfile.TemporaryDirectory() as td:
    c = RenderCache(Path(td) / "cache.json")
    c.put("k1", 0.42)
    check("cache get returns put value", c.get("k1") == 0.42)
    check("cache miss is None", c.get("nope") is None)
    c2 = RenderCache(Path(td) / "cache.json")  # reopen → persisted
    check("cache persists across reopen", c2.get("k1") == 0.42)

# ── 5. render gracefully gated on the engine binary ──────────────────────────
orc = Oracle(bin_path="/definitely/not/a/real/mosh/binary")
check("Oracle.available() False when binary absent", orc.available() is False)
try:
    orc.render([{"command": "create_track", "args": {}}])
    raised = False
except RuntimeError:
    raised = True
check("render() raises a clear error without the binary", raised)

# ── 6. render path resolution (the fixed temp/export logic), binary-free ──────
cmds_a, out_a, tmp_a = Oracle._resolve_render([{"command": "create_track", "args": {}}], "/x/out.wav")
check("resolve: out_wav target honored, no temp", str(out_a) == "/x/out.wav" and tmp_a is None)
check("resolve: export_audio appended for out_wav", any(c.get("command") == "export_audio" for c in cmds_a))
cmds_b, out_b, tmp_b = Oracle._resolve_render(
    [{"command": "export_audio", "args": {"file": "/y/baked.wav", "format": "wav"}}], None)
check("resolve: baked-in export target honored", str(out_b) == "/y/baked.wav" and tmp_b is None)
check("resolve: no second export appended", sum(c.get("command") == "export_audio" for c in cmds_b) == 1)
cmds_c, out_c, tmp_c = Oracle._resolve_render([{"command": "create_track", "args": {}}], None)
check("resolve: temp wav returned for cleanup", tmp_c is not None and tmp_c == out_c)
if tmp_c and tmp_c.exists():
    tmp_c.unlink()
try:
    Oracle._resolve_render([{"command": "export_audio", "args": {}}], None)
    raised_noexp = False
except ValueError:
    raised_noexp = True
check("resolve: export_audio without args.file raises", raised_noexp)

# ── 7. render surfaces a nonzero engine exit (no silent stale/partial-WAV scoring) ──
with tempfile.TemporaryDirectory() as td:
    fake = Path(td) / "fakemosh"
    fake.write_text("#!/bin/sh\necho 'engine boom' >&2\nexit 3\n")
    fake.chmod(0o755)
    raised_exit = False
    try:
        Oracle(bin_path=str(fake)).render([{"command": "create_track", "args": {}}])
    except RuntimeError as e:
        raised_exit = "exit 3" in str(e)
    check("render() raises on a nonzero engine exit (exit 3)", raised_exit)

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
