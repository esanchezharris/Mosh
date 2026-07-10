"""Flow-edit probes: keep the take's audio, morph only the lyric direction.

Flow-edit is NOT a task type — it is a sampler overlay on the cover dispatch
(ACE `constants.py:74`; `GenerationParams` docstring `inference.py:172`):
integrate ``V_delta = V_tar(caption, lyrics) - V_src(source_caption,
source_lyrics)`` over a diffusion sub-window ``[n_min, n_max]``. So unlike the
``cover_noise_strength`` sweep — which renoises the WHOLE render toward the
source and, at the strength that keeps the words, just copies the take back —
flow-edit edits ONLY the lyric-conditioned direction over a bounded window:
the melody and voice stay the take's, the words move toward the target.

Two facts pin the invocation:
  * The MLX DiT has zero flow-edit code, so ``useMlxDit`` is forced False; the
    implementation lives in the torch turbo model (`models/turbo` +
    `models/common/flow_edit.py`), so the turbo checkpoint we already have is
    enough — no base download.
  * The overlay layers on the cover dispatch, so ``task_type`` stays "cover".

Probes are diagnostics: receipted for provenance, served as plain files,
owner-ear judged — never on candidate cards, never verdictable.
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
from asserted_proof_ace_probe import _evaluate_probe  # noqa: E402
from asserted_proof_provenance import receipt_is_current, write_receipt  # noqa: E402
from asserted_proof_runtime import Paths, dump_json, load_json, run  # noqa: E402

FLOW_EDIT_SEED = 4099
FLOW_EDIT_RECEIPT_LABELS = frozenset({"request", "full", "rawTrim", "output"})


def flow_edit_slug(keyscale: str, bpm: int | None, n_min: float, n_max: float) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", (keyscale or "no-key").lower()).strip("-")
    if bpm is not None:
        base = f"{base}-{bpm}"
    return f"flowedit-{base}-n{round(n_min * 100):02d}-{round(n_max * 100):02d}"


def build_flow_edit_request(
    main_request: dict,
    *,
    source_lyrics: str,
    target_lyrics: str,
    keyscale: str,
    bpm: int | None,
    n_min: float,
    n_max: float,
    n_avg: int = 1,
    seed: int = FLOW_EDIT_SEED,
) -> dict:
    request = json.loads(json.dumps(main_request))
    for volatile in ("requestSha256", "createdAt", "updatedAt"):
        request.pop(volatile, None)
    params = request["params"]
    params["keyscale"] = keyscale
    if bpm is not None:
        params["bpm"] = int(bpm)
    params["lyrics"] = target_lyrics  # V_tar condition (the asserted words)
    params["flow_edit_morph"] = True
    params["flow_edit_source_caption"] = params.get("caption", "")  # same caption -> edit only the lyric direction
    params["flow_edit_source_lyrics"] = source_lyrics  # V_src condition (the take's original words)
    params["flow_edit_n_min"] = float(n_min)
    params["flow_edit_n_max"] = float(n_max)
    params["flow_edit_n_avg"] = int(n_avg)
    request["seeds"] = [int(seed)]
    request["useMlxDit"] = False  # the MLX DiT has no flow-edit
    slug = flow_edit_slug(keyscale, bpm, n_min, n_max)
    request["variant"] = f"probe-{slug}"
    request["variantOf"] = str(main_request["requestSha256"])
    request["requestSha256"] = request_sha256(request)
    return request


def run_flow_edit_probes(
    paths: Paths,
    *,
    source_lyrics: str,
    target_lyrics: str,
    keyscale: str,
    bpm: int | None,
    windows: list[tuple[float, float]],
    n_avg: int = 1,
    evaluate: bool = True,
) -> Path:
    ace_dir = ace_dir_for(paths)
    if not (ace_dir / "request.json").is_file():
        raise RuntimeError("run ace-cover-spike first — flow-edit derives from the lane's pinned request")
    main_request = load_json(ace_dir / "request.json")
    plan = load_json(paths.opening / "asserted-render-plan.json")
    raw_clip_f0 = load_json(ace_dir / "raw-clip-f0.json") if (ace_dir / "raw-clip-f0.json").is_file() else []
    probes_dir = ace_dir / "probes"
    probes_dir.mkdir(exist_ok=True)
    entries = []
    for n_min, n_max in windows:
        built = build_flow_edit_request(
            main_request,
            source_lyrics=source_lyrics,
            target_lyrics=target_lyrics,
            keyscale=keyscale,
            bpm=bpm,
            n_min=n_min,
            n_max=n_max,
            n_avg=n_avg,
        )
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
        if not receipt_is_current(files["receipt"], FLOW_EDIT_RECEIPT_LABELS):
            worker_request = build_worker_request(request, root=paths.root, seeds=[FLOW_EDIT_SEED], save_dir=probe_dir / "worker-out")
            dump_json(probe_dir / "worker-request.json", worker_request)
            run([str(ACE_PY), str(ACE_WORKER), "--request", str(probe_dir / "worker-request.json"), "--output", str(probe_dir / "worker-result.json")], cwd=ACE_ROOT, timeout=7200)
            result = load_json(probe_dir / "worker-result.json")
            entry = next((item for item in result.get("results", []) if item.get("ok")), None)
            if entry is None:
                raise RuntimeError(f"flow-edit generation failed for {slug}: {result}")
            shutil.move(entry["audioPath"], files["full"])
            _finalize_candidate_audio(plan, files, files["full"], trim=True)
            write_receipt(files["receipt"], {"request": probe_dir / "request.json", "full": files["full"], "rawTrim": files["rawTrim"], "output": files["opening"]})
        evaluation = _evaluate_probe(probe_dir, plan, raw_clip_f0) if evaluate and raw_clip_f0 else None
        entries.append(
            {
                "slug": slug,
                "keyscale": keyscale,
                "bpm": bpm,
                "window": {"nMin": n_min, "nMax": n_max, "nAvg": n_avg},
                "seed": FLOW_EDIT_SEED,
                "requestSha256": request["requestSha256"],
                "audio": f"opening/ace-step-cover/probes/{slug}/probe-opening.wav",
                "eval": evaluation,
            }
        )
    dump_json(
        probes_dir / "flowedit-probes.json",
        {
            "version": 1,
            "updatedAt": _now_iso(),
            "purpose": "flow-edit keeps the take's melody/voice and morphs only the lyric direction over [n_min,n_max]; owner ear picks the window",
            "sourceLyrics": source_lyrics,
            "targetLyrics": target_lyrics,
            "probes": entries,
        },
    )
    return probes_dir
