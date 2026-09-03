#!/usr/bin/env python3
"""Tests for retrim_onsets.py — stdlib-only, runnable as `python3 retrim_onsets_test.py`
(repo gate convention: service/**/*_test.py). Builds tiny synthetic PCM16/PCM24/float32
WAVs by hand (no soundfile/numpy needed) so onset detection + the retrim/fade/backup/
manifest-update machinery is exercised deterministically regardless of what's installed.
"""
from __future__ import annotations

import importlib.util
import json
import math
import struct
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("retrim_onsets", HERE / "retrim_onsets.py")
retrim_onsets = importlib.util.module_from_spec(SPEC)
sys.modules["retrim_onsets"] = retrim_onsets
SPEC.loader.exec_module(retrim_onsets)

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = ""):
    if cond:
        print(f"  ok   {name}")
    else:
        FAILURES.append(name)
        print(f"  FAIL {name}  {detail}")


def _fmt_chunk(audio_format: int, num_channels: int, sample_rate: int, bits_per_sample: int) -> bytes:
    byte_rate = sample_rate * num_channels * (bits_per_sample // 8)
    block_align = num_channels * (bits_per_sample // 8)
    return struct.pack("<HHIIHH", audio_format, num_channels, sample_rate, byte_rate, block_align, bits_per_sample)


def make_wav_bytes(samples: list[float], sample_rate: int, num_channels: int = 1,
                    bits_per_sample: int = 16, audio_format: int = 1) -> bytes:
    """`samples` is a flat, already-interleaved list of floats in [-1, 1]."""
    bytes_per_sample = bits_per_sample // 8
    data = retrim_onsets._encode_floats(samples, audio_format, bytes_per_sample)
    fmt = _fmt_chunk(audio_format, num_channels, sample_rate, bits_per_sample)
    buf = bytearray()
    data_padded = data + (b"\x00" if len(data) & 1 else b"")
    riff_size = 4 + (8 + len(fmt)) + (8 + len(data_padded))
    buf += b"RIFF" + struct.pack("<I", riff_size) + b"WAVE"
    buf += b"fmt " + struct.pack("<I", len(fmt)) + fmt
    buf += b"data" + struct.pack("<I", len(data)) + data_padded
    return bytes(buf)


def synth_onset_signal(sr: int, silence_ms: float, hit_ms: float, tail_ms: float,
                        num_channels: int = 1) -> list[float]:
    """silence (near-zero noise floor) -> a loud decaying "hit" -> a quiet tail, mono
    pattern replicated across channels."""
    def n_frames(ms):
        return int(round(ms / 1000.0 * sr))

    mono: list[float] = []
    for i in range(n_frames(silence_ms)):
        mono.append(0.0005 * math.sin(i * 0.9))  # well under the -30dB-rel-peak threshold
    hit_n = n_frames(hit_ms)
    for i in range(hit_n):
        decay = math.exp(-3.0 * i / max(1, hit_n))
        mono.append(0.9 * decay)
    for i in range(n_frames(tail_ms)):
        mono.append(0.01 * math.sin(i * 0.3))
    flat: list[float] = []
    for v in mono:
        flat.extend([v] * num_channels)
    return flat


def write_manifest(tmp: Path, items: list[dict]) -> Path:
    doc = {"count": len(items), "items": items, "mean": [0.0], "std": [1.0], "sr": 44100,
           "version": "engineered-v1", "window_s": 1.0}
    p = tmp / "manifest.json"
    p.write_text(json.dumps(doc, indent=2))
    return p


def test_onset_detection_basic():
    sr = 44100
    samples = synth_onset_signal(sr, silence_ms=30.0, hit_ms=20.0, tail_ms=20.0)
    wav_bytes = make_wav_bytes(samples, sr)
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "hit.wav"
        p.write_bytes(wav_bytes)
        wav = retrim_onsets.read_wav(p)
        onset_ms = retrim_onsets.measure_onset_ms(wav)
        check("onset detected near 30ms silence boundary", onset_ms is not None and 25.0 <= onset_ms <= 31.0,
              f"onset_ms={onset_ms}")


def test_retrim_reduces_onset_to_floor():
    sr = 44100
    samples = synth_onset_signal(sr, silence_ms=30.0, hit_ms=20.0, tail_ms=20.0)
    wav_bytes = make_wav_bytes(samples, sr)
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        lane = tmp / "clap"
        lane.mkdir()
        wav_path = lane / "clap_00.wav"
        wav_path.write_bytes(wav_bytes)
        old_hash = retrim_onsets.content_hash_of(wav_path)
        manifest_path = write_manifest(tmp, [
            {"content_hash": old_hash, "kind": "oneshot", "path": str(wav_path), "role_guess": "clap"},
        ])

        rows, n_written = retrim_onsets.process_manifest(manifest_path, pre_ms=0.5, fade_ms=5.0, dry_run=False)
        check("one file written", n_written == 1, f"n_written={n_written}")
        row = rows[0]
        _, old_ms, new_ms, status = row
        check("status is trimmed", status == "trimmed", status)
        check("old onset matches pre-trim measurement", old_ms is not None and 25.0 <= old_ms <= 31.0, f"old_ms={old_ms}")
        check("new onset <= 1ms (reported)", new_ms is not None and new_ms <= 1.0, f"new_ms={new_ms}")

        # independently re-measure the rewritten file from disk
        new_wav = retrim_onsets.read_wav(wav_path)
        remeasured = retrim_onsets.measure_onset_ms(new_wav)
        check("re-measured onset <= 1ms", remeasured is not None and remeasured <= 1.0, f"remeasured={remeasured}")

        orig_backup = lane / "clap_00.orig.wav"
        check(".orig.wav backup exists", orig_backup.is_file())
        check(".orig.wav matches original bytes", orig_backup.read_bytes() == wav_bytes)

        manifest = json.loads(manifest_path.read_text())
        new_hash = manifest["items"][0]["content_hash"]
        check("manifest content_hash updated", new_hash != old_hash, f"{new_hash} vs {old_hash}")
        check("manifest content_hash matches file", new_hash == retrim_onsets.content_hash_of(wav_path))

        # idempotency: a second run must be a no-op and must not touch the backup
        backup_bytes_after_first = orig_backup.read_bytes()
        rows2, n_written2 = retrim_onsets.process_manifest(manifest_path, pre_ms=0.5, fade_ms=5.0, dry_run=False)
        check("second run writes nothing", n_written2 == 0, f"n_written2={n_written2}")
        check("second run reports no-op", rows2[0][3] == "no-op (already trimmed)", rows2[0][3])
        check("backup unchanged by second run", orig_backup.read_bytes() == backup_bytes_after_first)


def test_already_trimmed_is_noop():
    sr = 44100
    # onset immediately at frame 0 — already at the floor
    samples = synth_onset_signal(sr, silence_ms=0.0, hit_ms=20.0, tail_ms=10.0)
    wav_bytes = make_wav_bytes(samples, sr)
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        wav_path = tmp / "kick_00.wav"
        wav_path.write_bytes(wav_bytes)
        manifest_path = write_manifest(tmp, [
            {"content_hash": retrim_onsets.content_hash_of(wav_path), "kind": "oneshot",
             "path": str(wav_path), "role_guess": "kick"},
        ])
        rows, n_written = retrim_onsets.process_manifest(manifest_path, pre_ms=0.5, fade_ms=5.0, dry_run=False)
        check("no-op: nothing written", n_written == 0, f"n_written={n_written}")
        check("no .orig.wav created", not (tmp / "kick_00.orig.wav").exists())
        check("file bytes unchanged", wav_path.read_bytes() == wav_bytes)


def test_dry_run_writes_nothing():
    sr = 44100
    samples = synth_onset_signal(sr, silence_ms=30.0, hit_ms=15.0, tail_ms=10.0)
    wav_bytes = make_wav_bytes(samples, sr)
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        wav_path = tmp / "snare_00.wav"
        wav_path.write_bytes(wav_bytes)
        manifest_path = write_manifest(tmp, [
            {"content_hash": retrim_onsets.content_hash_of(wav_path), "kind": "oneshot",
             "path": str(wav_path), "role_guess": "snare"},
        ])
        original_manifest_text = manifest_path.read_text()
        rows, n_written = retrim_onsets.process_manifest(manifest_path, pre_ms=0.5, fade_ms=5.0, dry_run=True)
        check("dry-run writes nothing", n_written == 0, f"n_written={n_written}")
        check("dry-run file unchanged", wav_path.read_bytes() == wav_bytes)
        check("dry-run manifest unchanged on disk", manifest_path.read_text() == original_manifest_text)
        check("no .orig.wav created", not (tmp / "snare_00.orig.wav").exists())
        row = rows[0]
        check("dry-run still reports old/new onset", row[1] is not None and row[2] is not None, row)


def test_stereo_pcm24_and_float32_roundtrip():
    sr = 44100
    for bits, audio_format, label in ((24, 1, "pcm24"), (32, 3, "float32")):
        mono = synth_onset_signal(sr, silence_ms=20.0, hit_ms=15.0, tail_ms=10.0, num_channels=2)
        wav_bytes = make_wav_bytes(mono, sr, num_channels=2, bits_per_sample=bits, audio_format=audio_format)
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            wav_path = tmp / f"fx_{label}.wav"
            wav_path.write_bytes(wav_bytes)
            manifest_path = write_manifest(tmp, [
                {"content_hash": retrim_onsets.content_hash_of(wav_path), "kind": "oneshot",
                 "path": str(wav_path), "role_guess": "fx"},
            ])
            rows, n_written = retrim_onsets.process_manifest(manifest_path, pre_ms=0.5, fade_ms=5.0, dry_run=False)
            check(f"{label}: one file written", n_written == 1, f"n_written={n_written}")
            new_wav = retrim_onsets.read_wav(wav_path)
            check(f"{label}: format preserved", new_wav.audio_format == audio_format)
            check(f"{label}: bit depth preserved", new_wav.bits_per_sample == bits)
            check(f"{label}: channel count preserved", new_wav.num_channels == 2)
            check(f"{label}: sample rate preserved", new_wav.sample_rate == sr)
            remeasured = retrim_onsets.measure_onset_ms(new_wav)
            check(f"{label}: re-measured onset <= 1ms", remeasured is not None and remeasured <= 1.0, remeasured)


def test_downloads_path_is_refused():
    sr = 44100
    samples = synth_onset_signal(sr, silence_ms=30.0, hit_ms=15.0, tail_ms=10.0)
    wav_bytes = make_wav_bytes(samples, sr)
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        # simulate a manifest item pointing under the owner's real Downloads dir
        downloads = Path.home() / "Downloads"
        fake_target = downloads / "__retrim_onsets_test_should_never_touch__.wav"
        manifest_path = write_manifest(tmp, [
            {"content_hash": "deadbeefdeadbeef", "kind": "oneshot",
             "path": str(fake_target), "role_guess": "clap"},
        ])
        check("target does not exist before test", not fake_target.exists())
        rows, n_written = retrim_onsets.process_manifest(manifest_path, pre_ms=0.5, fade_ms=5.0, dry_run=False)
        check("Downloads item refused, nothing written", n_written == 0, f"n_written={n_written}")
        check("Downloads item status is REFUSED", "REFUSED" in rows[0][3], rows[0][3])
        check("target still does not exist after test", not fake_target.exists())


def main() -> int:
    tests = [
        test_onset_detection_basic,
        test_retrim_reduces_onset_to_floor,
        test_already_trimmed_is_noop,
        test_dry_run_writes_nothing,
        test_stereo_pcm24_and_float32_roundtrip,
        test_downloads_path_is_refused,
    ]
    for t in tests:
        print(f"{t.__name__}:")
        t()
    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): {FAILURES}")
        return 1
    print(f"OK ({len(tests)} test functions)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
