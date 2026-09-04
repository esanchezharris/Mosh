#!/usr/bin/env python3
"""Tests for measure_sub.py (R2.6). Hermetic and network-free: every WAV is synthesized
into a tempdir with the stdlib `wave`/`struct` modules (never touches the owner's real
~/Library/Mosh palette or lab manifests), so this proves the MEASUREMENT LOGIC (WAV
parsing incl. float format, band-ratio math, dBFS conversion, CLI table/--write
behaviour, byte-preserving rewrite) rather than depending on what's actually on disk.

Runs BOTH the numpy and stdlib(Goertzel) backends explicitly via `force_backend`, so the
suite exercises the fallback path even on a machine (like this repo's gate: pyenv 3.12)
where numpy may or may not be importable — never let numpy's mere presence hide a
stdlib-path regression.

Runnable directly: `python3 measure_sub_test.py` (repo convention — the gate's py_tests
auto-discovers service/**/*_test.py).
"""

from __future__ import annotations

import json
import math
import struct
import sys
import tempfile
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import measure_sub as ms  # noqa: E402

FAILURES = []


def check(cond, label):
    if cond:
        print(f"  ok  {label}")
    else:
        print(f"  FAIL {label}")
        FAILURES.append(label)


def _write_sine_wav_pcm16(path: Path, freq: float, sr: int = 44100, seconds: float = 2.0, amp: float = 0.5, channels: int = 1):
    n = int(sr * seconds)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = bytearray()
        for i in range(n):
            v = amp * math.sin(2.0 * math.pi * freq * i / sr)
            sample = struct.pack("<h", int(max(-1.0, min(1.0, v)) * 32767))
            frames += sample * channels
        w.writeframes(bytes(frames))


def _write_sine_wav_float32(path: Path, freq: float, sr: int = 44100, seconds: float = 1.0, amp: float = 0.5, channels: int = 2):
    """Hand-rolled IEEE-float WAV (format code 3) — the stdlib `wave` module cannot
    WRITE this format either, so this exercises the exact "real kit file" shape
    (`unknown format: 3`) that motivated measure_sub's own struct-based parser."""
    n = int(sr * seconds)
    data = bytearray()
    for i in range(n):
        v = amp * math.sin(2.0 * math.pi * freq * i / sr)
        data += struct.pack("<f", v) * channels
    block_align = 4 * channels
    byte_rate = sr * block_align
    fmt_chunk = struct.pack("<HHIIHH", 3, channels, sr, byte_rate, block_align, 32)
    riff_size = 4 + (8 + len(fmt_chunk)) + (8 + len(data))
    with open(path, "wb") as f:
        f.write(b"RIFF")
        f.write(struct.pack("<I", riff_size))
        f.write(b"WAVE")
        f.write(b"fmt ")
        f.write(struct.pack("<I", len(fmt_chunk)))
        f.write(fmt_chunk)
        f.write(b"data")
        f.write(struct.pack("<I", len(data)))
        f.write(data)


def test_wav_parsing_pcm16_and_float32():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        pcm_path = root / "pcm16_stereo.wav"
        float_path = root / "float32_stereo.wav"
        _write_sine_wav_pcm16(pcm_path, 100.0, channels=2)
        _write_sine_wav_float32(float_path, 100.0, channels=2)

        pcm_samples, pcm_sr = ms.read_wav_mono(pcm_path)
        check(pcm_sr == 44100, "PCM16 sample rate parsed correctly")
        check(len(pcm_samples) > 0, "PCM16 downmix produced samples")
        check(all(-1.0 <= v <= 1.0 for v in pcm_samples[:1000]), "PCM16 samples normalized to [-1, 1]")

        float_samples, float_sr = ms.read_wav_mono(float_path)
        check(float_sr == 44100, "float32 (format code 3) sample rate parsed correctly")
        check(len(float_samples) > 0, "float32 downmix produced samples (stdlib `wave` cannot even open this file)")


def test_band_energy_sine_high_vs_low():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        sub_path = root / "sine40.wav"
        hi_path = root / "sine2000.wav"
        _write_sine_wav_pcm16(sub_path, 40.0)   # inside the 30-120 Hz band
        _write_sine_wav_pcm16(hi_path, 2000.0)  # well outside it

        for backend in ("numpy", "stdlib"):
            try:
                sub_result = ms.measure_band_energy(sub_path, force_backend=backend)
            except RuntimeError:
                check(True, f"[{backend}] skipped (numpy not importable on this machine)")
                continue
            hi_result = ms.measure_band_energy(hi_path, force_backend=backend)
            check(sub_result["method"].startswith(backend), f"[{backend}] measure_band_energy used the requested backend")
            check(
                sub_result["sub_energy_db"] > sub_result["rms_db"] - 1.0,
                f"[{backend}] a 40 Hz sine's sub_energy_db sits near its own overall rms_db ({sub_result})",
            )
            check(
                hi_result["sub_energy_db"] < hi_result["rms_db"] - 40.0,
                f"[{backend}] a 2 kHz sine's sub_energy_db is far below its overall rms_db ({hi_result})",
            )
            check(
                sub_result["sub_energy_db"] > hi_result["sub_energy_db"] + 40.0,
                f"[{backend}] the in-band sine ranks far above the out-of-band sine",
            )


def test_stdlib_fallback_forced_even_when_numpy_present():
    # Explicitly exercises the Goertzel path regardless of what's installed, so a
    # numpy-equipped dev machine still proves the fallback (per the task's own
    # instruction: "tests must skip the numpy path cleanly and still exercise the
    # stdlib fallback").
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        path = root / "sine50.wav"
        _write_sine_wav_pcm16(path, 50.0)
        result = ms.measure_band_energy(path, force_backend="stdlib")
        check(result["method"] == "stdlib-goertzel", "force_backend='stdlib' always uses the Goertzel path")
        check(result["sub_energy_db"] > result["rms_db"] - 2.0, "stdlib path still finds the in-band energy")


def _build_manifest(root: Path) -> tuple[Path, dict]:
    _write_sine_wav_pcm16(root / "bass_low.wav", 45.0)
    _write_sine_wav_pcm16(root / "bass_high.wav", 45.0, amp=0.1)  # quieter -> lower sub_energy_db
    _write_sine_wav_pcm16(root / "hat.wav", 8000.0)
    doc = {
        "count": 3,
        "items": [
            {"content_hash": "aaa", "kind": "oneshot", "path": str(root / "bass_low.wav"), "role_guess": "bass", "root_note": 24},
            {"content_hash": "bbb", "kind": "oneshot", "path": str(root / "bass_high.wav"), "role_guess": "808"},
            {"content_hash": "ccc", "kind": "oneshot", "path": str(root / "hat.wav"), "role_guess": "hat"},
        ],
        "version": 1,
    }
    manifest_path = root / "manifest.json"
    manifest_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    return manifest_path, doc


def test_cli_write_adds_fields_and_preserves_others():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        manifest_path, original_doc = _build_manifest(root)
        original_text = manifest_path.read_text(encoding="utf-8")

        rc = ms.main([str(manifest_path), "--write"])
        check(rc == 0, "CLI --write exits 0")

        written = json.loads(manifest_path.read_text(encoding="utf-8"))
        by_hash = {row["content_hash"]: row for row in written["items"]}

        check("sub_energy_db" in by_hash["aaa"] and "rms_db" in by_hash["aaa"], "bass item gained sub_energy_db + rms_db")
        check("sub_energy_db" in by_hash["bbb"] and "rms_db" in by_hash["bbb"], "808-role item gained sub_energy_db + rms_db")
        check("sub_energy_db" not in by_hash["ccc"], "non-bass/808 item (hat) was left untouched")
        check(by_hash["ccc"] == original_doc["items"][2], "hat item is byte-for-byte identical to the source")
        check(by_hash["aaa"]["root_note"] == 24, "pre-existing field on a touched item survives the write")
        check(written["version"] == 1 and written["count"] == 3, "untouched top-level fields survive the write")

        check(
            by_hash["aaa"]["sub_energy_db"] > by_hash["bbb"]["sub_energy_db"],
            "the louder 808 (same pitch, higher amplitude) ranks above the quieter one",
        )


def test_write_is_idempotent():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        manifest_path, _ = _build_manifest(root)

        ms.main([str(manifest_path), "--write"])
        first_text = manifest_path.read_text(encoding="utf-8")
        ms.main([str(manifest_path), "--write"])
        second_text = manifest_path.read_text(encoding="utf-8")

        check(first_text == second_text, "running --write twice produces byte-identical output the second time")


def test_style_preservation_matches_source_indent_and_newline():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        # A manifest written with indent=1 and NO trailing newline (mirrors the older,
        # unrelated tool that produced this repo's real lab-manifest file) must round-trip
        # its own style, not measure_sub's own default.
        _write_sine_wav_pcm16(root / "bass.wav", 45.0)
        doc = {"items": [{"content_hash": "x", "path": str(root / "bass.wav"), "role_guess": "bass"}]}
        manifest_path = root / "manifest.json"
        manifest_path.write_text(json.dumps(doc, indent=1), encoding="utf-8")
        check(not manifest_path.read_text(encoding="utf-8").endswith("\n"), "fixture manifest has no trailing newline (sanity)")

        ms.main([str(manifest_path), "--write"])
        rewritten = manifest_path.read_text(encoding="utf-8")
        check(not rewritten.endswith("\n"), "rewrite preserves the source's no-trailing-newline convention")
        second_line = rewritten.splitlines()[1]
        leading_spaces = len(second_line) - len(second_line.lstrip(" "))
        check(leading_spaces == 1, f"rewrite preserves the source's indent width (got {leading_spaces} spaces)")


def test_missing_and_unreadable_files_are_skipped_not_fatal():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        _write_sine_wav_pcm16(root / "ok.wav", 45.0)
        (root / "not_a_wav.wav").write_bytes(b"not a real wav file at all")
        doc = {
            "items": [
                {"content_hash": "ok", "path": str(root / "ok.wav"), "role_guess": "bass"},
                {"content_hash": "gone", "path": str(root / "missing.wav"), "role_guess": "bass"},
                {"content_hash": "bad", "path": str(root / "not_a_wav.wav"), "role_guess": "bass"},
            ]
        }
        manifest_path = root / "manifest.json"
        manifest_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")

        rc = ms.main([str(manifest_path), "--write"])
        check(rc == 0, "CLI still exits 0 when some items are missing/unreadable")
        written = json.loads(manifest_path.read_text(encoding="utf-8"))
        by_hash = {row["content_hash"]: row for row in written["items"]}
        check("sub_energy_db" in by_hash["ok"], "the readable item was still measured")
        check("sub_energy_db" not in by_hash["gone"], "a missing-file item was skipped, not crashed on")
        check("sub_energy_db" not in by_hash["bad"], "a garbage-bytes item was skipped, not crashed on")


def main() -> int:
    test_wav_parsing_pcm16_and_float32()
    test_band_energy_sine_high_vs_low()
    test_stdlib_fallback_forced_even_when_numpy_present()
    test_cli_write_adds_fields_and_preserves_others()
    test_write_is_idempotent()
    test_style_preservation_matches_source_indent_and_newline()
    test_missing_and_unreadable_files_are_skipped_not_fatal()

    print()
    if FAILURES:
        print(f"✗ measure_sub_test: {len(FAILURES)} failure(s)")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("✓ measure_sub_test: all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
