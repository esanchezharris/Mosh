"""Golden for service/training/style_lora.py — window, silence-skip, two bundles.

The trainer treats each registry source as ONE clip. This file exists so a
long-file corpus cannot silently become 1–3 clips: the slicer must emit 8s
windows, drop near-silence, and write captions the bundle reader actually
sees (title → caption in trainer_job._clips_from_bundle).

Hermetic: writes 44.1 kHz stereo s16 WAVs itself, so ffmpeg is not required.

Run:  python3 service/training/style_lora_test.py
"""
from __future__ import annotations

import json
import math
import os
import struct
import sys
import tempfile
import wave
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))  # service/ — import training.*

from training import style_lora as SL  # noqa: E402
from training.trainer_job import _clips_from_bundle  # noqa: E402

SR = 44100
CH = 2


def _tone(seconds: float, freq: float = 440.0, amp: float = 0.2) -> list[int]:
    n = int(round(seconds * SR))
    out: list[int] = []
    for i in range(n):
        v = int(amp * 32767.0 * math.sin(2.0 * math.pi * freq * i / SR))
        out.extend([v, v])
    return out


def _silence(seconds: float) -> list[int]:
    return [0] * (int(round(seconds * SR)) * CH)


def _write(path: Path, samples: list[int]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = struct.pack("<%dh" % len(samples), *samples)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(CH)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(body)
    return path


def test_rms_silence_and_tone():
    assert SL.rms_dbfs([0, 0, 0, 0]) <= -120.0
    tone = _tone(0.2)
    assert SL.rms_dbfs(tone) > -20.0


def test_slice_skips_silence_keeps_tone():
    tmp = Path(tempfile.mkdtemp(prefix="style-lora-slice-"))
    # 8s tone + 8s silence + 8s tone → 2 kept, 1 dropped
    wav = _write(tmp / "src.wav", _tone(8.0) + _silence(8.0) + _tone(8.0, freq=220.0))
    clips = SL.slice_wav(wav, tmp / "clips", prefix="x", window_s=8.0, silence_dbfs=-40.0)
    assert len(clips) == 2, f"expected 2 kept windows, got {len(clips)}"
    assert [c["index"] for c in clips] == [0, 2]
    assert all(Path(c["path"]).is_file() for c in clips)
    assert all(c["seconds"] == 8.0 for c in clips)


def test_slice_keeps_partial_tail_above_min():
    tmp = Path(tempfile.mkdtemp(prefix="style-lora-tail-"))
    wav = _write(tmp / "src.wav", _tone(10.0))  # 8s + 2s
    clips = SL.slice_wav(wav, tmp / "clips", prefix="t", window_s=8.0, min_s=2.0)
    assert len(clips) == 2, f"expected 8s + 2s, got {len(clips)} {[c['seconds'] for c in clips]}"
    assert abs(clips[0]["seconds"] - 8.0) < 1e-3
    assert abs(clips[1]["seconds"] - 2.0) < 1e-3


def test_slice_drops_tiny_tail():
    tmp = Path(tempfile.mkdtemp(prefix="style-lora-tiny-"))
    wav = _write(tmp / "src.wav", _tone(8.5))  # 8s + 0.5s < min 2s
    clips = SL.slice_wav(wav, tmp / "clips", prefix="t", window_s=8.0, min_s=2.0)
    assert len(clips) == 1, f"0.5s tail must drop, got {len(clips)}"
    assert abs(clips[0]["seconds"] - 8.0) < 1e-3


def test_resolve_source_fuzzy_whitespace():
    tmp = Path(tempfile.mkdtemp(prefix="style-lora-res-"))
    real = tmp / "Carolina Crown 2017  Inside the Circle  Semifinals.mp3"
    real.write_bytes(b"not-audio")
    found = SL.resolve_source(
        "Carolina Crown 2017 Inside the Circle Semifinals.mp3", [tmp])
    assert found == real, f"collapsed whitespace should still match, got {found}"


def test_prep_job_writes_bundle_clips_from_bundle_can_read():
    tmp = Path(tempfile.mkdtemp(prefix="style-lora-prep-"))
    src_dir = tmp / "sources"
    # 24s of tone → 3 clips. Caption must survive as the training prompt.
    job = {
        "id": "adagio",
        "label": "barber-adagio",
        "library_name": "barber-adagio",
        "trigger": "barber adagio",
        "hint": "strings",
        "creator": "Samuel Barber",
        "files": [{
            "name": "adagio.wav",
            "caption": "barber adagio, slow orchestral strings, rising swell, minor",
        }],
    }
    wav = _write(src_dir / "adagio.wav", _tone(24.0))
    assert wav.is_file()
    result = SL.prep_job(job, tmp / "work", [src_dir], window_s=8.0)
    assert result["clip_count"] == 3, f"24s / 8s should be 3 clips, got {result['clip_count']}"
    assert result["recipe"]["clipCount"] == 3
    assert result["recipe"]["steps"] > 0
    bundle = Path(result["bundle_path"])
    manifest = json.loads((bundle / "corpus.manifest.json").read_text(encoding="utf-8"))
    assert manifest["source_count"] == 3
    clips = _clips_from_bundle(bundle, manifest)
    assert len(clips) == 3
    assert all(Path(c["wav"]).is_file() for c in clips)
    assert all(c["caption"].startswith("barber adagio") for c in clips), clips
    # Approved personal-experiment claim is what the producer chose.
    for src in manifest["sources"]:
        assert src["approved_for_training"] is True
        assert src["user_claimed_license"] == SL.LICENSE
        assert src["proof_of_rights"] == SL.PROOF


def test_measure_reports_missing():
    report = SL.measure_sources([Path("/tmp/style-lora-empty-surely-missing")])
    assert report["ok"] is False
    assert len(report["missing"]) == 4


def test_train_job_refuses_fake_backend():
    try:
        SL.train_job(
            {"id": "adagio", "label": "x", "clip_count": 1, "bundle_path": "/nope",
             "recipe": {"steps": 1, "batchSize": 1, "gradAccum": 1, "estMinutes": 0}},
            Path("/tmp"),
        )
    except RuntimeError as exc:
        assert "refusing to train" in str(exc)
        return
    raise AssertionError("train_job must refuse the fake/stub backend")


def test_two_jobs_do_not_share_a_bundle():
    tmp = Path(tempfile.mkdtemp(prefix="style-lora-two-"))
    src = tmp / "src"
    _write(src / "a.wav", _tone(8.0))
    _write(src / "c.wav", _tone(16.0))
    adagio = {
        "id": "adagio", "label": "barber-adagio", "library_name": "barber-adagio",
        "trigger": "barber adagio", "hint": "", "creator": "Samuel Barber",
        "files": [{"name": "a.wav", "caption": "barber adagio, strings"}],
    }
    crown = {
        "id": "crown", "label": "crown-brass", "library_name": "crown-brass",
        "trigger": "crown brass", "hint": "", "creator": "Carolina Crown",
        "files": [{"name": "c.wav", "caption": "crown brass, hornline"}],
    }
    ra = SL.prep_job(adagio, tmp / "work", [src], window_s=8.0)
    rc = SL.prep_job(crown, tmp / "work", [src], window_s=8.0)
    assert ra["clip_count"] == 1
    assert rc["clip_count"] == 2
    assert ra["bundle_path"] != rc["bundle_path"]
    am = json.loads(Path(ra["bundle_path"], "corpus.manifest.json").read_text())
    cm = json.loads(Path(rc["bundle_path"], "corpus.manifest.json").read_text())
    assert all(s["title"].startswith("barber") for s in am["sources"])
    assert all(s["title"].startswith("crown") for s in cm["sources"])


def main() -> None:
    fails = []
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
            except Exception as exc:  # noqa: BLE001
                fails.append(f"{name}: {exc}")
    for f in fails:
        print("FAIL", f)
    if fails:
        sys.exit(1)
    print("style_lora_test: OK (slice, silence, captions, two bundles)")


if __name__ == "__main__":
    main()
