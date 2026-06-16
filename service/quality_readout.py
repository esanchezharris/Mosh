"""quality_readout.py — heuristic DSP quality readout for rendered audio (judge v0).

The spec's judge panel (CLAP + MuQ-MuLan + Audiobox-Aesthetics + MERT-FAD; 05 §7)
exposes a `pq` production-quality signal + `flags` on every render. That panel is a
heavy, separately-versioned stack (audiobox-aesthetics needs a torchaudio matched to
the venv's torch — risky on bleeding-edge cu130). So v0 ships a TRANSPARENT DSP proxy:
signal-hygiene metrics (loudness, clipping, dynamics, spectral balance, phase, silence)
folded into a `pq` in [0,10] (Audiobox-like scale) + human-readable `flags`.

This is a HEURISTIC readout, NOT a learned aesthetic model — it measures signal hygiene,
not musicality/timbre/prompt-adherence. The UI labels it "DSP readout (heuristic)". A
learned judge can later override `pq` behind MOSH_JUDGE (a separate judge venv) while
keeping these flags.

Deps: numpy + soundfile ONLY (both already in the SA3 venv). Pure-CPU, <50 ms on a
few-second clip — safe to run inline in the job service without touching torch/GPU.
"""
from __future__ import annotations

import numpy as np
import soundfile as sf

EPS = 1e-12


def _db(v: float) -> float:
    return 20.0 * np.log10(max(float(v), EPS))


def _clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


def analyze_wav(path: str) -> dict:
    """Return {pq: float[0,10], metrics: {...}, flags: [str, ...]} for a WAV file."""
    x, sr = sf.read(path, always_2d=True, dtype="float64")  # [n, ch]
    return analyze_array(x, sr)


def analyze_array(x, sr: int) -> dict:
    """Same as analyze_wav but on an in-memory array [n, ch] (or [n]) — lets callers
    score a source region (pq_base) without a temp file."""
    x = np.asarray(x, dtype="float64")
    if x.ndim == 1:
        x = x[:, None]
    n, ch = x.shape
    if n == 0:
        return {"pq": 0.0, "metrics": {}, "flags": ["empty: no samples"]}
    mono = x.mean(axis=1)

    # ── levels ──
    sample_peak = float(np.max(np.abs(x)))
    peak_dbfs = _db(sample_peak)
    rms = float(np.sqrt(np.mean(mono ** 2) + EPS))
    rms_dbfs = _db(rms)
    crest_db = _db(sample_peak / max(rms, EPS))
    dc = float(np.mean(mono))

    # longest full-scale run (clip detector)
    full = np.abs(x).max(axis=1) >= 0.9995
    run = best = 0
    for f in full:
        run = run + 1 if f else 0
        if run > best:
            best = run

    # ── spectrum (single Hann frame, ≤16384 samples ≈ 0.37 s @ 44.1k) ──
    N = int(min(n, 16384))
    win = np.hanning(N) if N > 1 else np.ones(1)
    S = np.abs(np.fft.rfft(mono[:N] * win)) + EPS
    freqs = np.fft.rfftfreq(N, 1.0 / sr)
    centroid = float(np.sum(freqs * S) / np.sum(S))
    cum = np.cumsum(S)
    ridx = int(np.searchsorted(cum, 0.85 * cum[-1]))
    rolloff = float(freqs[min(ridx, len(freqs) - 1)])
    # spectral flatness (geo mean / arith mean of power): ~0 = a pure tone (sine /
    # test-tone / sine-synth — NOT music), higher = broadband (drums, a real mix).
    # Averaged over the WHOLE file (not just the first frame, which could be a single
    # kick) so it represents the mix. Catches "agent exported a tone, scores clean".
    flN = 4096
    if n >= flN:
        acc = np.zeros(flN // 2 + 1)
        cnt = 0
        w2 = np.hanning(flN)
        for i in range(0, n - flN + 1, flN // 2):
            acc += np.abs(np.fft.rfft(mono[i:i + flN] * w2)) ** 2
            cnt += 1
        Pavg = acc / max(cnt, 1) + EPS
    else:
        Pavg = S ** 2 + EPS
    flatness = float(np.exp(np.mean(np.log(Pavg))) / np.mean(Pavg))

    # ── stereo ──
    if ch >= 2:
        l, r = x[:, 0], x[:, 1]
        corr = float(np.sum(l * r) / (np.sqrt(np.sum(l ** 2) * np.sum(r ** 2)) + EPS))
    else:
        corr = 1.0

    # ── silence / dropout ──
    fl = 2048
    nf = max(1, n // fl)
    fr = mono[:nf * fl].reshape(nf, fl)
    fdb = 20.0 * np.log10(np.maximum(np.sqrt(np.mean(fr ** 2, axis=1)), EPS))
    silent = fdb < -50.0
    silence_ratio = float(np.mean(silent))
    dropout = False
    if nf >= 3:
        loud = ~silent
        for i in range(1, nf - 1):
            if silent[i] and loud[i - 1] and loud[i + 1]:
                dropout = True
                break

    metrics = {
        "sr": sr, "channels": ch, "samples": n,
        "peak_dbfs": round(peak_dbfs, 2), "rms_dbfs": round(rms_dbfs, 2),
        "lufs_approx": round(rms_dbfs, 2), "crest_db": round(crest_db, 2),
        "dc_offset": round(dc, 5), "clip_run": int(best),
        "centroid_hz": round(centroid, 1), "rolloff85_hz": round(rolloff, 1),
        "stereo_corr": round(corr, 3), "silence_ratio": round(silence_ratio, 3),
        "spectral_flatness": round(flatness, 4),
    }

    # ── flags ──
    flags = []
    if peak_dbfs >= -0.1 or best >= 3:
        flags.append(f"clipping: peak {peak_dbfs:.2f} dBFS ({best} samples at full scale)")
    if rms_dbfs < -40:
        flags.append(f"too_quiet: level {rms_dbfs:.1f} dBFS (< -40)")
    if silence_ratio > 0.95:
        flags.append(f"near_silent: {silence_ratio * 100:.0f}% frames < -50 dBFS")
    if abs(dc) > 0.01:
        flags.append(f"dc_offset: {dc:+.3f} (> 0.01)")
    if crest_db < 3.0:
        flags.append(f"over_compressed: crest {crest_db:.1f} dB (< 3)")
    if centroid > 6000 and rms_dbfs > -45:
        flags.append(f"harsh: centroid {centroid:.0f} Hz")
    if rolloff < 1500 and silence_ratio < 0.5:
        flags.append(f"muddy: 85% rolloff {rolloff:.0f} Hz")
    if corr < 0:
        flags.append(f"out_of_phase: stereo corr {corr:.2f} (< 0)")
    if dropout:
        flags.append("dropout: silent gap mid-signal")
    if flatness < 0.01 and silence_ratio < 0.95:
        flags.append(f"tonal_suspect: flatness {flatness:.4f} — likely a test tone / empty synth, not a real mix")

    # ── pq in [0,10] (soft sub-scores summing to 10) ──
    s_loud = _clamp(1 - abs(rms_dbfs - (-14)) / 14)          # peaks at -14 dBFS
    s_head = _clamp(1 - max(0.0, peak_dbfs + 1.0) / 0.9)     # full if peak<=-1, 0 at -0.1
    s_dyn = _clamp((crest_db - 3) / (12 - 3))                # 0 at 3 dB, full at >=12
    s_cent = _clamp(1 - abs(np.log2(max(centroid, EPS) / 1800)) / 2)
    s_clean = 1 - min(1.0, 0.5 * (abs(dc) > 0.01) + 0.5 * (corr < 0) + 0.5 * (silence_ratio > 0.95))
    pq = 3.0 * s_loud + 2.0 * s_head + 2.0 * s_dyn + 1.5 * s_cent + 1.5 * s_clean
    pq = _clamp(pq, 0.0, 10.0)

    # hard caps — a broken render never scores "good"
    if any(f.startswith("clipping") for f in flags):
        pq = min(pq, 4.0)
    if silence_ratio > 0.95:
        pq = min(pq, 1.0)
    if corr < 0:
        pq = min(pq, 5.0)
    if flatness < 0.005 and silence_ratio < 0.95:
        pq = min(pq, 3.5)   # a near-pure tone is not a real mix, however "clean"
    pq = round(pq, 2)

    return {"pq": pq, "metrics": metrics, "flags": flags}


def compare(pq, pq_base):
    """Fold rendered pq vs source pq_base into a UI delta. pq_base None for generate."""
    if pq_base is None:
        return {"pq": pq, "pq_base": None, "delta": None, "improved": None}
    delta = round(pq - pq_base, 2)
    return {"pq": pq, "pq_base": pq_base, "delta": delta, "improved": delta >= 0}


# ── learned judge (MOSH_JUDGE=learned) — Meta Audiobox-Aesthetics via a sidecar ──
# The producer-lab repo already has the Audiobox-Aesthetics PQ model installed and
# wrapped. We spawn its persistent sidecar (`mosh_judge_server.py`) with the producer-
# lab venv ONCE (model loaded once), then score rendered WAVs over a stdin/stdout pipe.
# Any failure → score() returns None and the caller falls back to the DSP `pq`.
import json as _json
import os as _os
import subprocess as _sp
import threading as _th

_PRODUCER_LAB = _os.environ.get("MOSH_JUDGE_PRODUCER_LAB", r"C:\Users\dawha\MonsterDAWW\producer-lab")
#: Run the sidecar with producer-lab's venv (it has audiobox_aesthetics + torch)...
_JUDGE_PYTHON = _os.environ.get(
    "MOSH_JUDGE_PYTHON", _os.path.join(_PRODUCER_LAB, ".venv", "Scripts", "python.exe"))
#: ...but the sidecar itself lives in THIS repo (it adds producer-lab/src to sys.path).
_JUDGE_SCRIPT = _os.environ.get(
    "MOSH_JUDGE_SCRIPT",
    _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "scripts", "mosh_judge_server.py"))


class LearnedJudge:
    """Client for the persistent Audiobox sidecar. Lazily spawns it, scores WAV paths,
    and degrades to None on any problem (sidecar missing, model-load failure, crash)."""

    def __init__(self):
        self._proc = None
        self._lock = _th.Lock()
        self._ready = False
        self._dead = False

    def available(self) -> bool:
        return _os.path.isfile(_JUDGE_PYTHON) and _os.path.isfile(_JUDGE_SCRIPT)

    def start(self) -> bool:
        """Spawn the sidecar and block on its handshake (the model load). Idempotent."""
        with self._lock:
            if self._ready:
                return True
            if self._dead or self._proc is not None:
                return self._ready
            if not self.available():
                self._dead = True
                return False
            try:
                self._proc = _sp.Popen(
                    [_JUDGE_PYTHON, _JUDGE_SCRIPT],
                    stdin=_sp.PIPE, stdout=_sp.PIPE, stderr=_sp.DEVNULL,
                    text=True, bufsize=1, cwd=_PRODUCER_LAB,
                )
                line = self._proc.stdout.readline()  # blocks until model loaded (~6-8 s)
                obj = _json.loads(line) if line else {}
                self._ready = bool(obj.get("ready"))
                if not self._ready:
                    self._dead = True
            except Exception:  # noqa: BLE001
                self._dead = True
                self._ready = False
            return self._ready

    def warmup(self) -> None:
        try:
            self.start()
        except Exception:  # noqa: BLE001
            pass

    def score(self, wav_path: str):
        """Return {PQ, PC, CE, CU} for a WAV, or None on any failure (→ DSP fallback)."""
        if self._dead:
            return None
        if not self._ready and not self.start():
            return None
        with self._lock:
            try:
                if self._proc is None or self._proc.poll() is not None:
                    self._dead = True
                    return None
                self._proc.stdin.write(str(wav_path) + "\n")
                self._proc.stdin.flush()
                line = self._proc.stdout.readline()
                if not line:
                    self._dead = True
                    return None
                obj = _json.loads(line)
                return None if "error" in obj else obj
            except Exception:  # noqa: BLE001
                self._dead = True
                return None

    def close(self) -> None:
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                try:
                    self._proc.stdin.write("__quit__\n")
                    self._proc.stdin.flush()
                except Exception:  # noqa: BLE001
                    pass
                try:
                    self._proc.terminate()
                except Exception:  # noqa: BLE001
                    pass


_LEARNED = None


def learned_judge() -> LearnedJudge:
    """Process-wide singleton sidecar client."""
    global _LEARNED
    if _LEARNED is None:
        _LEARNED = LearnedJudge()
    return _LEARNED


if __name__ == "__main__":
    import json
    import sys

    print(json.dumps(analyze_wav(sys.argv[1]), indent=2))
