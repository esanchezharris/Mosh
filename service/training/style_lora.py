"""Slice long source audio into SA3 clips and train two style LoRAs.

Each registry source is one training clip. Feeding the four long MP3s through
as-is would give the trainer 1 + 3 clips, which underfits and can OOM on an
8-minute latent. This windows them to SA3_SECONDS (8s), skips near-silence,
writes style-transfer captions, builds two approved corpus bundles, and (when
the local pmetal trainer is ready) trains `barber-adagio` then `crown-brass`.

    python3 service/training/style_lora.py measure
    python3 service/training/style_lora.py prep
    python3 service/training/style_lora.py train
    python3 service/training/style_lora.py all

Stdlib + ffmpeg/ffprobe. No GPU imports.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import struct
import subprocess
import sys
import wave
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
SERVICE = HERE.parent
if str(SERVICE) not in sys.path:
    sys.path.insert(0, str(SERVICE))

from training import corpus_bundle as CB
from training import recipe as R
from training import rights as RG

WINDOW_S = float(os.environ.get("SA3_SECONDS", "8.0"))
MIN_S = 2.0
SILENCE_DBFS = -40.0
LICENSE = "personal-experiment local files"
PROOF = "owner-provided local copies; personal experiment"

# Exact filenames the producer named. Search is case-insensitive and collapses
# repeated whitespace so a double-space in the 2017 title still resolves.
JOBS: list[dict[str, Any]] = [
    {
        "id": "adagio",
        "label": "barber-adagio",
        "library_name": "barber-adagio",
        "trigger": "barber adagio",
        "hint": "slow orchestral strings, sustained lyrical phrasing",
        "creator": "Samuel Barber",
        "caption": (
            "barber adagio, slow orchestral strings, sustained lyrical phrasing, "
            "rising swell, minor"
        ),
        "files": [
            {
                "name": "Samuel Barber - Adagio for Strings.mp3",
                "caption": (
                    "barber adagio, slow orchestral strings, sustained lyrical "
                    "phrasing, rising swell, minor"
                ),
            },
        ],
    },
    {
        "id": "crown",
        "label": "crown-brass",
        "library_name": "crown-brass",
        "trigger": "crown brass",
        "hint": "hornline, tight ensemble, indoor gym",
        "creator": "Carolina Crown",
        "files": [
            {
                "name": "Carolina Crown's Hornline Drops The Hammer In Houston.mp3",
                "caption": (
                    "crown brass, hornline, tight ensemble, indoor gym, "
                    "powerful brass"
                ),
            },
            {
                "name": "Carolina Crown 2017  Inside the Circle  Semifinals.mp3",
                "caption": (
                    "crown brass, hornline, drum corps show, tight ensemble, "
                    "indoor gym"
                ),
            },
            {
                "name": "Carolina Crown Brass 2015 Tuning Sequence (72115).mp3",
                "caption": (
                    "crown brass, hornline warmup, tuning sequence, concert F, "
                    "tight ensemble"
                ),
            },
        ],
    },
]


def default_work() -> Path:
    env = os.environ.get("MOSH_STYLE_LORA_WORK", "").strip()
    if env:
        return Path(os.path.expanduser(env))
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Mosh" / "style-lora"
    return Path(os.environ.get("TMPDIR", "/tmp")) / "mosh-style-lora"


def default_search_dirs(extra: list[Path] | None = None) -> list[Path]:
    out: list[Path] = []
    env = os.environ.get("MOSH_STYLE_LORA_SOURCES", "").strip()
    if env:
        out.append(Path(os.path.expanduser(env)))
    out.extend(
        [
            Path("/Users/emiliosanchez-harris/Downloads"),
            Path.home() / "Downloads",
            SERVICE.parent / "work" / "style-lora" / "sources",
        ]
    )
    if extra:
        out.extend(extra)
    seen: set[str] = set()
    uniq: list[Path] = []
    for p in out:
        key = str(p)
        if key in seen:
            continue
        seen.add(key)
        uniq.append(p)
    return uniq


def _norm_name(name: str) -> str:
    return " ".join(Path(name).name.lower().replace("_", " ").split())


def resolve_source(filename: str, search_dirs: list[Path]) -> Path | None:
    """Find `filename` in search_dirs. Exact path, then fuzzy basename."""
    raw = Path(os.path.expanduser(filename))
    if raw.is_file():
        return raw
    want = _norm_name(filename)
    for d in search_dirs:
        direct = d / Path(filename).name
        if direct.is_file():
            return direct
        if not d.is_dir():
            continue
        for cand in d.iterdir():
            if cand.is_file() and _norm_name(cand.name) == want:
                return cand
    return None


def probe_duration(path: Path) -> float:
    """Seconds, via ffprobe (any container) or the WAV header."""
    if path.suffix.lower() == ".wav":
        with wave.open(str(path), "rb") as w:
            return w.getnframes() / float(w.getframerate())
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def _wav_is_training_pcm(path: Path) -> bool:
    """True when `path` is already the 44.1 kHz stereo s16 the trainer wants."""
    if path.suffix.lower() != ".wav" or not path.is_file():
        return False
    try:
        with wave.open(str(path), "rb") as w:
            return (w.getnchannels() == 2 and w.getsampwidth() == 2
                    and w.getframerate() == 44100)
    except Exception:  # noqa: BLE001
        return False


def decode_to_wav(src: Path, dst: Path) -> Path:
    """Decode any ffmpeg-readable file to 44.1 kHz stereo s16 WAV.

    Already-correct WAVs are copied (or reused) so hermetic tests never need
    ffmpeg, and a producer who sliced offline is not re-encoded.
    """
    dst.parent.mkdir(parents=True, exist_ok=True)
    if _wav_is_training_pcm(src):
        if src.resolve() == dst.resolve():
            return dst
        dst.write_bytes(src.read_bytes())
        return dst
    cmd = [
        "ffmpeg", "-y", "-i", str(src),
        "-ac", "2", "-ar", "44100", "-sample_fmt", "s16",
        str(dst),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    return dst


def rms_dbfs(samples: tuple[int, ...] | list[int]) -> float:
    if not samples:
        return -120.0
    acc = 0.0
    for s in samples:
        acc += float(s) * float(s)
    rms = math.sqrt(acc / len(samples))
    if rms < 1e-9:
        return -120.0
    return 20.0 * math.log10(rms / 32768.0)


def write_wav(path: Path, samples: list[int], channels: int, samplerate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = struct.pack("<%dh" % len(samples), *[max(-32768, min(32767, int(s))) for s in samples])
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(samplerate)
        w.writeframes(body)


def slice_wav(
    wav_path: Path,
    out_dir: Path,
    prefix: str,
    window_s: float = WINDOW_S,
    hop_s: float | None = None,
    min_s: float = MIN_S,
    silence_dbfs: float = SILENCE_DBFS,
) -> list[dict[str, Any]]:
    """Window a decoded WAV. Returns kept clip records (path, start, seconds, dbfs)."""
    hop = window_s if hop_s is None else hop_s
    out_dir.mkdir(parents=True, exist_ok=True)
    clips: list[dict[str, Any]] = []
    with wave.open(str(wav_path), "rb") as w:
        ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        if sw != 2:
            raise ValueError(f"{wav_path} must be 16-bit PCM, got sampwidth={sw}")
        duration = n / float(sr)
        start = 0.0
        idx = 0
        while start < duration - 1e-9:
            remain = duration - start
            length = min(window_s, remain)
            if length + 1e-9 < min_s:
                break
            w.setpos(max(0, min(n, int(round(start * sr)))))
            nframes = max(1, int(round(length * sr)))
            raw = w.readframes(nframes)
            samples = list(struct.unpack("<%dh" % (len(raw) // 2), raw))
            dbfs = rms_dbfs(samples)
            if dbfs < silence_dbfs:
                start += hop
                idx += 1
                continue
            dest = out_dir / f"{prefix}_{idx:04d}.wav"
            write_wav(dest, samples, ch, sr)
            clips.append({
                "path": dest,
                "start": round(start, 3),
                "seconds": round(len(samples) / (ch * sr), 3),
                "dbfs": round(dbfs, 2),
                "index": idx,
            })
            start += hop
            idx += 1
    return clips


def _source_record(source_id: str, title: str, creator: str, local_path: Path,
                   notes: str = "") -> dict[str, Any]:
    return RG.normalize_source({
        "source_id": source_id,
        "title": title,
        "creator": creator,
        "source_url": "",
        "local_path": str(local_path),
        "user_claimed_license": LICENSE,
        "proof_of_rights": PROOF,
        "approved_for_training": True,
        "expiration": None,
        "notes": notes,
    })


def measure_sources(search_dirs: list[Path] | None = None) -> dict[str, Any]:
    dirs = search_dirs or default_search_dirs()
    report: dict[str, Any] = {"search_dirs": [str(d) for d in dirs], "jobs": []}
    missing: list[str] = []
    for job in JOBS:
        files = []
        for spec in job["files"]:
            path = resolve_source(spec["name"], dirs)
            rec: dict[str, Any] = {"name": spec["name"], "path": str(path) if path else None}
            if path is None:
                missing.append(spec["name"])
                rec["error"] = "not found"
            else:
                try:
                    rec["seconds"] = round(probe_duration(path), 3)
                    rec["bytes"] = path.stat().st_size
                except Exception as exc:  # noqa: BLE001
                    rec["error"] = f"probe failed: {exc}"
                    missing.append(spec["name"])
            files.append(rec)
        report["jobs"].append({"id": job["id"], "files": files})
    report["missing"] = missing
    report["ok"] = not missing
    return report


def prep_job(job: dict[str, Any], work: Path, search_dirs: list[Path],
             window_s: float = WINDOW_S, silence_dbfs: float = SILENCE_DBFS) -> dict[str, Any]:
    clips_dir = work / "clips" / job["id"]
    decoded_dir = work / "decoded" / job["id"]
    if clips_dir.exists():
        for p in clips_dir.glob("*.wav"):
            p.unlink()
    clips_dir.mkdir(parents=True, exist_ok=True)
    decoded_dir.mkdir(parents=True, exist_ok=True)

    sources: list[dict[str, Any]] = []
    skipped_silent = 0
    file_reports: list[dict[str, Any]] = []
    n = 0
    for spec in job["files"]:
        src = resolve_source(spec["name"], search_dirs)
        if src is None:
            raise FileNotFoundError(
                f"source not found: {spec['name']}\n"
                f"searched: {', '.join(str(d) for d in search_dirs)}"
            )
        stem = "".join(c if c.isalnum() or c in "-_" else "-" for c in src.stem)[:48].strip("-") or "src"
        wav = decode_to_wav(src, decoded_dir / f"{stem}.wav")
        windows = slice_wav(wav, clips_dir, prefix=stem, window_s=window_s,
                            silence_dbfs=silence_dbfs)
        # slice_wav already dropped silence; count discarded windows from duration.
        duration = probe_duration(wav)
        possible = max(0, int(math.floor((duration + 1e-9) / window_s)))
        skipped_silent += max(0, possible - len(windows))
        caption = spec.get("caption") or job.get("caption") or ""
        for clip in windows:
            n += 1
            sid = f"{job['id']}-{n:03d}"
            sources.append(_source_record(
                sid, caption, job["creator"], clip["path"],
                notes=f"{src.name} @ {clip['start']:.1f}s ({clip['dbfs']} dBFS)",
            ))
        file_reports.append({
            "name": spec["name"],
            "path": str(src),
            "seconds": round(duration, 3),
            "kept": len(windows),
        })

    if not sources:
        raise RuntimeError(f"{job['id']}: no usable clips after silence skip")

    registry = {"version": 1, "sources": sources}
    registry_path = work / "registries" / f"{job['id']}.json"
    RG.save_registry(registry_path, registry)
    bundle = CB.build_corpus_bundle(registry_path, work / "bundles", bundle_name=job["id"])
    plan = R.recommend_recipe(len(sources))
    result = {
        "id": job["id"],
        "label": job["label"],
        "library_name": job["library_name"],
        "trigger": job["trigger"],
        "hint": job["hint"],
        "clip_count": len(sources),
        "skipped_silent": skipped_silent,
        "files": file_reports,
        "registry_path": str(registry_path),
        "bundle_path": bundle["bundle_path"],
        "bundle_hash": bundle["bundle_hash"],
        "recipe": plan,
    }
    (work / f"{job['id']}.prep.json").write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return result


def prep_all(work: Path, search_dirs: list[Path] | None = None,
             window_s: float = WINDOW_S, silence_dbfs: float = SILENCE_DBFS) -> list[dict[str, Any]]:
    dirs = search_dirs or default_search_dirs()
    work.mkdir(parents=True, exist_ok=True)
    return [prep_job(job, work, dirs, window_s=window_s, silence_dbfs=silence_dbfs) for job in JOBS]


def trainer_readiness() -> tuple[bool, list[str], str]:
    """(ready, blockers, backend)."""
    from training import local_pmetal as LP
    from training.trainer_job import backend_name
    ready, blockers = LP.readiness()
    return ready, blockers, backend_name()


def train_job(prep: dict[str, Any], work: Path) -> dict[str, Any]:
    from training.trainer_job import train
    ready, blockers, backend = trainer_readiness()
    if not ready or backend == "fake":
        raise RuntimeError(
            "refusing to train: the local SA3 trainer is not ready "
            f"(backend={backend}): " + "; ".join(blockers or ["fake stub"])
        )
    out = work / "runs" / prep["id"]
    out.mkdir(parents=True, exist_ok=True)
    plan = prep["recipe"]
    config = {
        "rank": 16,
        "lr": 1e-4,
        "label": prep["label"],
        "steps": int(plan["steps"]),
        "batch_size": int(plan["batchSize"]),
        "grad_accum": int(plan["gradAccum"]),
    }
    print(f"[style-lora] train {prep['label']}: {prep['clip_count']} clips, "
          f"{config['steps']} steps, est {plan['estMinutes']} min", flush=True)
    result = train(prep["bundle_path"], str(out), config)
    (out / "train.result.json").write_text(
        json.dumps(result, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")
    return result


def promote_final(prep: dict[str, Any], train_result: dict[str, Any]) -> dict[str, Any]:
    """Keep the run's final adapter. Ear-audition is preferred; @final is the
    honest default when this box cannot listen."""
    from loras import install as INS
    from loras import promote as PRO

    label = prep["label"]
    name = prep["library_name"]
    trigger = prep["trigger"]
    hint = prep["hint"]
    notes = (
        f"Style LoRA from {prep['clip_count']} sliced clips. "
        f"Kept default @final (audition later and re-promote if another take wins)."
    )
    take = f"{label}@final"
    try:
        return PRO.promote(take, name, trigger=trigger, hint=hint, notes=notes,
                           display=name)
    except Exception as exc:  # noqa: BLE001 — fall back to the run artifact
        artifact = str(train_result.get("artifact_path") or "")
        if not artifact or not os.path.isfile(artifact):
            raise RuntimeError(f"promote {take} failed ({exc}) and no artifact_path") from exc
        return INS.install(artifact, name=name, trigger=trigger, hint=hint,
                           notes=notes, display=name)


def _print_measure(report: dict[str, Any]) -> None:
    print("search dirs:")
    for d in report["search_dirs"]:
        print(f"  {d}")
    for job in report["jobs"]:
        print(f"\n{job['id']}:")
        for f in job["files"]:
            if f.get("seconds") is not None:
                print(f"  {f['seconds']:7.1f}s  {f['path']}")
            else:
                print(f"  MISSING   {f['name']}  ({f.get('error')})")
    if report["missing"]:
        print(f"\nmissing {len(report['missing'])} source(s)")
    else:
        print("\nall sources found")


def _print_prep(results: list[dict[str, Any]]) -> None:
    total_min = 0.0
    for r in results:
        plan = r["recipe"]
        total_min += float(plan["estMinutes"])
        print(f"{r['id']}: {r['clip_count']} clips  "
              f"(skipped {r['skipped_silent']} silent)  "
              f"{plan['steps']} steps ≈ {plan['estMinutes']} min  "
              f"bundle={r['bundle_path']}")
        for f in r["files"]:
            print(f"  {f['kept']:4d} clips from {f['seconds']:.1f}s  {f['name']}")
    print(f"sequential train ETA ≈ {total_min:.1f} min (trainer only, no prep/audition)")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Prep and train the two SA3 style LoRAs.")
    ap.add_argument("cmd", nargs="?", default="all",
                    choices=("measure", "prep", "train", "promote", "all"))
    ap.add_argument("--work", default=str(default_work()), help="working directory")
    ap.add_argument("--source-dir", action="append", default=[],
                    help="extra directory to search for the four MP3s (repeatable)")
    ap.add_argument("--window", type=float, default=WINDOW_S)
    ap.add_argument("--silence-dbfs", type=float, default=SILENCE_DBFS)
    args = ap.parse_args(argv)
    work = Path(os.path.expanduser(args.work))
    search = default_search_dirs([Path(os.path.expanduser(d)) for d in args.source_dir])

    if args.cmd == "measure":
        report = measure_sources(search)
        _print_measure(report)
        (work).mkdir(parents=True, exist_ok=True)
        (work / "measure.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        return 0 if report["ok"] else 2

    if args.cmd in ("prep", "all"):
        report = measure_sources(search)
        _print_measure(report)
        if not report["ok"]:
            print("cannot prep: source files are not on this machine", flush=True)
            (work).mkdir(parents=True, exist_ok=True)
            (work / "measure.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
            return 2
        results = prep_all(work, search, window_s=args.window, silence_dbfs=args.silence_dbfs)
        _print_prep(results)
        if args.cmd == "prep":
            return 0
    else:
        results = []
        for job in JOBS:
            p = work / f"{job['id']}.prep.json"
            if not p.is_file():
                print(f"missing {p} — run prep first", flush=True)
                return 2
            results.append(json.loads(p.read_text(encoding="utf-8")))

    ready, blockers, backend = trainer_readiness()
    print(f"trainer backend={backend} ready={ready}")
    if not ready:
        for b in blockers:
            print(f"  blocker: {b}")
        print("prep is done; train on the Mac (pmetal + SA3 MLX) or a RunPod GPU.")
        return 3

    if args.cmd in ("train", "all"):
        trained: list[tuple[dict[str, Any], dict[str, Any]]] = []
        for prep in results:
            trained.append((prep, train_job(prep, work)))
        if args.cmd == "train":
            return 0
        results_and_trains = trained
    else:
        results_and_trains = []
        for prep in results:
            tpath = work / "runs" / prep["id"] / "train.result.json"
            if not tpath.is_file():
                print(f"missing {tpath} — run train first", flush=True)
                return 2
            results_and_trains.append((prep, json.loads(tpath.read_text(encoding="utf-8"))))

    for prep, tres in results_and_trains:
        rec = promote_final(prep, tres)
        print(f"kept {rec.get('name')} trigger={prep['trigger']!r} file={rec.get('file')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
