"""Ear probes: seed-4099 rendered under candidate key/bpm configs.

The Krumhansl estimator picked B minor; the owner's ear says that's wrong
and suggests "the major version" — which is ambiguous between D major (the
relative major, identical pitch classes: the estimator's classic confusion)
and B major (the parallel). Generation is seed-deterministic and cheap, so
instead of guessing we render one probe per candidate config and the owner
NAMES the key by ear. Probes are diagnostics: receipted for provenance,
served as plain files, never on candidate cards, never verdictable — the
chosen config becomes the next full round, which is where evidence lives.
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from asserted_proof_ace_cover import (  # noqa: E402
    ACE_PY,
    ACE_ROOT,
    ACE_WORKER,
    _finalize_candidate_audio,
    _now_iso,
    ace_dir_for,
    build_worker_request,
    request_sha256,
    write_request_if_changed,
)
from asserted_proof_cover_lexical import score_lexical  # noqa: E402
from asserted_proof_cover_metrics import compare_f0_contours  # noqa: E402
from asserted_proof_provenance import receipt_is_current, write_receipt  # noqa: E402
from asserted_proof_runtime import BRIDGE, REPO, SOULX_PY, WHISPER_PY, WORKER, Paths, dump_json, load_json, run, run_json  # noqa: E402

PROBE_SEED = 4099
PROBE_RECEIPT_LABELS = frozenset({"request", "full", "rawTrim", "output"})
PROBE_EVAL_RECEIPT_LABELS = frozenset({"output", "asr", "renderedF0", "eval"})


_OVERRIDE_ALIASES = {"cover_noise_strength": "cns"}


def probe_slug(keyscale: str, bpm: int | None, *, overrides: dict | None = None) -> str:
    text = keyscale.replace("#", " sharp ").replace("b ", " flat ") if keyscale else "no-key"
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    if bpm is not None:
        slug = f"{slug}-{bpm}"
    for name in sorted(overrides or {}):
        value = overrides[name]
        alias = _OVERRIDE_ALIASES.get(name)
        if alias is not None and isinstance(value, float):
            slug = f"{slug}-{alias}{round(value * 100)}"
        else:
            part = re.sub(r"[^a-z0-9]+", "-", f"{name} {value}".lower()).strip("-")
            slug = f"{slug}-{part}"
    return slug


def build_probe_request(main_request: dict, *, keyscale: str, bpm: int | None, seed: int = PROBE_SEED, param_overrides: dict | None = None, use_mlx_dit: bool = True) -> dict:
    request = json.loads(json.dumps(main_request))
    for volatile in ("requestSha256", "createdAt", "updatedAt"):
        request.pop(volatile, None)
    request["params"]["keyscale"] = keyscale
    if bpm is not None:
        request["params"]["bpm"] = int(bpm)
    for name, value in (param_overrides or {}).items():
        request["params"][name] = value
    request["seeds"] = [int(seed)]
    slug = probe_slug(keyscale, bpm, overrides=param_overrides)
    if not use_mlx_dit:
        # The MLX DiT ignores cover_noise_strength entirely (no occurrences in
        # acestep/models/mlx/) — strength probes pin the torch sampler and say so.
        request["useMlxDit"] = False
        slug = f"{slug}-torch"
    request["variant"] = f"probe-{slug}"
    request["variantOf"] = str(main_request["requestSha256"])
    request["requestSha256"] = request_sha256(request)
    return request


def _evaluate_probe(probe_dir: Path, plan: dict, raw_clip_f0: list) -> dict:
    """Lightweight probe diagnostics: ASR + lexical, RMVPE F0 + contour. No MMS
    alignment — probes are cheap by design; full evaluation belongs to rounds."""
    files = {
        "output": probe_dir / "probe-opening.wav",
        "asr": probe_dir / "probe-asr.json",
        "f0": probe_dir / "probe-f0.json",
        "eval": probe_dir / "probe-eval.json",
        "receipt": probe_dir / "probe-eval-receipt.json",
    }
    if receipt_is_current(files["receipt"], PROBE_EVAL_RECEIPT_LABELS):
        return load_json(files["eval"])
    expected_words = [str(word["text"]) for word in plan["words"]]
    try:
        asr = run_json([str(WHISPER_PY), str(REPO / "service/whisper/whisper_cli.py"), str(files["output"]), "small"], timeout=1800)
    except RuntimeError as error:
        asr = {"ok": False, "error": str(error)}
    dump_json(files["asr"], asr)
    lexical = score_lexical(expected_words, [str(word.get("word", "")) for word in asr.get("words", [])]) if asr.get("ok") else None
    run([str(SOULX_PY), str(WORKER), "f0", str(files["output"]), str(files["f0"])], cwd=BRIDGE)
    contour = compare_f0_contours(raw_clip_f0, load_json(files["f0"]))
    evaluation = {
        "version": 1,
        "heard": " ".join(str(word.get("word", "")).strip() for word in asr.get("words", [])) if asr.get("ok") else None,
        "lexical": {key: lexical.get(key) for key in ("hits", "nearMisses", "substitutions", "misses", "insertions", "lexicalScore", "sequenceRatio")} if lexical else None,
        "contour": {key: contour.get(key) for key in ("contourCorrelation", "medianAbsPitchErrorSemitones", "medianAbsPitchErrorAfterOffsetSemitones", "registerOffsetSemitones", "voicedOverlap", "longestOctaveErrorMs")},
    }
    dump_json(files["eval"], evaluation)
    write_receipt(files["receipt"], {"output": files["output"], "asr": files["asr"], "renderedF0": files["f0"], "eval": files["eval"]})
    return evaluation


def run_key_probes(paths: Paths, *, keys: list[str], bpm: int | None, bpm_note: str = "", cover_noise: list[float] | None = None, evaluate: bool = True, use_mlx_dit: bool = True) -> Path:
    ace_dir = ace_dir_for(paths)
    if not (ace_dir / "request.json").is_file():
        raise RuntimeError("run ace-cover-spike first — probes derive from the lane's pinned request")
    main_request = load_json(ace_dir / "request.json")
    plan = load_json(paths.opening / "asserted-render-plan.json")
    raw_clip_f0 = load_json(ace_dir / "raw-clip-f0.json") if (ace_dir / "raw-clip-f0.json").is_file() else []
    probes_dir = ace_dir / "probes"
    probes_dir.mkdir(exist_ok=True)
    overrides_grid: list[dict | None] = [{"cover_noise_strength": value} for value in cover_noise] if cover_noise else [None]
    entries = []
    for keyscale in keys:
        for overrides in overrides_grid:
            built = build_probe_request(main_request, keyscale=keyscale, bpm=bpm, param_overrides=overrides, use_mlx_dit=use_mlx_dit)
            slug = built["variant"].removeprefix("probe-")
            probe_dir = probes_dir / slug
            probe_dir.mkdir(exist_ok=True)
            request, _ = write_request_if_changed(probe_dir / "request.json", built, now_iso=_now_iso())
            files = {
                "full": probe_dir / "probe-full.wav",
                "rawTrim": probe_dir / "probe-opening-raw.wav",
                "opening": probe_dir / "probe-opening.wav",
                "receipt": probe_dir / "receipt.json",
            }
            if not receipt_is_current(files["receipt"], PROBE_RECEIPT_LABELS):
                worker_request = build_worker_request(request, root=paths.root, seeds=[PROBE_SEED], save_dir=probe_dir / "worker-out")
                dump_json(probe_dir / "worker-request.json", worker_request)
                run([str(ACE_PY), str(ACE_WORKER), "--request", str(probe_dir / "worker-request.json"), "--output", str(probe_dir / "worker-result.json")], cwd=ACE_ROOT, timeout=7200)
                result = load_json(probe_dir / "worker-result.json")
                entry = next((item for item in result.get("results", []) if item.get("ok")), None)
                if entry is None:
                    raise RuntimeError(f"probe generation failed for {slug}: {result}")
                shutil.move(entry["audioPath"], files["full"])
                _finalize_candidate_audio(plan, files, files["full"], trim=True)
                write_receipt(files["receipt"], {"request": probe_dir / "request.json", "full": files["full"], "rawTrim": files["rawTrim"], "output": files["opening"]})
            evaluation = _evaluate_probe(probe_dir, plan, raw_clip_f0) if evaluate and raw_clip_f0 else None
            entries.append(
                {
                    "slug": slug,
                    "keyscale": keyscale,
                    "bpm": bpm,
                    "paramOverrides": overrides,
                    "seed": PROBE_SEED,
                    "requestSha256": request["requestSha256"],
                    "audio": f"opening/ace-step-cover/probes/{slug}/probe-opening.wav",
                    "eval": evaluation,
                }
            )
    dump_json(
        probes_dir / "probes.json",
        {
            "version": 2,
            "updatedAt": _now_iso(),
            "purpose": "owner names the winning config by ear; the chosen config becomes the next full round",
            "bpmNote": bpm_note,
            "probes": entries,
        },
    )
    return probes_dir
