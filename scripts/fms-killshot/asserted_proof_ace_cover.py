"""ACE-Step Cover spike orchestration for the Used2 opening proof.

The raw take supplies structure (src_audio), the 16 asserted words supply
lyrics; reference_audio stays None (voice identity comes after guide
validation). Eight pinned seeds, evaluated with lexical + contour + attack
diagnostics; owner listening is the only pass. Idempotent: a seed is
regenerated only when its receipt or the pinned request drifts.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import wave
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from asserted_proof_cover_lexical import normalize_asr_word, score_lexical  # noqa: E402
from asserted_proof_cover_metrics import attack_errors_from_alignment, compare_f0_contours, effective_status, evaluate_candidate, ranking_key  # noqa: E402
from asserted_proof_metrics import compare_audio  # noqa: E402
from asserted_proof_plan import build_manifest  # noqa: E402
from asserted_proof_provenance import receipt_is_current, write_receipt  # noqa: E402
from asserted_proof_runtime import BRIDGE, REPO, SKELETON_PY, SOULX_PY, WHISPER_PY, WORKER, Paths, convert_audio, dump_json, load_json, run, run_json  # noqa: E402

import os  # noqa: E402

ACE_ROOT = Path(os.path.expanduser(os.environ.get("ACE_STEP_MAC_DIR", "~/AI/ace-step-1.5-mac")))
ACE_PY = ACE_ROOT / ".venv/bin/python"
ACE_WORKER = HERE / "ace_cover_worker.py"
ACE_DIR_NAME = "ace-step-cover"
LEGACY_DIR_NAME = "ace-step-spike"
CHECKPOINT_NAME = "acestep-v15-turbo"
COVER_INSTRUCTION = "Generate audio semantic tokens based on the given conditions:"
OPENING_LYRICS = "[Verse]\nYeah we used to fight like invincible\nBut in the night we got hella close yeah"

PINNED_SEEDS = (7, 42, 73, 271, 509, 911, 2027, 4099)
IMPORTED_SEEDS = frozenset({42})
GENERATED_SEEDS = tuple(seed for seed in PINNED_SEEDS if seed not in IMPORTED_SEEDS)

SEED_RECEIPT_LABELS = frozenset({"request", "rawSlice", "rawClipF0", "output", "asr", "align", "renderedF0", "eval"})
IMPORTED_RECEIPT_LABELS = SEED_RECEIPT_LABELS | {"importedSource"}
MIN_FREE_DISK_BYTES = 8 * 1024**3


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def ace_dir_for(paths: Paths) -> Path:
    return paths.opening / ACE_DIR_NAME


def seed_paths(ace_dir: Path, seed: int) -> dict[str, Path]:
    return {
        "full": ace_dir / f"seed-{seed}-full.wav",
        "opening": ace_dir / f"seed-{seed}-opening.wav",
        "asr": ace_dir / f"seed-{seed}-asr.json",
        "align": ace_dir / f"seed-{seed}-align.json",
        "f0": ace_dir / f"seed-{seed}-f0.json",
        "eval": ace_dir / f"seed-{seed}-eval.json",
        "receipt": ace_dir / f"seed-{seed}-receipt.json",
    }


def lyrics_words(lyrics_text: str) -> list[str]:
    words: list[str] = []
    for line in lyrics_text.splitlines():
        stripped = line.strip()
        if not stripped or (stripped.startswith("[") and stripped.endswith("]")):
            continue
        words.extend(token for token in (normalize_asr_word(part) for part in stripped.split()) if token)
    return words


def validate_lyrics_against_plan(lyrics_text: str, plan: dict) -> None:
    expected = [normalize_asr_word(str(word["text"])) for word in plan["words"]]
    actual = lyrics_words(lyrics_text)
    if actual != expected:
        raise RuntimeError(f"lyrics do not match the asserted words: lyrics='{' '.join(actual)}' asserted='{' '.join(expected)}'")


def pinned_params(*, src_audio_rel: str, lyrics: str) -> dict:
    return {
        "task_type": "cover",
        "instruction": COVER_INSTRUCTION,  # the dataclass default is the text2music instruction; nothing auto-swaps it for explicit cover
        "src_audio": src_audio_rel,
        "reference_audio": None,
        "audio_codes": "",
        "caption": "",
        "lyrics": lyrics,
        "vocal_language": "en",
        "duration": -1.0,  # cover locks duration to the source
        "inference_steps": 8,
        "guidance_scale": 1.0,  # turbo coerces to 1.0; recorded honestly
        "shift": 3.0,  # CLI turbo default; dataclass default is 1.0
        "seed": -1,  # real seed arrives via GenerationConfig.seeds
        "audio_cover_strength": 1.0,
        "cover_noise_strength": 0.0,
        "thinking": False,  # LM is hard-skipped for cover; recorded honestly
    }


def build_ace_request(*, plan: dict, lyrics_text: str, source_hashes: dict, ace_git_rev: str, checkpoint: dict, seeds: list[int]) -> dict:
    validate_lyrics_against_plan(lyrics_text, plan)
    clip_start, clip_end = float(plan["clip"]["start"]), float(plan["clip"]["end"])
    duration = round(clip_end - clip_start, 4)
    request = {
        "version": 1,
        "assertedText": " ".join(str(word["text"]) for word in plan["words"]),
        "lyrics": lyrics_text,
        "lyricsSha256": hashlib.sha256(lyrics_text.encode("utf-8")).hexdigest(),
        "sourceWindow": {"absoluteStartS": clip_start, "absoluteEndS": clip_end, "durationS": duration},
        "sourceHashes": source_hashes,
        "pad": {"strategy": "trailing-silence", "targetDurationS": 10.0, "sampleRate": 48000, "channels": 2, "codec": "pcm_s16le", "tool": "ffmpeg", "filter": "apad=whole_dur=10"},
        "trim": {"startS": 0.0, "durationS": duration, "sampleRate": 24000, "channels": 1, "codec": "pcm_s16le", "tool": "ffmpeg"},
        "aceRuntime": {"rootEnv": "ACE_STEP_MAC_DIR", "gitRev": ace_git_rev, "pythonRelPath": ".venv/bin/python"},
        "checkpoint": checkpoint,
        "params": pinned_params(src_audio_rel=str(source_hashes["paddedSource"]["path"]), lyrics=lyrics_text),
        "seeds": [int(seed) for seed in seeds],
    }
    request["requestSha256"] = request_sha256(request)
    return request


def request_sha256(request: dict) -> str:
    subset = {key: value for key, value in request.items() if key not in ("requestSha256", "createdAt", "updatedAt")}
    return hashlib.sha256(json.dumps(subset, sort_keys=True).encode("utf-8")).hexdigest()


def write_request_if_changed(path: Path, request: dict, *, now_iso: str) -> tuple[dict, bool]:
    """Byte-stable request writer: an unchanged request leaves the file untouched
    so every receipt hashing it stays current; any drift rewrites it and thereby
    quarantines all candidate lanes at once."""
    fresh_hash = request_sha256(request)  # never trust an embedded hash — recompute
    created = now_iso
    if path.is_file():
        existing = load_json(path)
        if existing.get("requestSha256") == fresh_hash:
            return existing, False
        created = str(existing.get("createdAt", now_iso))
    payload = {**request, "requestSha256": fresh_hash, "createdAt": created, "updatedAt": now_iso}
    dump_json(path, payload)
    return payload, True


def build_worker_request(request: dict, *, root: Path, seeds: list[int], save_dir: Path) -> dict:
    params = dict(request["params"])
    params["src_audio"] = str(root / str(params["src_audio"]))
    return {
        "version": 1,
        "aceRoot": str(ACE_ROOT),
        "expectedGitRev": str(request["aceRuntime"]["gitRev"]),
        "configPath": str(request["checkpoint"]["name"]),
        "device": "auto",
        "saveDir": str(save_dir),
        "audioFormat": "wav",
        "seeds": [int(seed) for seed in seeds],
        "params": params,
    }


def plan_seed_work(ledger: dict, current_request_hash: str, ace_dir: Path) -> list[int]:
    by_seed = {int(entry["seed"]): entry for entry in ledger.get("candidates", []) if "seed" in entry}
    work: list[int] = []
    for seed in GENERATED_SEEDS:
        entry = by_seed.get(seed)
        receipt_ok = receipt_is_current(seed_paths(ace_dir, seed)["receipt"], SEED_RECEIPT_LABELS)
        if entry is not None and entry.get("requestSha256") == current_request_hash and receipt_ok:
            continue
        work.append(seed)
    return work


def candidate_summaries(evaluations: list[dict], verdicts: dict[str, dict], current_manifest_sha256: str) -> list[dict]:
    ordered = sorted(evaluations, key=ranking_key)
    summaries: list[dict] = []
    rank = 0
    for evaluation in ordered:
        candidate_id = str(evaluation["candidateId"])
        verdict = verdicts.get(candidate_id)
        current_verdict = verdict if verdict and verdict.get("manifestSha256") == current_manifest_sha256 else None
        invalid = evaluation["autoStatus"] == "invalid"
        if not invalid:
            rank += 1
        lexical = evaluation.get("lexical") or {}
        contour = evaluation.get("contour") or {}
        attack = evaluation.get("attack") or {}
        audio = evaluation.get("audioMetrics") or {}
        summaries.append(
            {
                "candidateId": candidate_id,
                "seed": evaluation.get("seed"),
                "provenance": evaluation.get("provenance"),
                "requestSha256": evaluation.get("requestSha256"),
                "files": evaluation.get("files"),
                "rank": None if invalid else rank,
                "status": effective_status(evaluation, current_verdict, current_manifest_sha256),
                "autoStatus": evaluation["autoStatus"],
                "gates": evaluation.get("gates", {}),
                "shortlistFailures": evaluation.get("shortlistFailures", []),
                "invalidReasons": evaluation.get("invalidReasons", []),
                "lexical": {key: lexical.get(key) for key in ("hits", "nearMisses", "substitutions", "misses", "insertions", "lexicalScore", "sequenceRatio")},
                "metrics": {
                    "medianAttackErrorMs": attack.get("medianAttackErrorMs"),
                    "p95AttackErrorMs": attack.get("p95AttackErrorMs"),
                    "silenceBleedMs": audio.get("silenceBleedMs"),
                    "envelopeCorrelation": audio.get("envelopeCorrelation"),
                    "medianAbsPitchErrorSemitones": contour.get("medianAbsPitchErrorSemitones"),
                    "registerOffsetSemitones": contour.get("registerOffsetSemitones"),
                    "contourCorrelation": contour.get("contourCorrelation"),
                    "longestOctaveErrorMs": contour.get("longestOctaveErrorMs"),
                    "voicedOverlap": contour.get("voicedOverlap"),
                },
                "verdict": current_verdict,
            }
        )
    return summaries


def regenerate_ace_manifest(ace_dir: Path, opening_dir: Path, *, path_root: Path) -> dict:
    candidates: dict[str, Path] = {
        "request": ace_dir / "request.json",
        "lyrics": ace_dir / "lyrics.txt",
        "paddedSource": ace_dir / "source-padded-10s.wav",
        "rawClipF0": ace_dir / "raw-clip-f0.json",
        "rawSlice": opening_dir / "raw.wav",
        "renderPlan": opening_dir / "asserted-render-plan.json",
    }
    for seed in PINNED_SEEDS:
        files = seed_paths(ace_dir, seed)
        if not receipt_is_current(files["receipt"], SEED_RECEIPT_LABELS):
            continue
        candidates[f"seed{seed}Opening"] = files["opening"]
        candidates[f"seed{seed}Asr"] = files["asr"]
        candidates[f"seed{seed}Align"] = files["align"]
        candidates[f"seed{seed}F0"] = files["f0"]
        candidates[f"seed{seed}Eval"] = files["eval"]
        if files["full"].is_file():
            candidates[f"seed{seed}Full"] = files["full"]
    manifest = build_manifest({label: path for label, path in candidates.items() if path.is_file()}, path_root=path_root)
    manifest["status"] = "current"
    (ace_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def load_current_candidate_verdicts(ace_dir: Path, current_manifest_sha256: str) -> dict[str, dict]:
    verdicts: dict[str, dict] = {}
    verdict_dir = ace_dir / "verdicts"
    if not verdict_dir.is_dir():
        return verdicts
    for path in sorted(verdict_dir.glob("seed-*-verdict.json")):
        try:
            payload = load_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        if payload.get("manifestSha256") != current_manifest_sha256:
            continue
        verdicts[f"seed-{payload.get('seed')}"] = payload
    return verdicts


def declare_stop(ace_dir: Path, reason: str, rationale: str) -> Path:
    if reason not in ("lexical", "prosody"):
        raise RuntimeError(f"unknown stop reason: {reason}")
    ledger = load_json(ace_dir / "ledger.json")
    manifest_path = ace_dir / "manifest.json"
    current = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    verdicts = load_current_candidate_verdicts(ace_dir, current)
    if any(verdict.get("verdict") == "pass" for verdict in verdicts.values()):
        raise RuntimeError("a pass verdict exists for the current manifest — the lane is not blocked")
    if reason == "lexical":
        if not verdicts:
            raise RuntimeError("lexical stop requires at least one owner verdict on the current manifest")
        if not all(verdict.get("verdict") == "fail" and verdict.get("classification") == "words" for verdict in verdicts.values()):
            raise RuntimeError("lexical stop requires every verdicted candidate to be an owner fail classified 'words'")
        status = "ace_cover_lexical_blocked"
    else:
        gates_by_candidate = {str(entry.get("candidateId")): entry.get("gates", {}) for entry in ledger.get("candidates", [])}
        qualifying = [
            candidate_id
            for candidate_id, verdict in verdicts.items()
            if verdict.get("verdict") == "fail"
            and verdict.get("classification") in ("timing", "pitch/register")
            and gates_by_candidate.get(candidate_id, {}).get("lexicalFloor")
        ]
        if not qualifying:
            raise RuntimeError("prosody stop requires an owner fail on timing/pitch for a candidate that met the lexical floor")
        status = "ace_cover_prosody_blocked"
    payload = {
        "status": status,
        "declaredAt": _now_iso(),
        "manifestSha256": current,
        "rationale": rationale,
        "candidates": [
            {"candidateId": entry.get("candidateId"), "seed": entry.get("seed"), "status": entry.get("status"), "ownerVerdict": verdicts.get(str(entry.get("candidateId")))}
            for entry in ledger.get("candidates", [])
        ],
        "publishedToReviewPage": True,
    }
    target = ace_dir / "lane-status.json"
    dump_json(target, payload)
    return target


# --- impure pipeline ----------------------------------------------------------


def _git_rev(root: Path) -> str:
    result = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"could not read ACE git rev: {result.stderr.strip()}")
    return result.stdout.strip()


def _blob_identity(path: Path) -> dict:
    resolved = path.resolve()
    stat = resolved.stat()
    if re.fullmatch(r"[0-9a-f]{64}", resolved.name):
        return {"bytes": stat.st_size, "sha256": resolved.name, "provenance": "hf-blob-symlink"}
    return {"bytes": stat.st_size, "sha256": hashlib.sha256(resolved.read_bytes()).hexdigest(), "provenance": "sha256-file"}


def _checkpoint_identity() -> dict:
    checkpoint_dir = ACE_ROOT / "checkpoints" / CHECKPOINT_NAME
    vae_dir = ACE_ROOT / "checkpoints" / "vae"
    vae_weights = next(iter(sorted(vae_dir.glob("*.safetensors"))), None)
    identity = {
        "name": CHECKPOINT_NAME,
        "config": _blob_identity(checkpoint_dir / "config.json"),
        "model": _blob_identity(checkpoint_dir / "model.safetensors"),
    }
    if vae_weights is not None:
        identity["vae"] = _blob_identity(vae_weights)
    return identity


def _wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as handle:
        return handle.getnframes() / handle.getframerate()


def _guards(paths: Paths, plan: dict) -> None:
    problems: list[str] = []
    if not ACE_PY.is_file():
        problems.append(f"ACE venv python missing: {ACE_PY}")
    checkpoint_dir = ACE_ROOT / "checkpoints" / CHECKPOINT_NAME
    for name in ("config.json", "model.safetensors", "silence_latent.pt"):
        if not (checkpoint_dir / name).exists():
            problems.append(f"checkpoint file missing: {checkpoint_dir / name}")
    try:
        _git_rev(ACE_ROOT)
    except RuntimeError as error:
        problems.append(str(error))
    free = shutil.disk_usage(str(paths.root)).free
    if free < MIN_FREE_DISK_BYTES:
        problems.append(f"free disk {free / 1024**3:.1f} GiB below the 8 GiB floor")
    for label, path in (("raw opening slice", paths.opening / "raw.wav"), ("render plan", paths.opening / "asserted-render-plan.json")):
        if not path.is_file():
            problems.append(f"{label} missing: {path}")
    for label, path in (("whisper venv", WHISPER_PY), ("skeleton venv", SKELETON_PY), ("SoulX venv", SOULX_PY)):
        if not path.is_file():
            problems.append(f"{label} missing: {path}")
    legacy_lyrics = paths.opening / LEGACY_DIR_NAME / "lyrics.txt"
    if legacy_lyrics.is_file() and lyrics_words(legacy_lyrics.read_text(encoding="utf-8")) != lyrics_words(OPENING_LYRICS):
        problems.append(f"legacy lyrics disagree with the pinned lyrics: {legacy_lyrics}")
    if problems:
        raise RuntimeError("ace-cover-spike guards failed:\n- " + "\n- ".join(problems))
    validate_lyrics_against_plan(OPENING_LYRICS, plan)


def ensure_raw_clip_f0(ace_dir: Path, opening_dir: Path) -> Path:
    output = ace_dir / "raw-clip-f0.json"
    receipt = ace_dir / "raw-clip-f0-receipt.json"
    if receipt_is_current(receipt, frozenset({"rawSlice", "output"})):
        return output
    run([str(SOULX_PY), str(WORKER), "f0", str(opening_dir / "raw.wav"), str(output)], cwd=BRIDGE)
    write_receipt(receipt, {"rawSlice": opening_dir / "raw.wav", "output": output})
    return output


def _ensure_padded_source(ace_dir: Path, opening_dir: Path) -> Path:
    output = ace_dir / "source-padded-10s.wav"
    receipt = ace_dir / "padded-source-receipt.json"
    if receipt_is_current(receipt, frozenset({"rawSlice", "output"})):
        return output
    convert_audio(opening_dir / "raw.wav", output, channels=2, sample_rate=48000, pad_to_s=10.0)
    write_receipt(receipt, {"rawSlice": opening_dir / "raw.wav", "output": output})
    return output


def _register_legacy(opening_dir: Path, path_root: Path) -> dict:
    legacy_dir = opening_dir / LEGACY_DIR_NAME
    if not legacy_dir.is_dir():
        return {"note": "no ad-hoc ace-step-spike directory found", "unattributed": []}
    entries = []
    for path in sorted(legacy_dir.iterdir()):
        if not path.is_file():
            continue
        note = "ad-hoc seed-42 artifact (imported as candidate seed-42)" if path.name.startswith("cover-seed42") else "unattributed legacy output; seed not guessed"
        entries.append(
            {
                "originalPath": os.path.relpath(path, path_root),
                "bytes": path.stat().st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "note": note,
            }
        )
    return {"note": "pre-spike ad-hoc artifacts, registered for provenance only", "unattributed": entries}


def _evaluate_seed(paths: Paths, ace_dir: Path, plan: dict, seed: int, *, provenance: str, request_hash: str | None, raw_clip_f0: list, imported_source: Path | None = None) -> dict:
    files = seed_paths(ace_dir, seed)
    opening_wav = files["opening"]
    expected_words = [str(word["text"]) for word in plan["words"]]
    duration_s: float | None = None
    try:
        duration_s = round(_wav_duration(opening_wav), 4)
    except (OSError, wave.Error, EOFError):
        duration_s = None

    lexical = None
    try:
        asr = run_json([str(WHISPER_PY), str(REPO / "service/whisper/whisper_cli.py"), str(opening_wav), "small"], timeout=1800)
    except RuntimeError as error:
        asr = {"ok": False, "error": str(error)}
    dump_json(files["asr"], asr)
    if asr.get("ok"):
        lexical = score_lexical(expected_words, [str(word.get("word", "")) for word in asr.get("words", [])])

    aligned = None
    try:
        with tempfile.TemporaryDirectory() as temporary:
            wav16k = Path(temporary) / "candidate-16k.wav"
            tokens_path = Path(temporary) / "tokens.json"
            convert_audio(opening_wav, wav16k, sample_rate=16000)
            dump_json(tokens_path, [{"text": text} for text in expected_words])
            run([str(SKELETON_PY), str(WORKER), "align", str(wav16k), str(tokens_path), str(files["align"])])
        aligned_payload = load_json(files["align"])
        aligned = aligned_payload if isinstance(aligned_payload, list) else None
    except (RuntimeError, OSError, json.JSONDecodeError) as error:
        dump_json(files["align"], {"ok": False, "error": str(error)})

    cand_f0 = None
    try:
        run([str(SOULX_PY), str(WORKER), "f0", str(opening_wav), str(files["f0"])], cwd=BRIDGE)
        cand_f0 = load_json(files["f0"])
    except (RuntimeError, OSError, json.JSONDecodeError) as error:
        dump_json(files["f0"], {"ok": False, "error": str(error)})

    audio_metrics = None
    try:
        audio_metrics = compare_audio(plan, paths.opening / "raw.wav", opening_wav, cand_f0 or [])
        audio_metrics["lane"] = "ace-step-turbo-cover"
    except (RuntimeError, OSError, wave.Error, EOFError):
        audio_metrics = None

    evaluation = evaluate_candidate(
        candidate_id=f"seed-{seed}",
        plan=plan,
        lexical=lexical,
        contour=compare_f0_contours(raw_clip_f0, cand_f0) if cand_f0 is not None else None,
        attack=attack_errors_from_alignment(plan, aligned) if aligned is not None else None,
        audio_metrics=audio_metrics,
        duration_s=duration_s,
    )
    evaluation["seed"] = seed
    evaluation["provenance"] = provenance
    evaluation["requestSha256"] = request_hash
    evaluation["files"] = {key: files[key].name for key in ("full", "opening", "asr", "align", "f0", "eval") if files[key].is_file() or key != "full"}
    evaluation["generatedAt"] = _now_iso()
    dump_json(files["eval"], evaluation)

    receipt_files = {
        "request": ace_dir / "request.json",
        "rawSlice": paths.opening / "raw.wav",
        "rawClipF0": ace_dir / "raw-clip-f0.json",
        "output": opening_wav,
        "asr": files["asr"],
        "align": files["align"],
        "renderedF0": files["f0"],
        "eval": files["eval"],
    }
    if imported_source is not None:
        receipt_files["importedSource"] = imported_source
    else:
        receipt_files["full"] = files["full"]
        receipt_files["paddedSource"] = ace_dir / "source-padded-10s.wav"
    write_receipt(files["receipt"], receipt_files)
    return evaluation


def run_ace_cover_spike(paths: Paths, *, dry_run: bool = False) -> Path:
    opening_dir = paths.opening
    ace_dir = ace_dir_for(paths)
    plan = load_json(opening_dir / "asserted-render-plan.json")
    _guards(paths, plan)
    ace_dir.mkdir(parents=True, exist_ok=True)

    lyrics_path = ace_dir / "lyrics.txt"
    if not lyrics_path.is_file() or lyrics_path.read_text(encoding="utf-8") != OPENING_LYRICS:
        lyrics_path.write_text(OPENING_LYRICS, encoding="utf-8")

    padded = _ensure_padded_source(ace_dir, opening_dir)
    source_hashes = build_manifest(
        {"rawSlice": opening_dir / "raw.wav", "renderPlan": opening_dir / "asserted-render-plan.json", "paddedSource": padded},
        path_root=paths.root,
    )["files"]
    request = build_ace_request(
        plan=plan,
        lyrics_text=OPENING_LYRICS,
        source_hashes=source_hashes,
        ace_git_rev=_git_rev(ACE_ROOT),
        checkpoint=_checkpoint_identity(),
        seeds=list(PINNED_SEEDS),
    )
    request, request_changed = write_request_if_changed(ace_dir / "request.json", request, now_iso=_now_iso())
    current_hash = request["requestSha256"]

    ledger_path = ace_dir / "ledger.json"
    ledger = load_json(ledger_path) if ledger_path.is_file() else {"candidates": []}
    work = plan_seed_work(ledger, current_hash, ace_dir)
    seed42_files = seed_paths(ace_dir, 42)
    legacy_seed42 = opening_dir / LEGACY_DIR_NAME / "cover-seed42-opening.wav"
    seed42_current = receipt_is_current(seed42_files["receipt"], IMPORTED_RECEIPT_LABELS)

    if dry_run:
        print(f"request {'CHANGED' if request_changed else 'unchanged'} requestSha256={current_hash}")
        print(f"seeds to generate: {work or 'none'}")
        print(f"seed 42 import: {'current' if seed42_current else f'will import from {legacy_seed42}'}")
        return ace_dir

    generation_failures: list[dict] = []
    if work:
        worker_request = build_worker_request(request, root=paths.root, seeds=work, save_dir=ace_dir / "worker-out")
        dump_json(ace_dir / "worker-request.json", worker_request)
        run([str(ACE_PY), str(ACE_WORKER), "--request", str(ace_dir / "worker-request.json"), "--output", str(ace_dir / "worker-result.json")], cwd=ACE_ROOT, timeout=7200)
        worker_result = load_json(ace_dir / "worker-result.json")
        results_by_seed = {int(entry["seed"]): entry for entry in worker_result.get("results", [])}
        clip_duration = float(plan["clip"]["end"]) - float(plan["clip"]["start"])
        for seed in work:
            entry = results_by_seed.get(seed)
            if not entry or not entry.get("ok"):
                generation_failures.append({"seed": seed, "error": (entry or {}).get("error") or "worker returned no result", "timeCosts": (entry or {}).get("timeCosts")})
                continue
            files = seed_paths(ace_dir, seed)
            shutil.move(entry["audioPath"], files["full"])
            convert_audio(files["full"], files["opening"], start=0.0, duration=clip_duration)

    if not seed42_current and not legacy_seed42.is_file():
        raise RuntimeError(f"seed-42 import source missing: {legacy_seed42}")
    if not seed42_current:
        shutil.copyfile(legacy_seed42, seed42_files["opening"])

    raw_clip_f0 = load_json(ensure_raw_clip_f0(ace_dir, opening_dir))
    failed_seeds = {failure["seed"] for failure in generation_failures}
    evaluations: list[dict] = []
    for seed in PINNED_SEEDS:
        if seed in failed_seeds:
            continue
        files = seed_paths(ace_dir, seed)
        imported = seed in IMPORTED_SEEDS
        labels = IMPORTED_RECEIPT_LABELS if imported else SEED_RECEIPT_LABELS
        if receipt_is_current(files["receipt"], labels):
            evaluations.append(load_json(files["eval"]))
            continue
        if not files["opening"].is_file():
            generation_failures.append({"seed": seed, "error": "no candidate audio on disk", "timeCosts": None})
            continue
        evaluations.append(
            _evaluate_seed(
                paths,
                ace_dir,
                plan,
                seed,
                provenance="imported-ad-hoc" if imported else "pinned-config",
                request_hash=None if imported else current_hash,
                raw_clip_f0=raw_clip_f0,
                imported_source=legacy_seed42 if imported else None,
            )
        )

    manifest = regenerate_ace_manifest(ace_dir, opening_dir, path_root=paths.root)
    manifest_hash = hashlib.sha256((ace_dir / "manifest.json").read_bytes()).hexdigest()
    verdicts = load_current_candidate_verdicts(ace_dir, manifest_hash)
    summaries = candidate_summaries(evaluations, verdicts, manifest_hash)
    for failure in generation_failures:
        summaries.append(
            {
                "candidateId": f"seed-{failure['seed']}",
                "seed": failure["seed"],
                "provenance": "pinned-config",
                "requestSha256": current_hash,
                "files": {},
                "rank": None,
                "status": "invalid",
                "autoStatus": "invalid",
                "gates": {},
                "shortlistFailures": [],
                "invalidReasons": [f"generation failed: {failure['error']}"],
                "lexical": {},
                "metrics": {},
                "verdict": None,
            }
        )
    ledger = {
        "version": 1,
        "updatedAt": _now_iso(),
        "requestSha256": current_hash,
        "manifestSha256": manifest_hash,
        "candidates": summaries,
        "legacy": _register_legacy(opening_dir, paths.root),
    }
    dump_json(ledger_path, ledger)
    return ace_dir
