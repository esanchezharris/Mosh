#!/usr/bin/env python3
"""retrim_onsets.py — R3.2 (produce lane, quality-pivot 2026-09): cut every palette-v2
one-shot down to its measured onset, so the "off the grid" feel the owner heard in round
2 (see docs/produce-corrections/produce-r2-2026-09-02.meta.json — "drums sound out of
time/ off the grid?") goes away. Measured this session: every palette-v2 one-shot carries
several ms of pre-roll before its transient (a layer clap read 23 ms, an fx read 25 ms) —
the trimmer that shipped them kept headroom the owner's own kit samples don't have.

Method: onset = the first sample whose |amplitude| exceeds 0.0316x (~ -30 dBFS relative)
the file's own peak amplitude — the same -30 dB-rel-peak measurement this session used to
characterize the problem. The file is cut to start `--pre-ms` (default 0.5 ms) before that
sample, and a `--fade-ms` (default 5 ms) linear fade-in is applied from the new start so
the harder cut doesn't introduce a click. A file whose onset already reads <= 1 ms is left
alone (already effectively at 0 ms — cutting it further would just be re-tightening an
already-good trim, which docs/PALETTE-GENERATION-METHOD.md's curation lesson #5 says never
to do: "once the ear approves a cut, it is final" — the analogous machine rule here is
"once a trim reads at the floor, leave it").

WHY hand-rolled WAV I/O, not soundfile/librosa: same landmine as
service/presets/measure_sub.py (see that module's docstring and
docs/PALETTE-GENERATION-METHOD.md's "Known repo landmine") — `service/coverage.py`
shadows the PyPI `coverage` package whenever the `service/` directory itself lands on
sys.path, which breaks numba/librosa. This module needs none of that: onset detection and
the fade-in are both plain amplitude arithmetic, so it stays stdlib-only (struct +
hashlib), runs under bare system python3, and every palette-v2 wav (PCM 16-bit stereo,
some 44.1k some 48k) round-trips through it losslessly outside the faded region.

Safety: this tool NEVER touches a path under the owner's ~/Downloads (that's his raw kit,
read-only source material for the lab manifest, never a rewrite target) — any manifest
item whose path resolves there is skipped with a loud warning instead of silently
processed. The very first rewrite of a given file keeps the original bytes beside it as
`<name>.orig.wav`; a second run over an already-retrimmed palette must never clobber that
backup with the already-trimmed version (it doesn't need to: an already-trimmed file's
onset reads <= 1 ms and is refused as a no-op before any write is considered).

CLI: `retrim_onsets.py <palette-dir> [--dry-run] [--pre-ms 0.5] [--fade-ms 5]`
`<palette-dir>` must contain a `manifest.json` in the palette/lab-manifest shape
(`{"items": [{"path": ..., ...}, ...]}`). Prints a per-file onset table (old ms -> new ms)
and, unless --dry-run, rewrites each qualifying wav in place, writes its `.orig.wav`
backup (first time only), and updates that item's `content_hash` in the manifest (16-hex
sha256 prefix of the new file's raw bytes — matches the convention already in the real
palette-v2/lab manifests, see scripts/lab/make-lab-manifest.py's `content_hash_of`).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path
from typing import Optional

ONSET_REL_THRESHOLD = 0.0316  # ~ -30 dBFS relative to the file's own peak
NOOP_ONSET_MS = 1.0  # a file whose measured onset is already <= this is left alone
DEFAULT_PRE_MS = 0.5
DEFAULT_FADE_MS = 5.0


class WavReadError(ValueError):
    pass


# ── RIFF/WAVE parsing (full file, no time truncation — see module docstring) ──


def _parse_riff(data: bytes, path) -> tuple[bytes, bytes]:
    """(fmt_chunk_bytes, data_chunk_bytes) — the FULL data chunk, unlike
    measure_sub.read_wav_mono which truncates to an analysis window."""
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
        pos = body_end + (chunk_size & 1)  # chunks are word-aligned
        if fmt_chunk is not None and data_chunk is not None:
            break
    if fmt_chunk is None or data_chunk is None:
        raise WavReadError(f"missing fmt/data chunk: {path}")
    if len(fmt_chunk) < 16:
        raise WavReadError(f"truncated fmt chunk: {path}")
    return fmt_chunk, data_chunk


class WavFile:
    __slots__ = ("fmt_chunk", "data", "audio_format", "num_channels", "sample_rate",
                 "bits_per_sample", "bytes_per_sample", "frame_bytes", "total_frames")

    def __init__(self, fmt_chunk: bytes, data: bytes):
        audio_format, num_channels, sample_rate, _byte_rate, _block_align, bits_per_sample = (
            struct.unpack_from("<HHIIHH", fmt_chunk, 0)
        )
        if audio_format == 0xFFFE and len(fmt_chunk) >= 26:  # WAVE_FORMAT_EXTENSIBLE
            audio_format = struct.unpack_from("<H", fmt_chunk, 24)[0]
        if num_channels <= 0 or bits_per_sample <= 0:
            raise WavReadError(f"invalid fmt chunk (channels={num_channels}, bits={bits_per_sample})")
        if audio_format not in (1, 3):
            raise WavReadError(f"unsupported WAV audio format code {audio_format}")
        bytes_per_sample = bits_per_sample // 8
        if bytes_per_sample not in (1, 2, 3, 4, 8) or (audio_format == 3 and bytes_per_sample not in (4, 8)):
            raise WavReadError(f"unsupported bit depth {bits_per_sample} for format {audio_format}")
        frame_bytes = bytes_per_sample * num_channels
        if frame_bytes <= 0:
            raise WavReadError("unusable frame size")
        usable_len = len(data) - (len(data) % frame_bytes)
        self.fmt_chunk = fmt_chunk
        self.data = data[:usable_len]
        self.audio_format = audio_format
        self.num_channels = num_channels
        self.sample_rate = sample_rate
        self.bits_per_sample = bits_per_sample
        self.bytes_per_sample = bytes_per_sample
        self.frame_bytes = frame_bytes
        self.total_frames = usable_len // frame_bytes


def read_wav(path) -> WavFile:
    raw = Path(path).read_bytes()
    fmt_chunk, data_chunk = _parse_riff(raw, path)
    return WavFile(fmt_chunk, data_chunk)


# ── sample <-> float conversion, per format/bit-depth ──


def _decode_floats(buf: bytes, audio_format: int, bytes_per_sample: int) -> list[float]:
    """Flat list of per-sample floats normalized to [-1, 1] (interleaved channels)."""
    count = len(buf) // bytes_per_sample
    if count == 0:
        return []
    if audio_format == 1:  # PCM integer
        if bytes_per_sample == 1:
            return [(b - 128) / 128.0 for b in buf]
        if bytes_per_sample == 2:
            return [v / 32768.0 for v in struct.unpack(f"<{count}h", buf)]
        if bytes_per_sample == 3:
            out = []
            for i in range(0, len(buf), 3):
                b0, b1, b2 = buf[i], buf[i + 1], buf[i + 2]
                v = b0 | (b1 << 8) | (b2 << 16)
                if v & 0x800000:
                    v -= 0x1000000
                out.append(v / 8388608.0)
            return out
        if bytes_per_sample == 4:
            return [v / 2147483648.0 for v in struct.unpack(f"<{count}i", buf)]
    elif audio_format == 3:  # IEEE float
        if bytes_per_sample == 4:
            return list(struct.unpack(f"<{count}f", buf))
        if bytes_per_sample == 8:
            return list(struct.unpack(f"<{count}d", buf))
    raise WavReadError(f"unsupported format/bit-depth combo (format={audio_format}, bytes={bytes_per_sample})")


def _encode_floats(values, audio_format: int, bytes_per_sample: int) -> bytes:
    if audio_format == 1:
        if bytes_per_sample == 1:
            return bytes(max(0, min(255, int(round(v * 128.0)) + 128)) for v in values)
        if bytes_per_sample == 2:
            clamped = [max(-32768, min(32767, int(round(v * 32768.0)))) for v in values]
            return struct.pack(f"<{len(clamped)}h", *clamped)
        if bytes_per_sample == 3:
            out = bytearray()
            for v in values:
                iv = max(-8388608, min(8388607, int(round(v * 8388608.0))))
                if iv < 0:
                    iv += 0x1000000
                out += bytes((iv & 0xFF, (iv >> 8) & 0xFF, (iv >> 16) & 0xFF))
            return bytes(out)
        if bytes_per_sample == 4:
            clamped = [max(-2147483648, min(2147483647, int(round(v * 2147483648.0)))) for v in values]
            return struct.pack(f"<{len(clamped)}i", *clamped)
    elif audio_format == 3:
        if bytes_per_sample == 4:
            return struct.pack(f"<{len(values)}f", *values)
        if bytes_per_sample == 8:
            return struct.pack(f"<{len(values)}d", *values)
    raise WavReadError(f"unsupported format/bit-depth combo (format={audio_format}, bytes={bytes_per_sample})")


# ── onset detection ──


def frame_envelope(wav: WavFile) -> list[float]:
    """Per-frame envelope: max(|sample|) across channels, one entry per frame."""
    flat = _decode_floats(wav.data, wav.audio_format, wav.bytes_per_sample)
    nc = wav.num_channels
    env = []
    for i in range(0, len(flat) - (len(flat) % nc), nc):
        env.append(max(abs(v) for v in flat[i:i + nc]))
    return env


def find_onset_frame(env: list[float], rel_threshold: float = ONSET_REL_THRESHOLD) -> Optional[int]:
    if not env:
        return None
    peak = max(env)
    if peak <= 1e-9:
        return None  # silent file — nothing to trim toward
    threshold = rel_threshold * peak
    for i, v in enumerate(env):
        if v > threshold:
            return i
    return None


def measure_onset_ms(wav: WavFile) -> Optional[float]:
    onset_frame = find_onset_frame(frame_envelope(wav))
    if onset_frame is None:
        return None
    return onset_frame * 1000.0 / wav.sample_rate


# ── retrim ──


def retrim(wav: WavFile, pre_ms: float, fade_ms: float) -> Optional[bytes]:
    """New `data` chunk bytes, cut + faded, or None if the file's onset is already
    <= NOOP_ONSET_MS (caller must treat that as a refused no-op)."""
    env = frame_envelope(wav)
    onset_frame = find_onset_frame(env)
    if onset_frame is None:
        return None  # unmeasurable/silent — never touch
    onset_ms = onset_frame * 1000.0 / wav.sample_rate
    if onset_ms <= NOOP_ONSET_MS:
        return None

    pre_frames = int(round(pre_ms / 1000.0 * wav.sample_rate))
    cut_frame = max(0, onset_frame - pre_frames)
    new_data = bytearray(wav.data[cut_frame * wav.frame_bytes:])
    new_total_frames = wav.total_frames - cut_frame

    # The fade must never reach past the true onset frame: fading the transient itself
    # (rather than just the quiet pre-roll ahead of it) would attenuate the very sample
    # a fresh onset re-measurement looks for, pushing the measured onset back out past
    # the 1ms floor this whole pass exists to guarantee. Cap the fade at the distance
    # from the new start to the onset, so gain reaches 1.0 exactly AT the onset frame
    # and everything from there on (the transient, unchanged) is bit-identical to the
    # source — only the click risk from a hard cut into near-silence is addressed.
    onset_frame_in_new = onset_frame - cut_frame
    fade_frames = min(int(round(fade_ms / 1000.0 * wav.sample_rate)), new_total_frames, onset_frame_in_new)
    if fade_frames > 0:
        fade_bytes_len = fade_frames * wav.frame_bytes
        fade_region = bytes(new_data[:fade_bytes_len])
        flat = _decode_floats(fade_region, wav.audio_format, wav.bytes_per_sample)
        nc = wav.num_channels
        denom = float(fade_frames - 1) if fade_frames > 1 else 1.0
        out_flat = []
        for frame_idx in range(fade_frames):
            gain = frame_idx / denom if fade_frames > 1 else 1.0
            gain = max(0.0, min(1.0, gain))
            base = frame_idx * nc
            for c in range(nc):
                out_flat.append(flat[base + c] * gain)
        new_data[:fade_bytes_len] = _encode_floats(out_flat, wav.audio_format, wav.bytes_per_sample)

    return bytes(new_data)


def write_wav(path: Path, fmt_chunk: bytes, data_chunk: bytes) -> None:
    fmt_padded = fmt_chunk + (b"\x00" if len(fmt_chunk) & 1 else b"")
    data_padded = data_chunk + (b"\x00" if len(data_chunk) & 1 else b"")
    riff_size = 4 + (8 + len(fmt_padded)) + (8 + len(data_padded))
    out = bytearray()
    out += b"RIFF" + struct.pack("<I", riff_size) + b"WAVE"
    out += b"fmt " + struct.pack("<I", len(fmt_chunk)) + fmt_padded
    out += b"data" + struct.pack("<I", len(data_chunk)) + data_padded
    path.write_bytes(bytes(out))


def content_hash_of(path: Path) -> str:
    """16-hex sha256 prefix of the raw file bytes — matches
    scripts/lab/make-lab-manifest.py's `content_hash_of` / the real palette-v2 manifest."""
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


# ── manifest style-preserving rewrite (mirrors measure_sub.py) ──


def _detect_json_style(text: str) -> tuple[Optional[int], bool]:
    trailing_newline = text.endswith("\n")
    indent = None
    for line in text.splitlines()[1:]:
        stripped = line.lstrip(" ")
        if stripped != line:
            indent = len(line) - len(stripped)
            break
        if stripped:
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


def _is_under_downloads(path: Path) -> bool:
    downloads = Path.home() / "Downloads"
    try:
        path.resolve().relative_to(downloads.resolve())
        return True
    except ValueError:
        return False


# ── CLI ──


def process_manifest(manifest_path: Path, pre_ms: float, fade_ms: float, dry_run: bool):
    """Returns (rows, n_written) where each row is
    (path, old_onset_ms_or_None, new_onset_ms_or_None, status)."""
    original_text = manifest_path.read_text(encoding="utf-8")
    doc = json.loads(original_text)
    items = _load_items(doc)

    rows: list[tuple[str, Optional[float], Optional[float], str]] = []
    n_written = 0

    for item in items:
        raw_path = item.get("path")
        if not raw_path:
            continue
        path = Path(raw_path)
        if _is_under_downloads(path):
            rows.append((raw_path, None, None, "REFUSED (under ~/Downloads)"))
            continue
        if not path.is_file():
            rows.append((raw_path, None, None, "skip (missing file)"))
            continue

        try:
            wav = read_wav(path)
        except WavReadError as e:
            rows.append((raw_path, None, None, f"skip ({e})"))
            continue

        old_onset = measure_onset_ms(wav)
        if old_onset is None:
            rows.append((raw_path, None, None, "skip (silent/unmeasurable)"))
            continue

        if old_onset <= NOOP_ONSET_MS:
            rows.append((raw_path, round(old_onset, 3), round(old_onset, 3), "no-op (already trimmed)"))
            continue

        if dry_run:
            new_data = retrim(wav, pre_ms, fade_ms)
            new_wav = WavFile(wav.fmt_chunk, new_data)
            new_onset = measure_onset_ms(new_wav)
            rows.append((raw_path, round(old_onset, 3), None if new_onset is None else round(new_onset, 3),
                         "dry-run"))
            continue

        new_data = retrim(wav, pre_ms, fade_ms)
        if new_data is None:  # defensive — old_onset already gated this above
            rows.append((raw_path, round(old_onset, 3), round(old_onset, 3), "no-op (already trimmed)"))
            continue

        orig_backup = path.with_name(path.stem + ".orig.wav")
        if not orig_backup.exists():
            orig_backup.write_bytes(path.read_bytes())

        write_wav(path, wav.fmt_chunk, new_data)

        new_wav = read_wav(path)
        new_onset = measure_onset_ms(new_wav)
        new_hash = content_hash_of(path)
        item["content_hash"] = new_hash
        n_written += 1
        rows.append((raw_path, round(old_onset, 3), None if new_onset is None else round(new_onset, 3), "trimmed"))

    if n_written and not dry_run:
        _write_manifest_preserving_style(manifest_path, doc, original_text)

    return rows, n_written


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("palette_dir", help="directory containing manifest.json + <lane>/*.wav")
    p.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    p.add_argument("--pre-ms", type=float, default=DEFAULT_PRE_MS, help=f"ms kept before the detected onset (default {DEFAULT_PRE_MS})")
    p.add_argument("--fade-ms", type=float, default=DEFAULT_FADE_MS, help=f"linear fade-in length in ms (default {DEFAULT_FADE_MS})")
    args = p.parse_args(argv)

    palette_dir = Path(args.palette_dir)
    manifest_path = palette_dir / "manifest.json"
    if not manifest_path.is_file():
        print(f"retrim_onsets: manifest not found: {manifest_path}", file=sys.stderr)
        return 1

    rows, n_written = process_manifest(manifest_path, args.pre_ms, args.fade_ms, args.dry_run)

    print(f"retrim_onsets: {len(rows)} manifest item(s), pre_ms={args.pre_ms} fade_ms={args.fade_ms}"
          f"{' [DRY RUN]' if args.dry_run else ''}")
    print(f"  {'old_ms':>8}  {'new_ms':>8}  {'status':<26}  path")
    measured_old = []
    measured_new = []
    for path, old_ms, new_ms, status in rows:
        old_s = f"{old_ms:8.3f}" if old_ms is not None else " " * 8
        new_s = f"{new_ms:8.3f}" if new_ms is not None else " " * 8
        print(f"  {old_s}  {new_s}  {status:<26}  {path}")
        if old_ms is not None:
            measured_old.append(old_ms)
        if new_ms is not None:
            measured_new.append(new_ms)

    if measured_old:
        print(f"\n  old onset: min={min(measured_old):.3f}ms max={max(measured_old):.3f}ms")
    if measured_new:
        print(f"  new onset: min={min(measured_new):.3f}ms max={max(measured_new):.3f}ms")
    if not args.dry_run:
        print(f"  wrote {n_written} file(s)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
