from __future__ import annotations

import json
import math
import os
import re
import subprocess
import sys
from difflib import SequenceMatcher
from dataclasses import dataclass
from pathlib import Path

from asserted_proof_alignment import expand_alignment
from asserted_proof_clip import contained_pairs
from asserted_proof_manifest import regenerate_manifest
from asserted_proof_lexical import assemble_pcm16_mono, build_lexical_targets
from asserted_proof_metrics import compare_audio
from asserted_proof_plan import apply_articulation_heuristics, articulation_relaxed_plan, author_soulx_score, build_manifest, build_render_plan, flatten_corrected_words, repair_word_articulation_plan
from asserted_proof_provenance import write_receipt
from asserted_proof_score import chunk_score
from asserted_proof_splice import splice_pcm16_mono
from asserted_proof_verdict import validate_owner_verdict, validate_review_verdict

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
WORKER = HERE / "asserted_proof_worker.py"
SKELETON_PY = Path("~/Library/Mosh/venvs/skeleton/bin/python").expanduser()
PHONOLOGY_PY = Path("~/Library/Mosh/venvs/phonology/bin/python").expanduser()
SOULX_ROOT = Path(os.path.expanduser(os.environ.get("SOULX_MAC_DIR", "~/AI/soulx-mac")))
SOULX_PY = SOULX_ROOT / "venv/bin/python"
BRIDGE = SOULX_ROOT / "SoulX-Singer-MLX"
MODEL = BRIDGE / "models/SoulX-Singer-bf16"
PHONESET = BRIDGE / "soulxsinger/utils/phoneme/phone_set.json"
WHISPER_PY = Path("~/Library/Mosh/venvs/whisper/bin/python").expanduser()
RUBBERBAND = Path("/opt/homebrew/bin/rubberband")


@dataclass(frozen=True, slots=True)
class Paths:
    root: Path
    output: Path
    opening: Path
    raw_audio: Path
    corrected: Path
    baseline_alignment: Path
    split: Path
    prompt_wav: Path
    prompt_json: Path

    @classmethod
    def from_root(cls, root: Path) -> "Paths":
        output = root / "asserted-proof"
        full_song = root / "full-song"
        return cls(root, output, output / "opening", root / "nofx.wav", root / "nofx-whisper-corrected.json", root / "nofx-aligned-corrected.json", root / "used2-split.json", full_song / "prompt.wav", full_song / "prompt.json")


def load_json(path: Path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def dump_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2)


def run(command: list[str], *, cwd: Path | None = None, timeout: int = 3600) -> None:
    result = subprocess.run(command, cwd=str(cwd) if cwd else None, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout)[-4000:]
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(command)}\n{detail}")


def run_json(command: list[str], *, cwd: Path | None = None, timeout: int = 3600) -> dict:
    result = subprocess.run(command, cwd=str(cwd) if cwd else None, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout)[-4000:]
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(command)}\n{detail}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"command returned invalid JSON: {' '.join(command)}") from error


def read_envelope(path: Path, hop_s: float = 0.01) -> list[float]:
    service = str(REPO / "service")
    if service not in sys.path:
        sys.path.insert(0, service)
    from skeleton import core

    pcm = core.read_pcm_mono(str(path))
    if pcm is None:
        raise RuntimeError(f"could not decode envelope source: {path}")
    mono, sample_rate = pcm
    return core.energy_envelope(mono, sample_rate, hop_ms=hop_s * 1000.0)


def convert_audio(source: Path, output: Path, *, start: float | None = None, duration: float | None = None) -> None:
    command = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    if start is not None:
        command.extend(["-ss", str(start)])
    command.extend(["-i", str(source)])
    if duration is not None:
        command.extend(["-t", str(duration)])
    command.extend(["-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", str(output)])
    output.parent.mkdir(parents=True, exist_ok=True)
    run(command)


def _regenerate_manifest(paths: Paths, clip_id: str) -> dict:
    base_files = {
        "rawAudio": paths.raw_audio,
        "correctedTranscript": paths.corrected,
        "baselineAlignment": paths.baseline_alignment,
        "splitMetadata": paths.split,
        "promptAudio": paths.prompt_wav,
        "promptMetadata": paths.prompt_json,
        "assertion": paths.output / "asserted-first-half-tokens.json",
        "assertedSourceAudio": paths.output / "asserted-first-half-source.wav",
        "assertedAlignment": paths.output / "asserted-first-half-aligned.json",
        "pronunciations": paths.output / "pronunciations.json",
        "rawF0": paths.output / "raw-f0.json",
    }
    return regenerate_manifest(base_files, paths.output / clip_id)


def build_opening(paths: Paths) -> dict:
    corrected, split = load_json(paths.corrected), load_json(paths.split)
    tokens = flatten_corrected_words(corrected, int(split["split_word_idx"]))
    if len(tokens) != 127:
        raise RuntimeError(f"expected 127 asserted lexical tokens through Truman, got {len(tokens)}")
    if tokens[-1]["normalized"] != "truman":
        raise RuntimeError("asserted first half does not end at Truman")
    tokens_path = paths.output / "asserted-first-half-tokens.json"
    alignment_path = paths.output / "asserted-first-half-aligned.json"
    phones_path = paths.output / "pronunciations.json"
    f0_path = paths.output / "raw-f0.json"
    asserted_audio = paths.output / "asserted-first-half-source.wav"
    dump_json(tokens_path, tokens)
    convert_audio(paths.raw_audio, asserted_audio, start=0.0, duration=55.60)
    aligned = expand_alignment(raw_audio=paths.raw_audio, corrected=corrected, split_word_idx=int(split["split_word_idx"]), baseline=load_json(paths.baseline_alignment), tokens=tokens, worker=WORKER, skeleton_python=SKELETON_PY)
    dump_json(alignment_path, aligned)
    run([str(PHONOLOGY_PY), str(WORKER), "phones", str(tokens_path), str(phones_path)])
    run([str(SOULX_PY), str(WORKER), "f0", str(asserted_audio), str(f0_path)], cwd=BRIDGE)
    truman = aligned[-1]
    if abs(float(truman["start"]) - 55.1126) > 0.02 or abs(float(truman["end"]) - 55.34) > 0.02:
        raise RuntimeError(f"Truman timing drifted: {truman}")
    return build_clip(paths, "opening", 0.35, 7.90)


def build_clip(paths: Paths, clip_id: str, clip_start: float, clip_end: float, *, articulation_heuristics: bool = False) -> dict:
    clip_dir = paths.output / clip_id
    clip_dir.mkdir(parents=True, exist_ok=True)
    tokens = load_json(paths.output / "asserted-first-half-tokens.json")
    aligned = load_json(paths.output / "asserted-first-half-aligned.json")
    selected = contained_pairs(tokens, aligned, clip_start=clip_start, clip_end=clip_end)
    plan = build_render_plan(
        clip_id=clip_id,
        clip_start=clip_start,
        clip_end=clip_end,
        tokens=[item[0] for item in selected],
        aligned=[item[1] for item in selected],
        pronunciations=load_json(paths.output / "pronunciations.json"),
        f0=load_json(paths.output / "raw-f0.json"),
        envelope=read_envelope(paths.raw_audio),
        envelope_hop_s=0.01,
    )
    if articulation_heuristics:
        plan = apply_articulation_heuristics(plan)
    truman = aligned[-1]
    plan["sourceSummary"] = {"correctedLexicalTokens": len(tokens), "alignedLexicalTokens": len(aligned), "splitWord": "Truman", "splitAlignedStart": float(truman["start"]), "splitAlignedEnd": float(truman["end"])}
    source_files = {
        "rawAudio": paths.raw_audio,
        "correctedTranscript": paths.corrected,
        "baselineAlignment": paths.baseline_alignment,
        "splitMetadata": paths.split,
        "assertion": paths.output / "asserted-first-half-tokens.json",
        "assertedAlignment": paths.output / "asserted-first-half-aligned.json",
        "pronunciations": paths.output / "pronunciations.json",
        "rawF0": paths.output / "raw-f0.json",
        "promptAudio": paths.prompt_wav,
        "promptMetadata": paths.prompt_json,
    }
    plan["sourceHashes"] = build_manifest(source_files, path_root=paths.root)["files"]
    dump_json(clip_dir / "asserted-render-plan.json", plan)
    score = author_soulx_score(plan, f"used2-asserted-{clip_id}")
    dump_json(clip_dir / "soulx-score.json", chunk_score(score) if clip_end - clip_start > 12.0 else score)
    convert_audio(paths.raw_audio, clip_dir / "raw.wav", start=clip_start, duration=clip_end - clip_start)
    _regenerate_manifest(paths, clip_id)
    return plan


def render_guide(paths: Paths, attempt: int, clip_id: str = "opening") -> Path:
    clip_dir = paths.output / clip_id
    plan = load_json(clip_dir / "asserted-render-plan.json")
    plan_path = clip_dir / "asserted-render-plan.json"
    target = clip_dir / "soulx-score.json"
    output = clip_dir / "guide.wav"
    metrics_path = clip_dir / "metrics.json"
    receipt = clip_dir / "guide-receipt.json"
    if attempt == 2:
        plan = articulation_relaxed_plan(plan)
        plan_path = clip_dir / "asserted-render-plan-articulation-relaxed.json"
        dump_json(plan_path, plan)
        target = clip_dir / "soulx-score-articulation-relaxed.json"
        score = author_soulx_score(plan, f"used2-asserted-{clip_id}-relaxed")
        dump_json(target, chunk_score(score) if float(plan["clip"]["end"]) - float(plan["clip"]["start"]) > 12.0 else score)
        output = clip_dir / "guide-articulation-relaxed.wav"
        metrics_path = clip_dir / "metrics-articulation-relaxed.json"
        receipt = clip_dir / "guide-articulation-relaxed-receipt.json"
    elif attempt == 3:
        if clip_id != "opening":
            raise RuntimeError("word-duration repair is defined only for the opening proof")
        plan = repair_word_articulation_plan(
            plan,
            owner_id="src-9-0",
            minimum_duration_s=0.14,
            trailing_guard_s=0.06,
        )
        plan_path = clip_dir / "asserted-render-plan-word-repair.json"
        dump_json(plan_path, plan)
        target = clip_dir / "soulx-score-word-repair.json"
        dump_json(target, author_soulx_score(plan, f"used2-asserted-{clip_id}-word-repair"))
        output = clip_dir / "guide-word-repair.wav"
        metrics_path = clip_dir / "metrics-word-repair.json"
        receipt = clip_dir / "guide-word-repair-receipt.json"
    render_dir = clip_dir / f"soulx-render-{attempt}"
    render_dir.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ, PYTHONPATH=str(BRIDGE), PYTORCH_ENABLE_MPS_FALLBACK="1", NUMBA_DISABLE_COVERAGE="1")
    command = [str(SOULX_PY), str(BRIDGE / "scripts/inference_mlx_bridge.py"), "--model", str(MODEL), "--component", "svs", "--control", "score", "--device", "mps", "--prompt_wav_path", str(paths.prompt_wav), "--prompt_metadata_path", str(paths.prompt_json), "--target_metadata_path", str(target), "--phoneset_path", str(PHONESET), "--n_steps", "32", "--cfg", "3.0", "--pitch_shift", "0", "--save_dir", str(render_dir)]
    result = subprocess.run(command, cwd=str(BRIDGE), env=environment, capture_output=True, text=True, timeout=3600)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout)[-4000:])
    convert_audio(render_dir / "generated.wav", output)
    rendered_f0_path = clip_dir / f"guide-{attempt}-f0.json"
    run([str(SOULX_PY), str(WORKER), "f0", str(output), str(rendered_f0_path)], cwd=BRIDGE)
    metrics = compare_audio(plan, clip_dir / "raw.wav", output, load_json(rendered_f0_path))
    metrics["attempt"] = attempt
    dump_json(metrics_path, metrics)
    write_receipt(receipt, {"renderPlan": plan_path, "targetScore": target, "promptAudio": paths.prompt_wav, "promptMetadata": paths.prompt_json, "output": output, "renderedF0": rendered_f0_path, "metrics": metrics_path})
    _regenerate_manifest(paths, clip_id)
    return output


def render_svc(paths: Paths, guide: Path, clip_id: str = "opening") -> Path:
    clip_dir = paths.output / clip_id
    temporary = clip_dir / "svc-generated.wav"
    run([str(SOULX_PY), str(HERE / "svc_render.py"), "--guide", str(guide), "--ref", str(paths.prompt_wav), "--out", str(temporary), "--n_steps", "32", "--cfg", "3.0"], cwd=BRIDGE)
    output = clip_dir / "svc.wav"
    convert_audio(temporary, output)
    temporary.unlink(missing_ok=True)
    rendered_f0_path = clip_dir / "svc-f0.json"
    run([str(SOULX_PY), str(WORKER), "f0", str(output), str(rendered_f0_path)], cwd=BRIDGE)
    metrics = compare_audio(load_json(clip_dir / "asserted-render-plan.json"), clip_dir / "raw.wav", output, load_json(rendered_f0_path))
    metrics["lane"] = "svc-over-generated-guide"
    metrics_path = clip_dir / "metrics-svc.json"
    dump_json(metrics_path, metrics)
    write_receipt(clip_dir / "svc-receipt.json", {"renderPlan": clip_dir / "asserted-render-plan.json", "guide": guide, "promptAudio": paths.prompt_wav, "output": output, "renderedF0": rendered_f0_path, "metrics": metrics_path})
    _regenerate_manifest(paths, clip_id)
    return output


def build_local_repair(paths: Paths) -> Path:
    clip_dir = paths.opening
    output = clip_dir / "guide-word-repair-local.wav"
    metadata_path = clip_dir / "guide-word-repair-local.json"
    metadata = splice_pcm16_mono(
        clip_dir / "guide.wav",
        clip_dir / "guide-word-repair.wav",
        output,
        patch_start_s=4.46,
        patch_end_s=5.28,
        crossfade_s=0.04,
    )
    metadata.update(
        {
            "policy": "immutable-baseline-local-phrase-repair",
            "clipStartS": 0.35,
            "absolutePatchStartS": 4.81,
            "absolutePatchEndS": 5.63,
            "targetWords": ["in", "the", "night"],
        }
    )
    dump_json(metadata_path, metadata)
    rendered_f0_path = clip_dir / "guide-word-repair-local-f0.json"
    run([str(SOULX_PY), str(WORKER), "f0", str(output), str(rendered_f0_path)], cwd=BRIDGE)
    repair_plan = clip_dir / "asserted-render-plan-word-repair.json"
    metrics = compare_audio(load_json(repair_plan), clip_dir / "raw.wav", output, load_json(rendered_f0_path))
    metrics["lane"] = "immutable-baseline-local-phrase-repair"
    metrics["outsidePatchChangedSamples"] = metadata["outsidePatchChangedSamples"]
    metrics_path = clip_dir / "metrics-word-repair-local.json"
    dump_json(metrics_path, metrics)
    write_receipt(
        clip_dir / "guide-word-repair-local-receipt.json",
        {
            "baseline": clip_dir / "guide.wav",
            "replacement": clip_dir / "guide-word-repair.wav",
            "renderPlan": repair_plan,
            "metadata": metadata_path,
            "output": output,
            "renderedF0": rendered_f0_path,
            "metrics": metrics_path,
        },
    )
    _regenerate_manifest(paths, "opening")
    return output


def _normalize_asr_word(value: str) -> str:
    return re.sub(r"[^a-z0-9']", "", value.lower())


def _asr_diagnostic(audio: Path, targets: list[dict]) -> dict:
    result = run_json([str(WHISPER_PY), str(REPO / "service/whisper/whisper_cli.py"), str(audio), "small"])
    heard = [_normalize_asr_word(str(word.get("word", ""))) for word in result.get("words", [])]
    heard = [word for word in heard if word]
    expected = [_normalize_asr_word(str(target["text"])) for target in targets]
    phrase = ["in", "the", "night"]
    phrase_present = any(heard[index : index + len(phrase)] == phrase for index in range(len(heard) - len(phrase) + 1))
    return {
        "ok": bool(result.get("ok")),
        "expected": expected,
        "heard": heard,
        "sequenceRatio": SequenceMatcher(a=expected, b=heard, autojunk=False).ratio(),
        "requiredPhrase": phrase,
        "requiredPhrasePresent": phrase_present,
        "words": result.get("words", []),
    }


def build_lexical_pivot(paths: Paths) -> tuple[Path, Path]:
    clip_dir = paths.opening
    plan_path = clip_dir / "asserted-render-plan.json"
    plan = load_json(plan_path)
    targets = build_lexical_targets(plan)
    lexical_dir = clip_dir / "lexical"
    lexical_dir.mkdir(parents=True, exist_ok=True)
    clip_start = float(plan["clip"]["start"])
    duration = float(plan["clip"]["end"]) - clip_start
    unpitched_segments = []
    for target in targets:
        stem = str(target["ownerId"])
        source_aiff = lexical_dir / f"{stem}-source.aiff"
        source_wav = lexical_dir / f"{stem}-source.wav"
        stretched_temp = lexical_dir / f"{stem}-stretched-temp.wav"
        stretched = lexical_dir / f"{stem}-stretched.wav"
        run(["say", "-v", "Alex", "-r", "190", "-o", str(source_aiff), str(target["ttsText"])])
        run(
            [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(source_aiff),
                "-af",
                "silenceremove=start_periods=1:start_duration=0.01:start_threshold=-45dB:stop_periods=1:stop_duration=0.03:stop_threshold=-45dB",
                "-ac",
                "1",
                "-ar",
                "24000",
                "-c:a",
                "pcm_s16le",
                str(source_wav),
            ]
        )
        run([str(RUBBERBAND), "-q", "-3", "-F", "-D", f"{target['duration']:.6f}", str(source_wav), str(stretched_temp)])
        run(
            [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(stretched_temp),
                "-af",
                f"apad,atrim=0:{target['duration']:.6f}",
                "-ac",
                "1",
                "-ar",
                "24000",
                "-c:a",
                "pcm_s16le",
                str(stretched),
            ]
        )
        unpitched_segments.append({"path": stretched, "start": target["start"] - clip_start, "end": target["end"] - clip_start, "ownerId": target["ownerId"]})

    unpitched = clip_dir / "lexical-guide-unpitched.wav"
    assemble_pcm16_mono(unpitched_segments, unpitched, duration_s=duration)
    unpitched_f0_path = clip_dir / "lexical-guide-unpitched-f0.json"
    run([str(SOULX_PY), str(WORKER), "f0", str(unpitched), str(unpitched_f0_path)], cwd=BRIDGE)
    unpitched_f0 = load_json(unpitched_f0_path)

    pitched_segments = []
    target_metadata = []
    for target, unpitched_segment in zip(targets, unpitched_segments):
        local_start, local_end = float(unpitched_segment["start"]), float(unpitched_segment["end"])
        voiced = [float(point["hz"]) for point in unpitched_f0 if local_start <= float(point["t"]) <= local_end and float(point["hz"]) > 0]
        if not voiced:
            raise RuntimeError(f"deterministic lexical guide has no measured source pitch: {target['ownerId']}")
        source_hz = sorted(voiced)[len(voiced) // 2]
        source_midi = 69.0 + 12.0 * math.log2(source_hz / 440.0)
        requested_shift = float(target["targetMidi"]) - source_midi
        shift = max(-7.0, min(7.0, requested_shift))
        pitched_temp = lexical_dir / f"{target['ownerId']}-pitched-temp.wav"
        pitched = lexical_dir / f"{target['ownerId']}-pitched.wav"
        run([str(RUBBERBAND), "-q", "-3", "-F", "-p", f"{shift:.6f}", str(unpitched_segment["path"]), str(pitched_temp)])
        run(
            [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(pitched_temp),
                "-af",
                f"apad,atrim=0:{target['duration']:.6f}",
                "-ac",
                "1",
                "-ar",
                "24000",
                "-c:a",
                "pcm_s16le",
                str(pitched),
            ]
        )
        pitched_segments.append({"path": pitched, "start": local_start, "end": local_end, "ownerId": target["ownerId"]})
        target_metadata.append(
            {
                **target,
                "sourcePitchHz": source_hz,
                "sourceMidi": source_midi,
                "requestedSemitoneShift": requested_shift,
                "appliedSemitoneShift": shift,
                "pitchLimitSemitones": 7.0,
                "sourcePitchProvenance": "measured-rmvpe",
            }
        )

    guide = clip_dir / "lexical-guide.wav"
    assembly = assemble_pcm16_mono(pitched_segments, guide, duration_s=duration)
    metadata_path = clip_dir / "lexical-guide.json"
    dump_json(metadata_path, {"version": 1, "voice": "Alex", "rate": 190, "targets": target_metadata, "assembly": assembly})
    guide_f0_path = clip_dir / "lexical-guide-f0.json"
    run([str(SOULX_PY), str(WORKER), "f0", str(guide), str(guide_f0_path)], cwd=BRIDGE)
    metrics_path = clip_dir / "metrics-lexical-guide.json"
    metrics = compare_audio(plan, clip_dir / "raw.wav", guide, load_json(guide_f0_path))
    metrics["lane"] = "deterministic-tts-word-guide"
    dump_json(metrics_path, metrics)
    asr_path = clip_dir / "lexical-guide-asr.json"
    asr = _asr_diagnostic(guide, targets)
    asr["exactSequence"] = asr["expected"] == asr["heard"]
    dump_json(asr_path, asr)
    if not asr["exactSequence"] or not asr["requiredPhrasePresent"]:
        raise RuntimeError(f"deterministic lexical guide failed lexical gate: heard={' '.join(asr['heard'])}")
    write_receipt(
        clip_dir / "lexical-guide-receipt.json",
        {"renderPlan": plan_path, "unpitched": unpitched, "unpitchedF0": unpitched_f0_path, "metadata": metadata_path, "output": guide, "renderedF0": guide_f0_path, "metrics": metrics_path, "asr": asr_path},
    )
    _regenerate_manifest(paths, "opening")

    svc = clip_dir / "lexical-svc.wav"
    run([str(SOULX_PY), str(HERE / "svc_render.py"), "--guide", str(guide), "--ref", str(paths.prompt_wav), "--out", str(svc), "--n_steps", "32", "--cfg", "3.0"], cwd=BRIDGE)
    svc_f0_path = clip_dir / "lexical-svc-f0.json"
    run([str(SOULX_PY), str(WORKER), "f0", str(svc), str(svc_f0_path)], cwd=BRIDGE)
    svc_metrics_path = clip_dir / "metrics-lexical-svc.json"
    svc_metrics = compare_audio(plan, clip_dir / "raw.wav", svc, load_json(svc_f0_path))
    svc_metrics["lane"] = "svc-over-deterministic-lexical-guide"
    dump_json(svc_metrics_path, svc_metrics)
    svc_asr_path = clip_dir / "lexical-svc-asr.json"
    dump_json(svc_asr_path, _asr_diagnostic(svc, targets))
    write_receipt(
        clip_dir / "lexical-svc-receipt.json",
        {"guide": guide, "promptAudio": paths.prompt_wav, "output": svc, "renderedF0": svc_f0_path, "metrics": svc_metrics_path, "asr": svc_asr_path},
    )
    _regenerate_manifest(paths, "opening")
    return guide, svc


def expand_first_half(paths: Paths, verdict_path: Path, *, allow_close_diagnostic: bool = False) -> list[Path]:
    verdict = load_json(verdict_path)
    if allow_close_diagnostic:
        validate_review_verdict(verdict, paths.opening / "manifest.json")
        if verdict.get("clip") != "opening" or verdict.get("verdict") not in {"pass", "close but revise"}:
            raise RuntimeError("diagnostic first-half expansion requires pass or close but revise")
        current_manifest_hash = verdict["manifestSha256"]
        verdict_matches_current = True
    else:
        validate_owner_verdict(verdict, paths.opening / "manifest.json")
        current_manifest_hash = verdict["manifestSha256"]
        verdict_matches_current = True
    dump_json(
        paths.output / "first-half-expansion.json",
        {
            "mode": "diagnostic-after-close" if allow_close_diagnostic else "owner-pass",
            "openingVerdict": verdict,
            "currentOpeningManifestSha256": current_manifest_hash,
            "verdictMatchesCurrentManifest": verdict_matches_current,
            "acceptanceGateBypassed": allow_close_diagnostic,
            "articulationHeuristic": "dh-schwa-vowel-weight",
        },
    )
    outputs: list[Path] = []
    for clip_id, start, end in (("middle", 17.60, 29.60), ("truman-lead", 43.80, 55.60), ("first-half-continuous", 0.0, 55.60)):
        build_clip(paths, clip_id, start, end, articulation_heuristics=True)
        outputs.append(render_guide(paths, 1, clip_id))
    return outputs
