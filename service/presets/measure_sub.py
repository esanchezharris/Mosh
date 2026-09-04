#!/usr/bin/env python3
"""measure_sub.py — R2.6 (produce lane, quality-pivot 2026-09): measure the 30-120 Hz
sub-band RMS (dBFS) of a one-shot/loop WAV, so the produce-lane picker
(ui/src/agent/loop/drumPalette.ts, out of scope here) can prefer the palette `bass`/`808`
item with the most sub-band energy — owner note 6 on produce-r1-2026-09-02.meta.json:
"808 / low end weak or wrong". The band measurement is a Welch-free single-window FFT
(Hann, first 2 s), which is plenty for a short 808 one-shot and cheap enough to run over
every bass item in a manifest on --write.

WHY not soundfile/librosa: this module is meant to run under the SAME bare `python3`
the repo gate uses for service/**/*_test.py (pyenv 3.12, no guaranteed numpy/soundfile),
and `service/coverage.py` shadows the PyPI `coverage` package whenever service/ is on
sys.path, which breaks numba (and so librosa) with `module 'coverage' has no attribute
'types'` (see docs/PALETTE-GENERATION-METHOD.md "Known repo landmine"). Sidestep it
entirely: read WAV bytes by hand (RIFF/fmt/data chunk parsing over PCM 8/16/24/32-bit
and IEEE-float 32/64-bit — covers both the palette-v2 16-bit stereo one-shots and a
float32 source sample seen in the owner's raw kit downloads, which the stdlib `wave`
module cannot open at all: `wave.Error: unknown format: 3`), then measure with numpy
when it happens to be importable and a pure-stdlib Goertzel-style estimate when it is
not — so the test suite can exercise BOTH paths deterministically regardless of what is
installed on the machine running the gate.

Method: downmix to mono, take the first `analysis_seconds` (default 2.0) of samples.
Overall RMS is the plain time-domain RMS of that whole segment, in dBFS. The sub-band
share is "sum of spectral power in [30, 120) Hz over sum of spectral power across the
whole analysis window" (numpy: `np.fft.rfft` of a Hann-windowed frame; stdlib fallback:
a handful of per-bin Goertzel evaluations across the band, normalized against the
Hann-windowed frame's own time-domain energy via Parseval's theorem — same physical
quantity, cheaper than a Goertzel sweep of the full spectrum). The reported
`sub_energy_db` is the overall RMS scaled by sqrt(that share), expressed in dBFS — i.e.
"how loud would this file be if only its 30-120 Hz content played."

CLI: `measure_sub.py <manifest.json> [--write]` — manifest is a real palette/lab-manifest
shape (`{"items": [...]}` or a bare list), each item `{"role_guess": ..., "path": ...}`.
Every item whose role_guess is `bass`/`808` (case-insensitive) is measured and printed
as a table, ranked loudest-sub-band first; `--write` adds `sub_energy_db`/`rms_db` to
those items IN PLACE and rewrites the file, leaving every other field (and every
non-bass/808 item) untouched. The rewrite sniffs the source file's own indent width and
trailing-newline convention so an unrelated re-run doesn't churn the diff (the two real
manifests on this machine were written with two DIFFERENT indent widths by two
different, older tools) — new keys land at the END of a touched item's dict, appended
after whatever keys it already had (never reordering the ones already there), so a
`--write` is idempotent: running it twice produces byte-identical output the second
time.

stdlib(+numpy)-only, network-free, runnable as `python3 measure_sub.py ...` (repo test
convention: service/**/*_test.py is auto-discovered by the gate's py_tests).
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
from pathlib import Path
from typing import Optional

SUB_BAND = (30.0, 120.0)
DEFAULT_ANALYSIS_SECONDS = 2.0
EPS = 1e-9  # log floor, matches service/teardown/render/balance.py's rms_db convention
TARGET_ROLES = {"bass", "808"}
GOERTZEL_MAX_N = 4096  # stdlib-fallback FFT-equivalent window: plenty of resolution
# (df ≈ sr/N ≈ 10-11 Hz at 44.1/48k) for an 90 Hz-wide band, and keeps the pure-Python
# per-bin Goertzel loop (~O(band_bins * N)) well under a second per file.


def _db(amplitude: float) -> float:
    return 20.0 * math.log10(max(float(amplitude), EPS))


def _rms(values) -> float:
    n = len(values)
    if n == 0:
        return 0.0
    return math.sqrt(sum(v * v for v in values) / n)


def _try_import_numpy():
    try:
        import numpy as np  # noqa: F401
    except Exception:
        return None
    return np


# ── WAV parsing (stdlib struct only — see module docstring for why not `wave`) ──


class WavReadError(ValueError):
    pass


def read_wav_mono(path, max_seconds: float = DEFAULT_ANALYSIS_SECONDS) -> tuple[list, int]:
    """(mono_samples, sample_rate) for the first `max_seconds` of `path`, downmixed to
    mono and normalized to [-1, 1]. Supports PCM 8/16/24/32-bit and IEEE-float 32/64-bit
    (including the WAVE_FORMAT_EXTENSIBLE wrapper some DAWs export), by hand-parsing the
    RIFF chunk list rather than relying on the stdlib `wave` module, which raises on
    float-format data (`unknown format: 3`) — real files in this repo's own kit sources
    are float32."""
    data = Path(path).read_bytes()
    if len(data) < 12 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise WavReadError(f"not a RIFF/WAVE file: {path}")

    fmt_chunk: Optional[bytes] = None
    data_chunk: Optional[bytes] = None
    pos = 12
    n = len(data)
    while pos + 8 <= n:
        chunk_id = data[pos:pos + 4]
        chunk_size = struct.unpack_from("<I", data, pos + 4)[0]
        body_start = pos + 8
        body_end = min(n, body_start + chunk_size)
        if chunk_id == b"fmt ":
            fmt_chunk = data[body_start:body_end]
        elif chunk_id == b"data":
            data_chunk = data[body_start:body_end]
        pos = body_end + (chunk_size & 1)  # chunks are word-aligned (odd sizes padded)
        if fmt_chunk is not None and data_chunk is not None:
            break

    if fmt_chunk is None or data_chunk is None:
        raise WavReadError(f"missing fmt/data chunk: {path}")
    if len(fmt_chunk) < 16:
        raise WavReadError(f"truncated fmt chunk: {path}")

    audio_format, num_channels, sample_rate, _byte_rate, _block_align, bits_per_sample = (
        struct.unpack_from("<HHIIHH", fmt_chunk, 0)
    )
    if audio_format == 0xFFFE and len(fmt_chunk) >= 26:  # WAVE_FORMAT_EXTENSIBLE
        # the real codec lives as a GUID's first 2 bytes, right after the 22-byte
        # cbSize+validBits+channelMask extension header.
        audio_format = struct.unpack_from("<H", fmt_chunk, 24)[0]

    if num_channels <= 0 or bits_per_sample <= 0:
        raise WavReadError(f"invalid fmt chunk (channels={num_channels}, bits={bits_per_sample}): {path}")

    bytes_per_sample = bits_per_sample // 8
    frame_bytes = bytes_per_sample * num_channels
    if frame_bytes <= 0:
        raise WavReadError(f"unusable frame size: {path}")

    needed_frames = max(1, int(max_seconds * sample_rate)) if max_seconds and max_seconds > 0 else None
    if needed_frames is not None:
        needed_bytes = needed_frames * frame_bytes
        if needed_bytes < len(data_chunk):
            data_chunk = data_chunk[:needed_bytes]
    usable_len = len(data_chunk) - (len(data_chunk) % frame_bytes)
    data_chunk = data_chunk[:usable_len]
    total_samples = usable_len // bytes_per_sample

    if audio_format == 1:  # PCM integer
        if bits_per_sample == 8:
            values = [(b - 128) / 128.0 for b in data_chunk]
        elif bits_per_sample == 16:
            values = [v / 32768.0 for v in struct.unpack(f"<{total_samples}h", data_chunk)]
        elif bits_per_sample == 24:
            values = []
            for i in range(0, len(data_chunk), 3):
                b0, b1, b2 = data_chunk[i], data_chunk[i + 1], data_chunk[i + 2]
                v = b0 | (b1 << 8) | (b2 << 16)
                if v & 0x800000:
                    v -= 0x1000000
                values.append(v / 8388608.0)
        elif bits_per_sample == 32:
            values = [v / 2147483648.0 for v in struct.unpack(f"<{total_samples}i", data_chunk)]
        else:
            raise WavReadError(f"unsupported PCM bit depth {bits_per_sample}: {path}")
    elif audio_format == 3:  # IEEE float
        if bits_per_sample == 32:
            values = list(struct.unpack(f"<{total_samples}f", data_chunk))
        elif bits_per_sample == 64:
            values = list(struct.unpack(f"<{total_samples}d", data_chunk))
        else:
            raise WavReadError(f"unsupported float bit depth {bits_per_sample}: {path}")
    else:
        raise WavReadError(f"unsupported WAV audio format code {audio_format}: {path}")

    if num_channels > 1:
        mono = []
        for i in range(0, len(values) - (len(values) % num_channels), num_channels):
            frame = values[i:i + num_channels]
            mono.append(sum(frame) / num_channels)
        values = mono

    return values, sample_rate


# ── band-power ratio (numpy FFT, or stdlib Goertzel fallback) ──


def _hann_window(count: int) -> list:
    if count <= 1:
        return [1.0] * count
    return [0.5 - 0.5 * math.cos(2.0 * math.pi * i / (count - 1)) for i in range(count)]


def _band_ratio_numpy(segment: list, sr: int, band: tuple, np_mod) -> float:
    x = np_mod.asarray(segment, dtype=np_mod.float64)
    count = x.shape[0]
    if count < 2:
        return 0.0
    windowed = x * np_mod.hanning(count)
    spectrum = np_mod.fft.rfft(windowed)
    power = spectrum.real ** 2 + spectrum.imag ** 2
    freqs = np_mod.fft.rfftfreq(count, d=1.0 / sr)
    total_power = float(power.sum())
    if total_power <= 0.0:
        return 0.0
    band_mask = (freqs >= band[0]) & (freqs < band[1])
    band_power = float(power[band_mask].sum())
    return max(0.0, min(1.0, band_power / total_power))


def _goertzel_power(windowed: list, freq: float, sr: int, count: int) -> float:
    """|X[k]|^2 at the DFT bin nearest `freq` for a length-`count` window, via the
    standard single-frequency Goertzel recurrence (no full-spectrum FFT needed)."""
    k = int(round((count * freq) / sr))
    omega = 2.0 * math.pi * k / count
    coeff = 2.0 * math.cos(omega)
    q1 = q2 = 0.0
    for sample in windowed:
        q0 = coeff * q1 - q2 + sample
        q2 = q1
        q1 = q0
    return q1 * q1 + q2 * q2 - q1 * q2 * coeff


def _band_ratio_stdlib(segment: list, sr: int, band: tuple, max_n: int = GOERTZEL_MAX_N) -> float:
    count = min(len(segment), max_n) if max_n else len(segment)
    if count < 2:
        return 0.0
    windowed = [s * w for s, w in zip(segment[:count], _hann_window(count))]
    total_power = sum(v * v for v in windowed)  # time-domain energy of the windowed frame
    if total_power <= 0.0:
        return 0.0
    df = sr / count
    k_lo = max(1, math.ceil(band[0] / df))
    k_hi = min(count // 2, math.floor((band[1] - 1e-9) / df))
    if k_hi < k_lo:
        return 0.0
    band_power = 0.0
    for k in range(k_lo, k_hi + 1):
        band_power += _goertzel_power(windowed, k * df, sr, count)
    # Parseval: sum over ALL N DFT bins of |X[k]|^2 == N * (time-domain energy). Our band
    # only covers positive-frequency bins, whose mirror image (negative frequencies)
    # contributes an equal amount for a real signal, hence the factor of 2.
    band_energy_equiv = (2.0 / count) * band_power
    return max(0.0, min(1.0, band_energy_equiv / total_power))


def measure_band_energy(
    path,
    band: tuple = SUB_BAND,
    analysis_seconds: float = DEFAULT_ANALYSIS_SECONDS,
    force_backend: Optional[str] = None,
) -> dict:
    """{"sub_energy_db": float, "rms_db": float, "method": str} for one WAV file.
    `force_backend` ("numpy" | "stdlib") bypasses auto-detection — used by the test
    suite to exercise both paths deterministically regardless of what is actually
    installed on the machine running them."""
    samples, sr = read_wav_mono(path, max_seconds=analysis_seconds)
    if not samples:
        return {"sub_energy_db": _db(0.0), "rms_db": _db(0.0), "method": "empty"}

    overall_rms = _rms(samples)

    np_mod = None
    if force_backend == "numpy":
        np_mod = _try_import_numpy()
        if np_mod is None:
            raise RuntimeError("measure_sub: force_backend='numpy' but numpy is not importable")
    elif force_backend == "stdlib":
        np_mod = None
    else:
        np_mod = _try_import_numpy()

    if np_mod is not None:
        ratio = _band_ratio_numpy(samples, sr, band, np_mod)
        method = "numpy-fft"
    else:
        ratio = _band_ratio_stdlib(samples, sr, band)
        method = "stdlib-goertzel"

    band_rms = overall_rms * math.sqrt(ratio)
    return {
        "sub_energy_db": round(_db(band_rms), 2),
        "rms_db": round(_db(overall_rms), 2),
        "method": method,
    }


# ── manifest CLI ──


def _detect_json_style(text: str) -> tuple[Optional[int], bool]:
    """Best-effort (indent, trailing_newline) sniff of an existing manifest so a rewrite
    preserves its exact formatting for every byte this tool doesn't touch. The two real
    manifests this ships against were written by two different generators with two
    different indent widths (1 and 2) and neither has a trailing newline — hardcoding
    either would churn the other's diff on every run."""
    trailing_newline = text.endswith("\n")
    indent = None
    for line in text.splitlines()[1:]:
        stripped = line.lstrip(" ")
        if stripped != line:
            indent = len(line) - len(stripped)
            break
        if stripped:  # a non-blank, non-indented line: this manifest isn't indented at all
            break
    return indent, trailing_newline


def _write_manifest_preserving_style(path: Path, doc, original_text: str) -> None:
    indent, trailing_newline = _detect_json_style(original_text)
    text = json.dumps(doc, indent=indent if indent is not None else 2)
    if trailing_newline and not text.endswith("\n"):
        text += "\n"
    path.write_text(text, encoding="utf-8")


def _load_items(doc):
    return doc["items"] if isinstance(doc, dict) and "items" in doc else doc


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("manifest", help="palette/lab-manifest JSON path")
    p.add_argument("--write", action="store_true", help="add sub_energy_db/rms_db to bass/808 items in place")
    p.add_argument("--roles", default="bass,808", help="comma-separated role_guess values to measure (default bass,808)")
    args = p.parse_args(argv)

    manifest_path = Path(args.manifest)
    if not manifest_path.is_file():
        print(f"measure_sub: manifest not found: {manifest_path}", file=sys.stderr)
        return 1

    original_text = manifest_path.read_text(encoding="utf-8")
    doc = json.loads(original_text)
    items = _load_items(doc)
    target_roles = {r.strip().lower() for r in args.roles.split(",") if r.strip()}

    rows: list[tuple[dict, dict]] = []
    for item in items:
        role = str(item.get("role_guess") or "").strip().lower()
        if role not in target_roles:
            continue
        path = item.get("path")
        if not path or not Path(path).is_file():
            print(f"measure_sub: skip (missing file): {path}", file=sys.stderr)
            continue
        try:
            result = measure_band_energy(path)
        except Exception as e:  # a bad/corrupt file must not abort the whole run
            print(f"measure_sub: skip (unreadable, {e}): {path}", file=sys.stderr)
            continue
        rows.append((item, result))

    ranked = sorted(rows, key=lambda pair: pair[1]["sub_energy_db"], reverse=True)
    print(f"measure_sub: {len(ranked)} item(s), band {SUB_BAND[0]:.0f}-{SUB_BAND[1]:.0f} Hz")
    print(f"  {'sub_energy_db':>13}  {'rms_db':>8}  {'method':<16}  role  path")
    for item, result in ranked:
        print(
            f"  {result['sub_energy_db']:>13.2f}  {result['rms_db']:>8.2f}  "
            f"{result['method']:<16}  {item.get('role_guess', ''):<5} {item.get('path', '')}"
        )

    if args.write:
        for item, result in rows:
            item["sub_energy_db"] = result["sub_energy_db"]
            item["rms_db"] = result["rms_db"]
        _write_manifest_preserving_style(manifest_path, doc, original_text)
        print(f"measure_sub: wrote {len(rows)} updated item(s) -> {manifest_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
