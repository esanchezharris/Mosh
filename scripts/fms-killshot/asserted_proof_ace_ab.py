"""A/B: the current round's rank-1 candidate vs seed-4099 under the round-1 config.

Round 1 (no keyscale hint) produced the lane's only 16/16 asserted-word
transcription on seed 4099; the render was overwritten by the key-corrected
round but generation is seed-deterministic, so arm B regenerates it exactly
(verified by comparing the pre-enforcement ASR against the recorded round-1
transcript) and then runs it through the same silence gate as arm A. The
comparison lives in its own `ab/` dir with its own manifest so the main
round's provenance and per-candidate verdicts are untouched.
"""

from __future__ import annotations

import json
import shutil
import sys
from difflib import SequenceMatcher
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from asserted_proof_ace_cover import (  # noqa: E402
    ACE_PY,
    ACE_ROOT,
    ACE_WORKER,
    _evaluate_candidate_audio,
    _finalize_candidate_audio,
    _now_iso,
    ace_dir_for,
    build_worker_request,
    request_sha256,
    write_request_if_changed,
)
from asserted_proof_cover_lexical import normalize_asr_word  # noqa: E402
from asserted_proof_plan import build_manifest  # noqa: E402
from asserted_proof_provenance import receipt_is_current  # noqa: E402
from asserted_proof_runtime import REPO, WHISPER_PY, Paths, dump_json, load_json, run, run_json  # noqa: E402

AB_SEED = 4099
AB_DIR_NAME = "ab"
AB_STEM = "round1-4099"

# The round-1 seed-4099 pre-enforcement Whisper transcript (normalized), the
# lane's only exact 16/16 read — plus its one inserted word. Reproducing this
# on arm B's rawTrim proves the regeneration is the same render.
ROUND1_RAW_TRANSCRIPT = ("yeah", "we", "used", "to", "fight", "like", "invincible", "but", "in", "the", "night", "we", "got", "hella", "close", "shit", "yeah")

AB_RECEIPT_LABELS = frozenset({"request", "rawSlice", "rawClipF0", "output", "rawTrim", "asr", "align", "renderedF0", "eval", "full", "rawAsr"})


def ab_paths(ab_dir: Path) -> dict[str, Path]:
    return {
        "full": ab_dir / f"{AB_STEM}-full.wav",
        "opening": ab_dir / f"{AB_STEM}-opening.wav",
        "rawTrim": ab_dir / f"{AB_STEM}-opening-raw.wav",
        "asr": ab_dir / f"{AB_STEM}-asr.json",
        "rawAsr": ab_dir / f"{AB_STEM}-raw-asr.json",
        "align": ab_dir / f"{AB_STEM}-align.json",
        "f0": ab_dir / f"{AB_STEM}-f0.json",
        "eval": ab_dir / f"{AB_STEM}-eval.json",
        "receipt": ab_dir / f"{AB_STEM}-receipt.json",
    }


def build_ab_request(main_request: dict) -> dict:
    """Arm B = the CURRENT lane config with the round-1 generation params
    (keyscale unset), one seed. variantOf ties it to the main request hash, so
    a future round automatically stales this comparison."""
    request = json.loads(json.dumps(main_request))
    for volatile in ("requestSha256", "createdAt", "updatedAt"):
        request.pop(volatile, None)
    request["params"]["keyscale"] = ""
    request["seeds"] = [AB_SEED]
    request["variant"] = "round1-config"
    request["variantOf"] = str(main_request["requestSha256"])
    request["requestSha256"] = request_sha256(request)
    return request


def transcript_reproduction(heard_words: list[str]) -> dict:
    heard = [token for token in (normalize_asr_word(str(word)) for word in heard_words) if token]
    expected = list(ROUND1_RAW_TRANSCRIPT)
    return {
        "expected": expected,
        "heard": heard,
        "reproduced": heard == expected,
        "sequenceRatio": round(SequenceMatcher(a=expected, b=heard, autojunk=False).ratio(), 4),
    }


def run_ace_cover_ab(paths: Paths) -> Path:
    ace_dir = ace_dir_for(paths)
    for required in ("request.json", "ledger.json", "raw-clip-f0.json"):
        if not (ace_dir / required).is_file():
            raise RuntimeError(f"run ace-cover-spike first: {ace_dir / required} missing")
    main_request = load_json(ace_dir / "request.json")
    ledger = load_json(ace_dir / "ledger.json")
    arm_a = next((entry for entry in ledger.get("candidates", []) if entry.get("rank") == 1), None)
    if arm_a is None:
        raise RuntimeError("no rank-1 candidate in the ledger to compare against")
    plan = load_json(paths.opening / "asserted-render-plan.json")
    ab_dir = ace_dir / AB_DIR_NAME
    ab_dir.mkdir(exist_ok=True)
    ab_request, _ = write_request_if_changed(ab_dir / "request.json", build_ab_request(main_request), now_iso=_now_iso())
    files = ab_paths(ab_dir)

    if not receipt_is_current(files["receipt"], AB_RECEIPT_LABELS):
        worker_request = build_worker_request(ab_request, root=paths.root, seeds=[AB_SEED], save_dir=ab_dir / "worker-out")
        dump_json(ab_dir / "worker-request.json", worker_request)
        run([str(ACE_PY), str(ACE_WORKER), "--request", str(ab_dir / "worker-request.json"), "--output", str(ab_dir / "worker-result.json")], cwd=ACE_ROOT, timeout=7200)
        worker_result = load_json(ab_dir / "worker-result.json")
        entry = next((item for item in worker_result.get("results", []) if int(item.get("seed", -1)) == AB_SEED), None)
        if not entry or not entry.get("ok"):
            raise RuntimeError(f"arm B generation failed: {(entry or {}).get('error') or 'no result'}")
        shutil.move(entry["audioPath"], files["full"])
        _finalize_candidate_audio(plan, files, files["full"], trim=True)
        try:
            raw_asr = run_json([str(WHISPER_PY), str(REPO / "service/whisper/whisper_cli.py"), str(files["rawTrim"]), "small"], timeout=1800)
        except RuntimeError as error:
            raw_asr = {"ok": False, "error": str(error)}
        dump_json(files["rawAsr"], raw_asr)
        raw_clip_f0 = load_json(ace_dir / "raw-clip-f0.json")
        _evaluate_candidate_audio(
            paths,
            ace_dir,
            plan,
            files,
            candidate_id=f"seed-{AB_SEED}-round1",
            raw_clip_f0=raw_clip_f0,
            request_path=ab_dir / "request.json",
            receipt_extra={"full": files["full"], "rawAsr": files["rawAsr"], "paddedSource": ace_dir / "source-padded-10s.wav"},
            extra_fields={"seed": AB_SEED, "provenance": "round1-config-regeneration", "requestSha256": ab_request["requestSha256"]},
        )

    evaluation = load_json(files["eval"])
    raw_asr = load_json(files["rawAsr"])
    reproduction = (
        transcript_reproduction([word.get("word", "") for word in raw_asr.get("words", [])])
        if raw_asr.get("ok")
        else {"expected": list(ROUND1_RAW_TRANSCRIPT), "heard": [], "reproduced": False, "sequenceRatio": 0.0, "error": raw_asr.get("error")}
    )

    arm_a_opening = ace_dir / f"seed-{arm_a['seed']}-opening.wav"
    manifest = build_manifest(
        {
            label: path
            for label, path in {
                "abRequest": ab_dir / "request.json",
                "armAOpening": arm_a_opening,
                "armAEval": ace_dir / f"seed-{arm_a['seed']}-eval.json",
                "armBOpening": files["opening"],
                "armBRawTrim": files["rawTrim"],
                "armBEval": files["eval"],
                "armBRawAsr": files["rawAsr"],
                "rawSlice": paths.opening / "raw.wav",
            }.items()
            if path.is_file()
        },
        path_root=paths.root,
    )
    manifest["status"] = "current"
    (ab_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    lexical_b = evaluation.get("lexical") or {}
    contour_b = evaluation.get("contour") or {}
    audio_b = evaluation.get("audioMetrics") or {}
    summary = {
        "version": 1,
        "updatedAt": _now_iso(),
        "question": "Does round 1's exact render (best words ever) beat this round's best after the same silence gate?",
        "armA": {
            "label": f"Round-2 rank 1 · seed {arm_a['seed']} · keyscale {main_request['params'].get('keyscale') or 'none'}",
            "candidateId": arm_a.get("candidateId"),
            "seed": arm_a.get("seed"),
            "audio": f"opening/ace-step-cover/seed-{arm_a['seed']}-opening.wav",
            "lexical": arm_a.get("lexical"),
            "metrics": arm_a.get("metrics"),
        },
        "armB": {
            "label": "Round-1 config regeneration · seed 4099 · no key hint · same silence gate",
            "candidateId": evaluation.get("candidateId"),
            "seed": AB_SEED,
            "audio": f"opening/ace-step-cover/ab/{AB_STEM}-opening.wav",
            "lexical": {key: lexical_b.get(key) for key in ("hits", "nearMisses", "substitutions", "misses", "insertions", "lexicalScore", "sequenceRatio")},
            "metrics": {
                "medianAttackErrorMs": (evaluation.get("attack") or {}).get("medianAttackErrorMs"),
                "silenceBleedMs": audio_b.get("silenceBleedMs"),
                "postEnforcementSilenceBleedMs": audio_b.get("postEnforcementSilenceBleedMs"),
                "medianAbsPitchErrorSemitones": contour_b.get("medianAbsPitchErrorSemitones"),
                "registerOffsetSemitones": contour_b.get("registerOffsetSemitones"),
                "voicedOverlap": contour_b.get("voicedOverlap"),
            },
            "autoStatus": evaluation.get("autoStatus"),
            "shortlistFailures": evaluation.get("shortlistFailures"),
        },
        "round1TranscriptReproduction": reproduction,
    }
    dump_json(ab_dir / "ab.json", summary)
    return ab_dir
