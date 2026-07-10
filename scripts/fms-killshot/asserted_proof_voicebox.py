from __future__ import annotations

import hashlib
import ipaddress
import json
import math
import re
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from dataclasses import dataclass
from pathlib import Path

import asserted_proof_runtime as runtime
from asserted_proof_lexical import assemble_pcm16_mono, build_lexical_targets
from asserted_proof_metrics import compare_audio
from asserted_proof_provenance import write_receipt
from asserted_proof_splice import splice_pcm16_mono

OPENING_WORDS = "yeah we used to fight like invincible but in the night we got hella close yeah".split()
OPENING_GROUP_SIZES = (5, 2, 4, 5)
VOICEBOX_INSTRUCTION = "Speak only the requested words clearly and naturally in a low register. Do not repeat the reference."


def _normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9']", "", value.lower())


def group_opening_targets(targets: list[dict]) -> list[list[dict]]:
    words = [_normalize(str(target["text"])) for target in targets]
    if words != OPENING_WORDS:
        raise RuntimeError("Voicebox opening groups do not match the asserted opening text")
    groups, offset = [], 0
    for size in OPENING_GROUP_SIZES:
        groups.append(targets[offset : offset + size])
        offset += size
    return groups


def match_asserted_phrase(asr_words: list[dict], expected: list[str]) -> list[dict]:
    heard = [_normalize(str(word.get("word", ""))) for word in asr_words]
    wanted = [_normalize(word) for word in expected]
    matches = [index for index in range(len(heard) - len(wanted) + 1) if heard[index : index + len(wanted)] == wanted]
    if not matches:
        raise RuntimeError(f"Voicebox phrase failed lexical gate: expected {' '.join(wanted)}, heard {' '.join(heard)}")
    start = matches[-1]
    return asr_words[start : start + len(wanted)]


def parse_generation_events(payload: str) -> dict:
    events = [json.loads(line[6:]) for line in payload.splitlines() if line.startswith("data: ")]
    if not events or events[-1].get("status") != "completed":
        status = events[-1].get("status") if events else "missing"
        error = events[-1].get("error") if events else None
        raise RuntimeError(f"Voicebox generation did not complete: status={status}, error={error}")
    return events[-1]


def _loopback_base_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme != "http" or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise RuntimeError("Voicebox base URL must be a plain loopback HTTP origin")
    host = parsed.hostname or ""
    try:
        loopback = host == "localhost" or ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = False
    if not loopback:
        raise RuntimeError("Voicebox base URL must use a loopback host")
    return value.rstrip("/")


def _safe_profile_id(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
        raise RuntimeError("Voicebox profile id contains unsafe path characters")
    return value


def public_profile_metadata(profile: dict, samples: list[dict]) -> dict:
    return {
        "profileIdSha256": hashlib.sha256(str(profile["id"]).encode()).hexdigest(),
        "voiceType": profile.get("voice_type"),
        "defaultEngine": profile.get("default_engine"),
        "sampleCount": len(samples),
    }


def public_phrase_metadata(
    expected: list[str],
    generation: dict,
    matched: list[dict],
    *,
    trim_start_s: float,
    trim_end_s: float,
) -> dict:
    return {
        "text": " ".join(expected),
        "generation": {
            key: generation.get(key)
            for key in ("status", "durationS", "seed", "modelSize")
        },
        "matchedWords": [
            {"word": expected[index], "start": float(word["start"]), "end": float(word["end"])}
            for index, word in enumerate(matched)
        ],
        "exactSequence": True,
        "trimStartS": trim_start_s,
        "trimEndS": trim_end_s,
    }


def articulation_fit_duration(target: dict, *, source_duration_s: float) -> float:
    target_duration = float(target["duration"])
    syllables = sum(str(phone)[-1:].isdigit() for phone in target.get("phones", []))
    if syllables >= 3 and target_duration > source_duration_s * 1.8:
        return min(target_duration, 0.6)
    return target_duration


@dataclass(frozen=True, slots=True)
class VoiceboxClient:
    base_url: str
    profile_id: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "base_url", _loopback_base_url(self.base_url))
        object.__setattr__(self, "profile_id", _safe_profile_id(self.profile_id))

    def _request(self, path: str, *, payload: dict | None = None, timeout: int = 600) -> bytes:
        data = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(
            f"{self.base_url.rstrip('/')}{path}",
            data=data,
            headers={"Content-Type": "application/json"} if data is not None else {},
            method="POST" if data is not None else "GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as error:
            raise RuntimeError(f"Voicebox request failed: {path}: {error}") from error

    def json(self, path: str) -> dict | list:
        return json.loads(self._request(path))

    def generate(self, text: str, output: Path) -> dict:
        response = json.loads(
            self._request(
                "/generate",
                payload={
                    "profile_id": self.profile_id,
                    "text": text,
                    "language": "en",
                    "seed": 0,
                    "model_size": "0.6B",
                    "engine": "qwen",
                    "instruct": VOICEBOX_INSTRUCTION,
                    "personality": False,
                    "max_chunk_chars": 800,
                    "crossfade_ms": 0,
                    "normalize": True,
                },
            )
        )
        generation_id = str(response["id"])
        terminal = parse_generation_events(self._request(f"/generate/{generation_id}/status").decode())
        output.write_bytes(self._request(f"/audio/{generation_id}", timeout=60))
        return {
            "generationId": generation_id,
            "status": terminal["status"],
            "durationS": terminal.get("duration"),
            "seed": response.get("seed"),
            "modelSize": response.get("model_size"),
        }


def _fit_word(source: Path, target: dict, output: Path, *, articulation_duration_s: float) -> None:
    temporary = output.with_name(f"{output.stem}-temp.wav")
    runtime.run([str(runtime.RUBBERBAND), "-q", "-3", "-F", "-D", f"{articulation_duration_s:.6f}", str(source), str(temporary)])
    runtime.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(temporary),
            "-af", f"apad,atrim=0:{target['duration']:.6f}", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", str(output),
        ]
    )
    temporary.unlink(missing_ok=True)


def build_voicebox_cloned_guide(paths: runtime.Paths, *, base_url: str, profile_id: str) -> Path:
    client = VoiceboxClient(base_url, profile_id)
    health = client.json("/health")
    if not isinstance(health, dict) or not health.get("model_loaded"):
        raise RuntimeError("Voicebox Qwen model is not loaded")
    profile = client.json(f"/profiles/{profile_id}")
    samples = client.json(f"/profiles/{profile_id}/samples")

    clip_dir = paths.opening
    plan_path = clip_dir / "asserted-render-plan.json"
    plan = runtime.load_json(plan_path)
    targets = build_lexical_targets(plan)
    groups = group_opening_targets(targets)
    work = clip_dir / "voicebox-lexical"
    work.mkdir(parents=True, exist_ok=True)
    clip_start = float(plan["clip"]["start"])
    duration = float(plan["clip"]["end"]) - clip_start
    unpitched_segments, render_targets, phrase_metadata = [], [], []

    for phrase_index, group in enumerate(groups, start=1):
        stem = f"phrase-{phrase_index:02d}"
        expected = [str(target["text"]) for target in group]
        source = work / f"{stem}-source.wav"
        generation = client.generate(" ".join(expected), source)
        asr = runtime.run_json([str(runtime.WHISPER_PY), str(runtime.REPO / "service/whisper/whisper_cli.py"), str(source), "small"])
        matched = match_asserted_phrase(list(asr.get("words", [])), expected)
        trim_start = max(0.0, float(matched[0]["start"]) - 0.06)
        trim_end = float(matched[-1]["end"]) + 0.06
        trimmed = work / f"{stem}-asserted.wav"
        runtime.convert_audio(source, trimmed, start=trim_start, duration=trim_end - trim_start)
        tokens_path, alignment_path = work / f"{stem}-tokens.json", work / f"{stem}-aligned.json"
        runtime.dump_json(tokens_path, [{"text": word, "normalized": _normalize(word)} for word in expected])
        runtime.run([str(runtime.SKELETON_PY), str(runtime.WORKER), "align", str(trimmed), str(tokens_path), str(alignment_path)])
        aligned = runtime.load_json(alignment_path)
        if len(aligned) != len(group):
            raise RuntimeError(f"Voicebox phrase alignment lost words: {stem}")
        for target, span in zip(group, aligned):
            owner = str(target["ownerId"])
            word_source, fitted = work / f"{owner}-source.wav", work / f"{owner}-fitted.wav"
            source_duration = float(span["end"]) - float(span["start"])
            runtime.convert_audio(trimmed, word_source, start=float(span["start"]), duration=source_duration)
            fit_duration = articulation_fit_duration(target, source_duration_s=source_duration)
            _fit_word(word_source, target, fitted, articulation_duration_s=fit_duration)
            unpitched_segments.append({"path": fitted, "start": target["start"] - clip_start, "end": target["end"] - clip_start, "ownerId": owner})
            render_targets.append(
                {
                    **target,
                    "sourceDurationS": source_duration,
                    "articulationDurationS": fit_duration,
                    "heldRemainderS": float(target["duration"]) - fit_duration,
                    "preserveNaturalPitch": fit_duration < float(target["duration"]),
                    "sourcePath": str(word_source),
                }
            )
        phrase_metadata.append(
            public_phrase_metadata(
                expected,
                generation,
                matched,
                trim_start_s=trim_start,
                trim_end_s=trim_end,
            )
        )

    unpitched = clip_dir / "voicebox-lexical-guide-unpitched.wav"
    assemble_pcm16_mono(unpitched_segments, unpitched, duration_s=duration)
    unpitched_f0_path = clip_dir / "voicebox-lexical-guide-unpitched-f0.json"
    runtime.run([str(runtime.SOULX_PY), str(runtime.WORKER), "f0", str(unpitched), str(unpitched_f0_path)], cwd=runtime.BRIDGE)
    unpitched_f0 = runtime.load_json(unpitched_f0_path)
    pitched_segments, target_metadata = [], []
    for target, segment in zip(render_targets, unpitched_segments):
        start, end = float(segment["start"]), float(segment["end"])
        voiced = [float(point["hz"]) for point in unpitched_f0 if start <= float(point["t"]) <= end and float(point["hz"]) > 0]
        if not voiced:
            raise RuntimeError(f"Voicebox lexical word has no measurable pitch: {target['ownerId']}")
        source_hz = sorted(voiced)[len(voiced) // 2]
        source_midi = 69.0 + 12.0 * math.log2(source_hz / 440.0)
        requested_shift = float(target["targetMidi"]) - source_midi
        shift = 0.0 if target["preserveNaturalPitch"] else max(-7.0, min(7.0, requested_shift))
        pitched_temp, pitched = work / f"{target['ownerId']}-pitched-temp.wav", work / f"{target['ownerId']}-pitched.wav"
        if target["preserveNaturalPitch"]:
            carrier_fitted = work / f"{target['ownerId']}-carrier-fitted.wav"
            carrier_pitched_temp = work / f"{target['ownerId']}-carrier-pitched-temp.wav"
            carrier_pitched = work / f"{target['ownerId']}-carrier-pitched.wav"
            _fit_word(Path(target["sourcePath"]), target, carrier_fitted, articulation_duration_s=float(target["duration"]))
            carrier_shift = max(-7.0, min(7.0, requested_shift))
            runtime.run([str(runtime.RUBBERBAND), "-q", "-3", "-F", "-p", f"{carrier_shift:.6f}", str(carrier_fitted), str(carrier_pitched_temp)])
            runtime.convert_audio(carrier_pitched_temp, carrier_pitched, duration=float(target["duration"]))
            carrier_pitched_temp.unlink(missing_ok=True)
            splice_pcm16_mono(
                carrier_pitched,
                Path(segment["path"]),
                pitched,
                patch_start_s=0.0,
                patch_end_s=float(target["duration"]),
                crossfade_s=0.01,
            )
            shift = 0.0
        elif shift == 0.0:
            runtime.convert_audio(Path(segment["path"]), pitched, duration=float(target["duration"]))
        else:
            runtime.run([str(runtime.RUBBERBAND), "-q", "-3", "-F", "-p", f"{shift:.6f}", str(segment["path"]), str(pitched_temp)])
            runtime.convert_audio(pitched_temp, pitched, duration=float(target["duration"]))
            pitched_temp.unlink(missing_ok=True)
        pitched_segments.append({"path": pitched, "start": start, "end": end, "ownerId": target["ownerId"]})
        target_metadata.append({**target, "sourcePitchHz": source_hz, "sourceMidi": source_midi, "requestedSemitoneShift": requested_shift, "appliedSemitoneShift": shift})

    guide = clip_dir / "voicebox-lexical-guide.wav"
    assembly = assemble_pcm16_mono(pitched_segments, guide, duration_s=duration)
    metadata_path = clip_dir / "voicebox-lexical-guide.json"
    public_targets = [{key: value for key, value in target.items() if key != "sourcePath"} for target in target_metadata]
    runtime.dump_json(
        metadata_path,
        {
            "version": 1,
            "backend": "voicebox-qwen-0.6B",
            "profile": public_profile_metadata(profile, samples),
            "phrases": phrase_metadata,
            "targets": public_targets,
            "assembly": assembly,
        },
    )
    guide_f0_path = clip_dir / "voicebox-lexical-guide-f0.json"
    runtime.run([str(runtime.SOULX_PY), str(runtime.WORKER), "f0", str(guide), str(guide_f0_path)], cwd=runtime.BRIDGE)
    metrics_path = clip_dir / "metrics-voicebox-lexical-guide.json"
    metrics = compare_audio(plan, clip_dir / "raw.wav", guide, runtime.load_json(guide_f0_path))
    metrics["lane"] = "voicebox-cloned-phrases-to-asserted-slots"
    runtime.dump_json(metrics_path, metrics)
    asr_path = clip_dir / "voicebox-lexical-guide-asr.json"
    asr = runtime._asr_diagnostic(guide, targets)
    asr["exactSequence"] = asr["expected"] == asr["heard"]
    runtime.dump_json(asr_path, asr)
    if not asr["exactSequence"] or not asr["requiredPhrasePresent"]:
        raise RuntimeError(f"Voicebox cloned guide failed lexical gate: heard={' '.join(asr['heard'])}")
    write_receipt(
        clip_dir / "voicebox-lexical-guide-receipt.json",
        {"renderPlan": plan_path, "promptAudio": paths.prompt_wav, "metadata": metadata_path, "unpitched": unpitched, "unpitchedF0": unpitched_f0_path, "output": guide, "renderedF0": guide_f0_path, "metrics": metrics_path, "asr": asr_path},
    )
    runtime._regenerate_manifest(paths, "opening")
    return guide
