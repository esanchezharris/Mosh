"""FakeAdapter — the dependency-free placeholder generative adapter.

Role (Stage 5 bring-up):
    The FakeAdapter is the *first* concrete ``GenerativeModelAdapter``. It returns
    deterministic placeholder audio so the entire generative orchestration — job
    submit/status/progress/cancel, the RenderLayer flow, cache fingerprinting, and
    the audition / A-B / accept-reject loop — can be proven end-to-end *before* the
    real StableAudio3Adapter (MLX, Apple Silicon only) is wired in. "FakeAdapter
    before SA3": prove the plumbing with the stub, swap the real model in last.

    Being deterministic and stdlib-only, it also runs in CI and on machines without
    the heavy SA3/MLX stack — which is why this whole service carries ZERO external
    Python dependencies.

# VERIFY: This file implements the *render* half of the job protocol only (a single
# deterministic generate/reimagine pass producing a WAV + manifest over files). The
# full process lifecycle — warmup / heartbeat / crash-restart / cancel-on-project-
# close — and the real StableAudio3Adapter are the NEXT increments, owned by the C++
# "Generative Job Manager" (Stage 5) and specified in module 05
# (05_GENERATIVE_LAYER.md). Do not add the SA3/MLX path here; it stays external and
# optional so this service keeps zero external dependencies.
"""

import json
import math
import os
import struct
import time
import wave

#: Fixed audio format for the placeholder render. Mono 16-bit PCM at 44.1 kHz —
#: the lowest-common-denominator format the C++ host can import without questions.
SAMPLE_RATE = 44100
CHANNELS = 1
SAMPLE_WIDTH = 2  # bytes per sample (16-bit)

#: Default render length when the request omits ``durationSec``.
DEFAULT_DURATION_SEC = 1.0

#: Simulated work: total wall-clock spread across this many progress steps so the
#: orchestration can observe progress advance from 0.0 -> 1.0 without real compute.
_PROGRESS_STEPS = 8
_PROGRESS_TOTAL_SEC = 0.4


def _stable_hash(text: str) -> int:
    """Deterministic, platform-independent 64-bit hash of ``text``.

    Python's built-in ``hash()`` is salted per-process (``PYTHONHASHSEED``), so it
    cannot be used for cross-run determinism. This is a tiny FNV-1a over the UTF-8
    bytes — stable across processes, machines, and Python versions.
    """
    h = 0xCBF29CE484222325
    for byte in text.encode("utf-8"):
        h ^= byte
        h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return h


def _tone_params(cache_key: str):
    """Derive a (frequency_hz, amplitude) pair deterministically from ``cache_key``.

    Identical fingerprints yield identical params (and therefore byte-identical
    WAVs); any change to the fingerprint moves the tone. Ranges are musical-ish and
    bounded so the output is always a clean, finite tone.
    """
    h = _stable_hash(cache_key)
    # Frequency in [110, 880) Hz (A2..~A5), amplitude in [0.20, 0.85).
    freq = 110.0 + (h % 770)
    amp = 0.20 + ((h >> 16) % 651) / 1000.0
    return freq, amp


class FakeAdapter:
    """Deterministic placeholder generative adapter.

    Exposes ``name`` / ``health()`` (capability reporting) and ``render(...)`` (the
    file+manifest job render). All audio is a stable function of the request's
    ``cacheKey`` so identical fingerprints reuse byte-identical results.
    """

    #: Adapter identifier surfaced by /health and /capabilities.
    name = "fake"

    def health(self) -> dict:
        """Return the capability block advertised to the C++ Generative Job Manager."""
        return {
            "generate": True,
            "reimagine": True,
        }

    def render(self, request: dict, on_progress, is_canceled) -> dict:
        """Render deterministic placeholder audio for one job.

        Args:
            request: The job request dict. Honoured keys: ``jobId`` (str, names the
                output files), ``cacheKey`` (str, the full fingerprint that the audio
                is a stable function of), ``mode`` (``"generate"``|``"reimagine"``),
                ``seed`` (int, recorded in the manifest), ``outDir`` (str, where the
                WAV + manifest are written), ``durationSec`` (float, optional).
            on_progress: Callable ``(pct: float) -> None`` invoked with monotonically
                increasing progress in ``[0.0, 1.0]``.
            is_canceled: Callable ``() -> bool``. Polled between work steps; when it
                returns truthy the render aborts cleanly and removes any partial WAV.

        Returns:
            The manifest dict (also written to ``<outDir>/<jobId>.manifest.json``), or
            ``None`` if the job was canceled before completion.

        The audio is mono 16-bit PCM at 44.1 kHz: a single tone whose frequency and
        amplitude are derived from ``cacheKey`` via :func:`_tone_params`, shaped by a
        short linear attack / release envelope so it is a stable, finite waveform.
        """
        job_id = request["jobId"]
        cache_key = request["cacheKey"]
        seed = int(request.get("seed", 0))
        out_dir = request["outDir"]
        duration_sec = float(request.get("durationSec", DEFAULT_DURATION_SEC))

        os.makedirs(out_dir, exist_ok=True)
        wav_path = os.path.join(out_dir, "%s.wav" % job_id)
        manifest_path = os.path.join(out_dir, "%s.manifest.json" % job_id)

        # Simulate compute: advance progress in steps, polling for cancellation
        # between each. Bail out cleanly (no partial WAV) the moment we're canceled.
        on_progress(0.0)
        step_sleep = _PROGRESS_TOTAL_SEC / _PROGRESS_STEPS
        for step in range(1, _PROGRESS_STEPS + 1):
            if is_canceled():
                self._cleanup_partial(wav_path)
                return None
            time.sleep(step_sleep)
            on_progress(step / _PROGRESS_STEPS)

        # One last cancellation check before we commit any bytes to disk.
        if is_canceled():
            self._cleanup_partial(wav_path)
            return None

        self._write_wav(wav_path, cache_key, duration_sec)

        manifest = {
            "wavPath": wav_path,
            "manifestPath": manifest_path,
            "cacheKey": cache_key,
            "adapter": self.name,
            "durationSec": duration_sec,
            "sampleRate": SAMPLE_RATE,
            "channels": CHANNELS,
            "seed": seed,
        }
        with open(manifest_path, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=2, sort_keys=True)

        on_progress(1.0)
        return manifest

    def _write_wav(self, wav_path: str, cache_key: str, duration_sec: float) -> None:
        """Write a deterministic mono 16-bit PCM tone to ``wav_path``.

        Frequency + amplitude come from ``cacheKey``; a short linear fade in/out
        avoids clicks. Written via the stdlib ``wave`` module — no numpy.
        """
        freq, amp = _tone_params(cache_key)
        n_frames = max(1, int(round(SAMPLE_RATE * duration_sec)))
        fade = min(n_frames // 10, SAMPLE_RATE // 100)  # ~10ms or 10% of clip, capped
        peak = 32767

        frames = bytearray()
        two_pi_f = 2.0 * math.pi * freq
        for n in range(n_frames):
            t = n / SAMPLE_RATE
            env = 1.0
            if fade > 0:
                if n < fade:
                    env = n / fade
                elif n >= n_frames - fade:
                    env = (n_frames - 1 - n) / fade
            sample = amp * env * math.sin(two_pi_f * t)
            value = int(max(-1.0, min(1.0, sample)) * peak)
            frames += struct.pack("<h", value)

        with wave.open(wav_path, "wb") as wav:
            wav.setnchannels(CHANNELS)
            wav.setsampwidth(SAMPLE_WIDTH)
            wav.setframerate(SAMPLE_RATE)
            wav.writeframes(bytes(frames))

    @staticmethod
    def _cleanup_partial(wav_path: str) -> None:
        """Remove a partially-written WAV after a cancellation. Best-effort."""
        try:
            os.remove(wav_path)
        except OSError:
            pass
