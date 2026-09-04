#!/usr/bin/env python3
"""Tests for match_kit.py — runnable as `python3 match_kit_test.py` (repo gate convention).
Lane-mapping and cosine-ranking logic are pure numpy (no librosa/soundfile needed) and are
always exercised. The end-to-end embed-a-real-wav path additionally needs
service/teardown/drummatch/embed.py's runtime deps (librosa, soundfile) — when they are
not importable on the interpreter running this file, that one test SKIPS cleanly (printed,
not a failure) rather than crashing the whole suite, matching the pattern
scripts/lab/make-lab-manifest.py uses for its own optional measurement passes.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("match_kit", HERE / "match_kit.py")
match_kit = importlib.util.module_from_spec(SPEC)
sys.modules["match_kit"] = match_kit
SPEC.loader.exec_module(match_kit)

FAILURES: list[str] = []
SKIPPED: list[str] = []


def check(name: str, cond: bool, detail: str = ""):
    if cond:
        print(f"  ok   {name}")
    else:
        FAILURES.append(name)
        print(f"  FAIL {name}  {detail}")


def skip(name: str, reason: str):
    SKIPPED.append(name)
    print(f"  skip {name}  ({reason})")


def test_lane_mapping():
    print("test_lane_mapping:")
    check("kick direct", match_kit.determine_lane("kick", "@15drtt jers kick.wav") == "kick")
    check("hat direct", match_kit.determine_lane("hat", "@15drtt hatime hhat.wav") == "hat")
    check("openhat direct", match_kit.determine_lane("openhat", "@15drtt tred ohat.wav") == "openhat")
    check("perc direct", match_kit.determine_lane("perc", "@15drtt bestsnap perc.wav") == "perc")
    check("fx direct", match_kit.determine_lane("fx", "@15drtt scratch fx.wav") == "fx")

    check("snare 'light' -> snare", match_kit.determine_lane("snare", "@15drtt light snare.wav") == "snare")
    check("snare 'mem' -> roll", match_kit.determine_lane("snare", "@15drtt mem snare.wav") == "roll")
    check("snare 'omg' -> snare2", match_kit.determine_lane("snare", "@15drtt omg snare.wav") == "snare2")
    check("snare unrecognized fragment -> None", match_kit.determine_lane("snare", "@15drtt whoknows snare.wav") is None)

    check("clap 'law' -> clap", match_kit.determine_lane("clap", "clap - law @ripali___.wav") == "clap")
    check("clap 'igdk' -> clap2", match_kit.determine_lane("clap", "@15drtt igdk clap.wav") == "clap2")

    check("bass excluded", match_kit.determine_lane("bass", "808 - spice @ripali___.wav") is None)
    check("808 excluded", match_kit.determine_lane("808", "some 808.wav") is None)
    check("case-insensitive role", match_kit.determine_lane("KICK", "x.wav") == "kick")
    check("case-insensitive fragment", match_kit.determine_lane("snare", "@15drtt LIGHT snare.wav") == "snare")


def test_cosine_rank_and_standardize():
    print("test_cosine_rank_and_standardize:")
    import numpy as np

    rng = np.random.default_rng(0)
    dim = 8
    n = 6
    mean = rng.normal(size=dim)
    std = np.abs(rng.normal(size=dim)) + 0.5

    raw_vectors = rng.normal(size=(n, dim)) * std + mean
    standardized = []
    for row in raw_vectors:
        z = (row - mean) / std
        z = z / np.linalg.norm(z)
        standardized.append(z.astype(np.float32))
    palette_vectors = np.vstack(standardized)
    palette_roles = ["kick", "kick", "snare", "snare", "kick", "fx"]

    # query = an exact copy of palette row 4 (a "kick") — must rank itself #1 among kicks
    query_raw = raw_vectors[4]
    query_vec = match_kit.standardize(query_raw, mean, std)
    check("standardize returns unit-norm vector", abs(float(np.linalg.norm(query_vec)) - 1.0) < 1e-4,
          float(np.linalg.norm(query_vec)))

    ranked = match_kit.cosine_rank(query_vec, palette_vectors, palette_roles, "kick", k=4)
    check("top result is the exact match (index 4)", ranked[0][0] == 4, ranked)
    check("top cosine ~= 1.0", abs(ranked[0][1] - 1.0) < 1e-3, ranked[0][1])
    check("only kick-role rows returned", all(palette_roles[i] == "kick" for i, _ in ranked), ranked)
    check("at most 3 kick rows exist so <=3 results", len(ranked) <= 3, ranked)

    ranked_fx = match_kit.cosine_rank(query_vec, palette_vectors, palette_roles, "fx", k=4)
    check("fx-restricted search returns the one fx row", len(ranked_fx) == 1 and ranked_fx[0][0] == 5, ranked_fx)

    ranked_missing = match_kit.cosine_rank(query_vec, palette_vectors, palette_roles, "openhat", k=4)
    check("no matches for an absent role returns empty", ranked_missing == [], ranked_missing)


def _write_json(path: Path, doc) -> None:
    path.write_text(json.dumps(doc, indent=2), encoding="utf-8")


def test_build_kitmatch_end_to_end():
    print("test_build_kitmatch_end_to_end:")
    EngineeredEmbedder, load_audio = match_kit._try_import_embedder()
    if EngineeredEmbedder is None:
        skip("test_build_kitmatch_end_to_end", "librosa/soundfile/numpy not importable on this interpreter")
        return

    import struct
    import numpy as np

    def make_wav(path: Path, sr: int, seconds: float, freq: float, amp: float = 0.5):
        n = int(sr * seconds)
        t = np.arange(n) / sr
        y = (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)
        pcm = np.clip(y * 32767.0, -32768, 32767).astype("<i2")
        data = pcm.tobytes()
        fmt = struct.pack("<HHIIHH", 1, 1, sr, sr * 2, 2, 16)
        buf = bytearray()
        buf += b"RIFF" + struct.pack("<I", 4 + 8 + len(fmt) + 8 + len(data)) + b"WAVE"
        buf += b"fmt " + struct.pack("<I", len(fmt)) + fmt
        buf += b"data" + struct.pack("<I", len(data)) + data
        path.write_bytes(bytes(buf))

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        palette_dir = tmp / "palette"
        palette_dir.mkdir()
        lab_dir = tmp / "lab"
        lab_dir.mkdir()

        # palette: two "kick" one-shots at different frequencies (so the embedder tells
        # them apart), one "fx", one "snare" and one "clap" one-shot.
        kick_lo = palette_dir / "kick_lo.wav"
        kick_hi = palette_dir / "kick_hi.wav"
        fx_one = palette_dir / "fx_one.wav"
        snare_one = palette_dir / "snare_one.wav"
        clap_one = palette_dir / "clap_one.wav"
        make_wav(kick_lo, 44100, 0.3, 80.0)
        make_wav(kick_hi, 44100, 0.3, 2000.0)
        make_wav(fx_one, 44100, 0.3, 500.0)
        make_wav(snare_one, 44100, 0.2, 305.0)
        make_wav(clap_one, 44100, 0.2, 405.0)

        palette_files = (kick_lo, kick_hi, fx_one, snare_one, clap_one)
        emb = EngineeredEmbedder()
        raws = []
        for p in palette_files:
            la = load_audio(str(p))
            raws.append(np.asarray(emb.embed(la.y, la.sr), dtype=np.float64))
        X = np.vstack(raws)
        mean = X.mean(axis=0)
        std = X.std(axis=0)
        std[std < 1e-9] = 1.0
        z = (X - mean) / std
        norms = np.linalg.norm(z, axis=1, keepdims=True)
        norms[norms < 1e-12] = 1.0
        vectors = (z / norms).astype(np.float32)
        np.save(palette_dir / "vectors.npy", vectors)

        palette_manifest = {
            "version": emb.version, "sr": 44100, "window_s": 1.0, "count": len(palette_files),
            "mean": mean.tolist(), "std": std.tolist(),
            "items": [
                {"path": str(kick_lo), "role_guess": "kick", "kind": "oneshot", "content_hash": "aaaa"},
                {"path": str(kick_hi), "role_guess": "kick", "kind": "oneshot", "content_hash": "bbbb"},
                {"path": str(fx_one), "role_guess": "fx", "kind": "oneshot", "content_hash": "cccc"},
                {"path": str(snare_one), "role_guess": "snare", "kind": "oneshot", "content_hash": "dddd"},
                {"path": str(clap_one), "role_guess": "clap", "kind": "oneshot", "content_hash": "eeee"},
            ],
        }
        palette_manifest_path = palette_dir / "manifest.json"
        _write_json(palette_manifest_path, palette_manifest)

        # lab: a kick that should timbrally match kick_lo far better than kick_hi (same
        # low frequency), a snare trio (light/mem/omg), a clap pair (law/igdk), and a
        # bass item that must be excluded entirely.
        lab_kick = lab_dir / "@15drtt jers kick.wav"
        make_wav(lab_kick, 44100, 0.3, 82.0)  # close to kick_lo's 80Hz, far from kick_hi's 2000Hz
        lab_snare_light = lab_dir / "@15drtt light snare.wav"
        make_wav(lab_snare_light, 44100, 0.2, 300.0)
        lab_snare_mem = lab_dir / "@15drtt mem snare.wav"
        make_wav(lab_snare_mem, 44100, 0.2, 310.0)
        lab_snare_omg = lab_dir / "@15drtt omg snare.wav"
        make_wav(lab_snare_omg, 44100, 0.2, 320.0)
        lab_clap_law = lab_dir / "clap - law @ripali___.wav"
        make_wav(lab_clap_law, 44100, 0.2, 400.0)
        lab_bass = lab_dir / "808 - spice @ripali___.wav"
        make_wav(lab_bass, 44100, 0.5, 41.0)

        lab_manifest = {
            "version": 1, "count": 6,
            "items": [
                {"path": str(lab_kick), "role_guess": "kick", "kind": "oneshot", "content_hash": "1111"},
                {"path": str(lab_snare_light), "role_guess": "snare", "kind": "oneshot", "content_hash": "2222"},
                {"path": str(lab_snare_mem), "role_guess": "snare", "kind": "oneshot", "content_hash": "3333"},
                {"path": str(lab_snare_omg), "role_guess": "snare", "kind": "oneshot", "content_hash": "4444"},
                {"path": str(lab_clap_law), "role_guess": "clap", "kind": "oneshot", "content_hash": "5555"},
                {"path": str(lab_bass), "role_guess": "bass", "kind": "oneshot", "content_hash": "6666",
                 "root_note": 24, "root_source": "measured"},
            ],
        }
        lab_manifest_path = lab_dir / "lab-manifest.json"
        _write_json(lab_manifest_path, lab_manifest)

        result = match_kit.build_kitmatch(lab_manifest_path, palette_manifest_path)

        check("version field present", result["version"] == "kitmatch-v1", result.get("version"))
        check("kick lane present", "kick" in result["lanes"])
        check("kick lane best-matches kick_lo (closer frequency)",
              result["lanes"]["kick"]["paletteFile"] == str(kick_lo),
              result["lanes"]["kick"])
        check("kick lane cosine is a float in [-1,1]",
              isinstance(result["lanes"]["kick"]["cosine"], float) and -1.0 <= result["lanes"]["kick"]["cosine"] <= 1.0)
        check("kick lane has alternates (kick_hi, since only 2 kicks exist)",
              len(result["lanes"]["kick"]["alternates"]) == 1
              and result["lanes"]["kick"]["alternates"][0]["paletteFile"] == str(kick_hi),
              result["lanes"]["kick"]["alternates"])

        # the three snares must land on three DIFFERENT lanes per the filename-fragment map,
        # each independently matched against the single palette "snare" item.
        check("snare -> lane 'snare'", result["lanes"]["snare"]["ownerFile"] == str(lab_snare_light))
        check("mem snare -> lane 'roll'", result["lanes"]["roll"]["ownerFile"] == str(lab_snare_mem))
        check("omg snare -> lane 'snare2'", result["lanes"]["snare2"]["ownerFile"] == str(lab_snare_omg))
        for lane in ("snare", "roll", "snare2"):
            check(f"{lane} lane matched the only palette snare item",
                  result["lanes"][lane]["paletteFile"] == str(snare_one), result["lanes"][lane])
            check(f"{lane} lane has no alternates (only one palette snare item)",
                  result["lanes"][lane]["alternates"] == [], result["lanes"][lane]["alternates"])

        check("clap -> lane 'clap'", result["lanes"]["clap"]["ownerFile"] == str(lab_clap_law))
        check("clap lane matched the only palette clap item",
              result["lanes"]["clap"]["paletteFile"] == str(clap_one), result["lanes"]["clap"])
        check("clap2 lane absent (no 'igdk' lab item in this fixture)", "clap2" not in result["lanes"])

        check("bass item excluded from lanes", "bass" not in result["lanes"])
        skip_paths = {row["path"] for row in result["skipped"]}
        check("bass item not reported as skipped-with-error (silently excluded)",
              str(lab_bass) not in skip_paths, result["skipped"])

        # write to disk via the CLI path and re-read
        out_path = tmp / "out" / "kitmatch.json"
        rc = match_kit.main([str(lab_manifest_path), str(palette_manifest_path), "--out", str(out_path)])
        check("CLI exits 0", rc == 0, rc)
        check("output file written", out_path.is_file())
        on_disk = json.loads(out_path.read_text())
        check("on-disk lanes match in-memory result", set(on_disk["lanes"]) == set(result["lanes"]))


def test_stale_vectors_row_count_mismatch_raises():
    print("test_stale_vectors_row_count_mismatch_raises:")
    import numpy as np

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        manifest = {
            "version": "engineered-v1", "mean": [0.0] * 4, "std": [1.0] * 4,
            "items": [{"path": "a.wav", "role_guess": "kick"}, {"path": "b.wav", "role_guess": "kick"}],
        }
        manifest_path = tmp / "manifest.json"
        _write_json(manifest_path, manifest)
        np.save(tmp / "vectors.npy", np.zeros((1, 4), dtype=np.float32))  # 1 row, 2 items -> mismatch

        raised = False
        try:
            match_kit.load_palette(manifest_path)
        except ValueError:
            raised = True
        check("mismatched vectors.npy row count raises ValueError", raised)


def main() -> int:
    test_lane_mapping()
    test_cosine_rank_and_standardize()
    test_build_kitmatch_end_to_end()
    test_stale_vectors_row_count_mismatch_raises()
    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): {FAILURES}")
        return 1
    suffix = f", {len(SKIPPED)} skipped" if SKIPPED else ""
    print(f"OK{suffix}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
