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
from asserted_proof_provenance import receipt_is_current, write_receipt  # noqa: E402
from asserted_proof_runtime import Paths, dump_json, load_json, run  # noqa: E402

PROBE_SEED = 4099
PROBE_RECEIPT_LABELS = frozenset({"request", "full", "rawTrim", "output"})


def probe_slug(keyscale: str, bpm: int | None) -> str:
    text = keyscale.replace("#", " sharp ").replace("b ", " flat ") if keyscale else "no-key"
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return f"{slug}-{bpm}" if bpm is not None else slug


def build_probe_request(main_request: dict, *, keyscale: str, bpm: int | None, seed: int = PROBE_SEED) -> dict:
    request = json.loads(json.dumps(main_request))
    for volatile in ("requestSha256", "createdAt", "updatedAt"):
        request.pop(volatile, None)
    request["params"]["keyscale"] = keyscale
    if bpm is not None:
        request["params"]["bpm"] = int(bpm)
    request["seeds"] = [int(seed)]
    request["variant"] = f"probe-{probe_slug(keyscale, bpm)}"
    request["variantOf"] = str(main_request["requestSha256"])
    request["requestSha256"] = request_sha256(request)
    return request


def run_key_probes(paths: Paths, *, keys: list[str], bpm: int | None, bpm_note: str = "") -> Path:
    ace_dir = ace_dir_for(paths)
    if not (ace_dir / "request.json").is_file():
        raise RuntimeError("run ace-cover-spike first — probes derive from the lane's pinned request")
    main_request = load_json(ace_dir / "request.json")
    plan = load_json(paths.opening / "asserted-render-plan.json")
    probes_dir = ace_dir / "probes"
    probes_dir.mkdir(exist_ok=True)
    entries = []
    for keyscale in keys:
        slug = probe_slug(keyscale, bpm)
        probe_dir = probes_dir / slug
        probe_dir.mkdir(exist_ok=True)
        request, _ = write_request_if_changed(probe_dir / "request.json", build_probe_request(main_request, keyscale=keyscale, bpm=bpm), now_iso=_now_iso())
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
                raise RuntimeError(f"probe generation failed for {keyscale}: {result}")
            shutil.move(entry["audioPath"], files["full"])
            _finalize_candidate_audio(plan, files, files["full"], trim=True)
            write_receipt(files["receipt"], {"request": probe_dir / "request.json", "full": files["full"], "rawTrim": files["rawTrim"], "output": files["opening"]})
        entries.append(
            {
                "slug": slug,
                "keyscale": keyscale,
                "bpm": bpm,
                "seed": PROBE_SEED,
                "requestSha256": request["requestSha256"],
                "audio": f"opening/ace-step-cover/probes/{slug}/probe-opening.wav",
            }
        )
    dump_json(
        probes_dir / "probes.json",
        {
            "version": 1,
            "updatedAt": _now_iso(),
            "purpose": "owner names the key by ear; the chosen config becomes the next full round",
            "bpmNote": bpm_note,
            "probes": entries,
        },
    )
    return probes_dir
