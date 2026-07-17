#!/usr/bin/env python3
"""Mosh generative model service (05 §4).

A separate Python process — NOT built by CMake. Local job protocol: control over
HTTP/JSON; audio over files + manifests (never giant JSON). The native Generative
Job Manager (src/generative/) spawns/detects it, does a capability handshake +
warmup, monitors heartbeat, and cancels jobs on project close.

Adapters: `fake` (stdlib stub) and `stable_audio3` (the carved MLX SA3 model — full
carve: re-imagine/generate, ASTD colour rack, init-latent cache, judge QA). One
SINGLE serialized worker owns the SA3 model (MLX is not concurrent). SA3 is
advertised only when its model is present, so FakeAdapter-only runs are unaffected.

Run:  service/run.sh         # picks the MLX venv python when MOSH_ENABLE_SA3=1
      python3 service/server.py
"""
from __future__ import annotations

import hashlib
import itertools
import json
import ntpath
import os
import posixpath
import queue
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# On Windows a JUCE GUI parent may launch this service with stdout/stderr pipes
# that are not drained. Keep service logging file-backed unless a developer asks
# for console output explicitly.
if os.name == "nt" and os.environ.get("MOSH_SERVICE_CONSOLE", "") != "1":
    try:
        import tempfile
        _logfh = open(os.path.join(tempfile.gettempdir(), "mosh-service.log"),
                      "a", buffering=1, encoding="utf-8", errors="replace")
        sys.stdout = _logfh
        sys.stderr = _logfh
    except OSError:
        pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stitch  # noqa: E402  (render-ahead incremental-stitch primitive; stdlib wave only)
from adapters import fake_adapter  # noqa: E402
from adapters import stable_audio3_adapter  # noqa: E402  (path-only checks; heavy imports stay lazy)
from training import lora_trainer_adapter  # noqa: E402
from training.corpus_bundle import build_corpus_bundle  # noqa: E402
from training.rights import load_registry, read_json_object, save_registry, write_json  # noqa: E402
from training.trainer_job import train as train_lora  # noqa: E402

SERVICE_VERSION = "0.3.0"
START_TIME = time.time()
# Upper bound on a POST body — a defensive cap so a bogus or hostile
# Content-Length can't drive an unbounded rfile.read() (hang / huge alloc).
# POST payloads here are small JSON control messages (audio moves as file
# paths, never inline), so 64 MiB is generous headroom.
MAX_BODY_BYTES = 64 * 1024 * 1024
SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(SERVICE_DIR)
SA3_ENABLED = os.environ.get("MOSH_ENABLE_SA3", "1") == "1" and stable_audio3_adapter.available()
TRAINING_ENABLED = lora_trainer_adapter.available()


def venv_python(base_dir: str, is_windows: bool) -> str:
    """Interpreter path inside a venv rooted at base_dir. Windows venvs put python at
    Scripts\\python.exe; POSIX at bin/python. Host-agnostic (uses the explicit path
    module, not the ambient os.path) so BOTH branches are unit-testable on any host —
    see service/scripts/venv_python_path_test.py."""
    p = ntpath if is_windows else posixpath
    return (p.join(base_dir, "Scripts", "python.exe") if is_windows
            else p.join(base_dir, "bin", "python"))


def _venvs_root() -> str:
    """Root dir holding per-feature venvs. Explicit MOSH_VENVS_DIR wins; else the
    per-platform convention OUTSIDE the repo tree (macOS: ~/Library/Mosh/venvs;
    Windows: %LOCALAPPDATA%\\Mosh\\venvs)."""
    explicit = os.environ.get("MOSH_VENVS_DIR", "").strip()
    if explicit:
        return explicit
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA", "").strip() or os.path.expanduser("~")
        return os.path.join(base, "Mosh", "venvs")
    return os.path.join(os.path.expanduser("~"), "Library", "Mosh", "venvs")


def _venv_py(env_var: str, name: str) -> str:
    """Interpreter for a per-feature venv: the .env-sourced override first (the single
    source of truth, written by the feature's setup script), then the conventional
    per-platform venvs root (venvs live OUTSIDE the iCloud-synced repo tree — in-tree
    .venvs got files silently evicted by iCloud), then the legacy in-tree
    service/<name>/.venv. POSIX venvs use bin/python; Windows venvs Scripts\\python.exe."""
    env = os.environ.get(env_var, "").strip()
    if env:
        return env
    is_windows = os.name == "nt"
    conventional = venv_python(os.path.join(_venvs_root(), name), is_windows)
    if os.path.isfile(conventional):
        return conventional
    return venv_python(os.path.join(SERVICE_DIR, name, ".venv"), is_windows)


def _resolve_path(path: str, *, directory: bool) -> str:
    if not path:
        return path
    candidates = [path]
    if not os.path.isabs(path):
        candidates.extend([
            os.path.join(REPO_DIR, path),
            os.path.join(SERVICE_DIR, path),
        ])
    for candidate in candidates:
        resolved = os.path.abspath(candidate)
        if directory and os.path.isdir(resolved):
            return resolved
        if not directory and os.path.isfile(resolved):
            return resolved
    return path


def _basic_pitch_py() -> str:
    """The dedicated transcribe venv's python (set by setup-transcribe.sh via
    .transcribe.env -> BASIC_PITCH_PY), else the conventional default path."""
    return _venv_py("BASIC_PITCH_PY", "transcribe")


def _transcribe_available() -> bool:
    """True when the Basic Pitch venv exists (checked live so a freshly-run setup
    works without a service restart). The /transcribe endpoint surfaces any deeper
    import error from the subprocess itself."""
    return os.path.isfile(_basic_pitch_py())


def _whisper_py() -> str:
    """The dedicated whisper venv's python (set by setup-whisper.sh via .whisper.env ->
    WHISPER_PY), else the conventional default path."""
    return _venv_py("WHISPER_PY", "whisper")


def _whisper_available() -> bool:
    """True when the Whisper venv exists (checked live). When absent, /transcribe_words
    degrades to EMPTY words (the mumble-take rhythm sheet still builds) — never a 503."""
    return os.path.isfile(_whisper_py())


def _sketch_py() -> str:
    """The dedicated sketch venv's python (set by setup-sketch.sh via .sketch.env ->
    SKETCH_PY), else the conventional default path."""
    return _venv_py("SKETCH_PY", "sketch")


def _sketch_available() -> bool:
    """True when the Sketch (librosa) venv exists (checked live so a freshly-run setup
    works without a service restart). The /sketch endpoint surfaces any deeper import
    error from the subprocess itself."""
    return os.path.isfile(_sketch_py())


def _skeleton_py() -> str:
    """The dedicated skeleton (FCPE) venv's python (set by setup-skeleton.sh via .skeleton.env
    -> SKELETON_PY), else the conventional default path."""
    return _venv_py("SKELETON_PY", "skeleton")


def _skeleton_available() -> bool:
    """True when the skeleton (FCPE F0) venv exists (checked live). When ABSENT, /skeleton_spec
    degrades to the Basic-Pitch note-onset path (f0=None) — #178-quality rhythm, never a 503."""
    return os.path.isfile(_skeleton_py())


def _phonology_py() -> str:
    """The dedicated phonology venv's python (set by setup-phonology.sh via
    .phonology.env -> PHONOLOGY_PY), else the conventional default path."""
    return _venv_py("PHONOLOGY_PY", "phonology")


def _phonology_available() -> bool:
    """True when phonology can produce DICTIONARY-backed rhymes — either the dedicated
    venv exists OR cmudict is importable in the service interpreter. False ⇒ /get_rhymes
    still answers, but from the stdlib vowel-group heuristic only."""
    if os.path.isfile(_phonology_py()):
        return True
    import importlib.util
    return importlib.util.find_spec("cmudict") is not None


def _guest_capability_summary() -> dict:
    """Honest, live-checked "is the per-feature AI setup installed on THIS Mac" summary —
    the same booleans /health already reports (transcribe/skeleton/whisper/phonology),
    plus the transform tier's real-vs-fake backend and the training tier's backend name.
    A guest Mac (no ~/Library/Mosh/venvs, no RAVE models, no MOSH_TRAINING_REMOTE_URL) sees
    every venv-backed flag False and both backends "fake"/"fake-transform" — the frontend
    disables/labels the affected UI (clip-menu transcription actions, the transform target
    picker, the training popover) rather than letting them fail cryptically.

    Piggybacked onto GET /transform_targets (see that handler) because it is the one
    existing generic capability-discovery command (`list_transform_targets`) the native
    side already forwards to the frontend verbatim with zero C++ involved — there is no
    dedicated /capabilities passthrough command, and adding one would require a native
    change, which this pass avoids. `/capabilities` itself also carries the venv flags
    (for parity with /health) but nothing proxies it to the UI today."""
    from adapters import transform_adapter as _tx
    return {
        "transcribe": _transcribe_available(),
        "skeleton": _skeleton_available(),
        "whisper": _whisper_available(),
        "phonology": _phonology_available(),
        "transformReal": _tx.available(),
        "trainingBackend": lora_trainer_adapter.backend_name(),
    }


def _pronounce_words(words: list) -> dict:
    """ARPAbet phones for `words` via the phonology venv (real g2p for slang) when present,
    else in-process (cmudict/heuristic). Used by the vocabulary palette write path so palette
    entries store real phones. Returns {word: [phones] | None}. Best-effort (never raises)."""
    words = [w for w in words if w]
    if not words:
        return {}
    py = _phonology_py()
    if os.path.isfile(py):
        cli = os.path.join(SERVICE_DIR, "phonology", "phonology_cli.py")
        try:
            proc = subprocess.run([py, cli, "pronounce", *words],
                                  capture_output=True, text=True, timeout=120)
            payload = json.loads((proc.stdout or "").strip())
            if payload.get("ok"):
                return payload.get("phones", {})
        except Exception:  # noqa: BLE001 (fall through to in-process)
            pass
    try:
        from phonology import core as _ph
        p = _ph.Pronouncer()
        return {w: p.phones(w) for w in words}
    except Exception:  # noqa: BLE001
        return {w: None for w in words}


def _merge_palette_rhymes(payload: dict, clean: bool = False) -> dict:
    """Augment a /get_rhymes result with rhyming words from the vocabulary palette (Bar IQ B)
    — so slang/coined words SURFACE as candidates, not just dictionary words. Uses the query
    phones the phonology core already returned (no re-pronounce). Palette hits are tagged
    source='palette' + their register; deduped against the dictionary candidates. Bar IQ D:
    `clean` excludes profanity-tagged palette words (raw is the default)."""
    try:
        qphones = payload.get("queryPhones")
        if not qphones:
            return payload
        from lyrics.vocab import VocabPalette
        palette = VocabPalette()
        strict = payload.get("strictness", "slant")
        cands = payload.get("candidates", [])
        # Bar IQ D — clean mode drops profanity wherever it appears (the palette is the
        # profanity registry), so a profanity word that's ALSO in the dictionary is filtered too.
        if clean:
            banned = palette.register_words("profanity")
            cands = [c for c in cands if c.get("word") not in banned]
        have = {c.get("word") for c in cands}
        have.add(str(payload.get("word", "")).lower())
        extra = []
        excl = ["profanity"] if clean else None
        for h in palette.rhyme_search(qphones, strict, max_n=200, exclude_registers=excl):
            if h["word"] not in have:
                have.add(h["word"])
                extra.append({"word": h["word"], "syllables": h["syllables"],
                              "grade": h["grade"], "source": "palette", "register": h.get("register", "")})
        if extra or clean:
            # palette words first (they're what makes it feel un-neutered), then the dict words
            payload = dict(payload)
            payload["candidates"] = extra + cands
    except Exception as e:  # noqa: BLE001 (palette is additive; never break rhyme lookup)
        # …but DON'T swallow silently: a broken phonology/vocab install (or a NameError in
        # vocab.py) would otherwise degrade the rhyme tool to dict-only with no signal. Log
        # to stderr so an operator running the service sees it (the documented Bar-IQ lesson).
        sys.stderr.write(f"[service] palette rhyme merge skipped (additive, non-fatal): {e}\n")
    payload.pop("queryPhones", None)   # internal — don't leak to the client
    return payload


def _colorrack_hash() -> str:
    try:
        from colors import runtime as CR
        return hashlib.md5(json.dumps(CR.registry(), sort_keys=True).encode()).hexdigest()[:8]
    except Exception:  # noqa: BLE001
        return "none"


# service_build feeds the native render-cache fingerprint: changing the engine/colors
# must invalidate cached renders, so it encodes the carve identity.
if SA3_ENABLED:
    from sa3 import engine as _sa3_engine
    SERVICE_BUILD = (f"sa3-1.0.0+{stable_audio3_adapter.backend_name()}"
                     f"+colors{_colorrack_hash()}+sec{os.environ.get('SA3_SECONDS', '8.0')}"
                     f"+lora{_sa3_engine.LORA_APPLY_VERSION}")
else:
    SERVICE_BUILD = "fake-0.1.0"

FAKE_ADAPTER = {
    "id": "fake", "version": "0.0.1",
    "generation_modes": ["text_to_audio", "audio_to_audio"],
    "conditioning_inputs": ["prompt", "init_audio", "negative_prompt"],
    "duration_limits": {"min": 0.1, "max": 600.0},
    "sample_rates": [44100], "channel_modes": ["stereo"],
    "runtime_requirements": ["cpu"], "packaging_mode": "python_service",
    "supports_seed": True, "supports_semantic_controls": False,
    "service_build": SERVICE_BUILD,
}

# Route B — the transform tier (timbre/style transfer). Same job protocol as the
# others; the fake backend ships, the real RAVE/MelodyFlow swaps in behind it.
TRANSFORM_ADAPTER = {
    "id": "transform", "version": "0.0.1",
    "generation_modes": ["transform"],
    "conditioning_inputs": ["init_audio", "target", "strength"],
    "duration_limits": {"min": 0.1, "max": 600.0},
    "sample_rates": [44100], "channel_modes": ["stereo"],
    "runtime_requirements": ["cpu"], "packaging_mode": "python_service",
    "supports_seed": True, "supports_semantic_controls": False,
    "service_build": SERVICE_BUILD,
}

# FMS Phase 3 — the sing tier (own-voice render of the lyric sheet + take flow). Same
# job protocol; the fake legato-beep score renderer ships, the real SoulX-Singer PC/SSH
# backend swaps in behind it (adapters/soulx_adapter.py).
SOULX_ADAPTER = {
    "id": "soulx", "version": "0.0.1",
    "generation_modes": ["sing"],
    "conditioning_inputs": ["lines", "voice_ref"],
    "duration_limits": {"min": 0.1, "max": 600.0},
    "sample_rates": [44100], "channel_modes": ["mono"],
    "runtime_requirements": ["cpu"], "packaging_mode": "python_service",
    # sing is a deterministic score-driven render — there is no seed axis; the
    # adapter never reads params["seed"] (a seed bump = cache MISS, identical audio).
    "supports_seed": False, "supports_semantic_controls": False,
    "service_build": SERVICE_BUILD,
}


def _sa3_descriptor() -> dict:
    return {
        "id": "stable_audio3", "version": "1.0.0", "available": SA3_ENABLED,
        "generation_modes": ["text_to_audio", "audio_to_audio"],
        "conditioning_inputs": ["prompt", "init_audio", "negative_prompt", "colors"],
        "duration_limits": {"min": 0.5, "max": float(os.environ.get("SA3_SECONDS", "8.0"))},
        "sample_rates": [44100], "channel_modes": ["stereo"],
        "runtime_requirements": [stable_audio3_adapter.backend_name()], "packaging_mode": "python_service",
        "supports_seed": True, "supports_semantic_controls": True,
        "semantic_controls": "colors", "service_build": SERVICE_BUILD,
    }


def _training_descriptor() -> dict:
    return {
        "id": "lora_trainer",
        "version": "0.1.0",
        "available": TRAINING_ENABLED,
        "output_formats": ["json_stub"],
        "runtime_requirements": ["cpu"],
        "packaging_mode": "python_service",
        "service_build": SERVICE_BUILD,
        "backend": lora_trainer_adapter.backend_name(),
    }


def _generate_recipe_payload(data: dict) -> dict:
    from recipes import generate as gen  # noqa: PLC0415
    from teardown import recipe as recipe_model  # noqa: PLC0415
    from teardown.render.compile import compile_recipe  # noqa: PLC0415

    request = data.get("request", {})
    if not isinstance(request, dict):
        request = {}
    request = dict(request)
    for key in ("mood", "genre", "key", "lead"):
        if key in data:
            request[key] = data[key]
    if "tempo" in data:
        request["tempo"] = data["tempo"]

    try:
        seed = int(data.get("seed", 0) or 0)
    except (TypeError, ValueError):
        seed = 0

    library_dir = str(data.get("libraryDir", data.get("library_dir", "")) or "").strip()
    if not library_dir:
        library_dir = os.environ.get("MOSH_RECIPE_LIBRARY", "").strip() or gen.LIB_DIR
    library_dir = _resolve_path(library_dir, directory=True)
    if not os.path.isdir(library_dir):
        raise RuntimeError(f"recipe library missing: {library_dir}")

    palette_manifest = str(data.get("paletteManifest", data.get("palette_manifest", "")) or "").strip()
    if not palette_manifest:
        palette_manifest = os.environ.get("MOSH_PALETTE_MANIFEST", "").strip()
    palette_manifest = _resolve_path(palette_manifest, directory=False)
    palette = gen.load_palette(palette_manifest) if palette_manifest else None

    rec, prov = gen.generate(request, library_dir=library_dir, seed=seed, palette=palette)
    compiled = compile_recipe(rec).to_dict()
    return {
        "ok": True,
        "recipeId": rec.recipe_id,
        "request": request,
        "libraryDir": library_dir,
        "paletteManifest": palette_manifest,
        "recipe": json.loads(recipe_model.to_json(rec)),
        "program": compiled,
        "provenance": asdict(prov),
        "commandCount": len(compiled.get("commands", [])),
        "unresolvedCount": len(compiled.get("unresolved", [])),
    }


_jobs: dict[str, dict] = {}
_lock = threading.Lock()
_job_q: "queue.PriorityQueue" = queue.PriorityQueue()
_seq = itertools.count()
_training_jobs: dict[str, dict] = {}
_training_lock = threading.Lock()
_training_q: "queue.PriorityQueue" = queue.PriorityQueue()
_training_seq = itertools.count()


def _training_root() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "training")


def _training_registry_path() -> str:
    return os.path.join(_training_root(), "rights_registry.json")


def _training_state_path() -> str:
    return os.path.join(_training_root(), "training_state.json")


def _load_training_state() -> dict:
    # MISSING state initialises normally; a CORRUPT / non-object file is reported
    # invalid (stateError surfaced) instead of silently returning bare defaults that
    # the next save would overwrite the evidence with (AL-015).
    data, error = read_json_object(_training_state_path())
    data.setdefault("activeAdapterId", "")
    data.setdefault("activeAdapterPath", "")
    data.setdefault("activeCorpusHash", "")
    data.setdefault("jobs", [])
    data.setdefault("adapters", [])
    if error:
        data["stateError"] = error
    return data


def _save_training_state(state: dict) -> None:
    path = _training_state_path()
    # A missing file is fine to (re)create, but a CORRUPT / non-object state file holds
    # diagnostic evidence — preserve it as a .corrupt sidecar rather than silently
    # overwriting it (AL-015). The transient stateError flag is never persisted.
    _, error = read_json_object(path)
    if error and os.path.exists(path):
        backup = path + ".corrupt"
        if not os.path.exists(backup):
            try:
                os.replace(path, backup)
            except OSError:
                pass
    payload = {k: v for k, v in state.items() if k != "stateError"}
    write_json(path, payload)


def _record_training_job(job: dict) -> None:
    state = _load_training_state()
    jobs = [j for j in state.get("jobs", []) if isinstance(j, dict) and j.get("jobId") != job.get("jobId")]
    jobs.append(job)
    state["jobs"] = jobs[-20:]
    _save_training_state(state)


def _upsert_adapter_record(adapter: dict) -> None:
    state = _load_training_state()
    adapters = [a for a in state.get("adapters", []) if isinstance(a, dict) and a.get("adapterId") != adapter.get("adapterId")]
    adapters.append(adapter)
    state["adapters"] = adapters[-20:]
    _save_training_state(state)


def _adapter_for(adapter_id: str):
    if adapter_id in ("stable_audio3", "sa3"):
        from adapters import stable_audio3_adapter as ad
        return ad
    if adapter_id == "transform":
        # Real RAVE/MelodyFlow backend swaps in here when available; until then the
        # deterministic fake transform (mirrors stable_audio3 → fake_adapter).
        from adapters import transform_adapter as ad
        return ad
    if adapter_id == "soulx":
        # FMS Phase-3 sing mode: fake legato-beep score renderer; the real SoulX-Singer
        # PC/SSH backend swaps in when configured (MOSH_SOULX_SSH_HOST + enrolled voice).
        from adapters import soulx_adapter as ad
        return ad
    return fake_adapter


def _run_job(job_id: str) -> None:
    with _lock:
        job = _jobs[job_id]
        if job.get("cancel"):
            job["status"] = "cancelled"
            return
        job["status"] = "rendering"
        adapter_id = job.get("adapter", "fake")
    try:
        soulx_real = False
        if adapter_id == "soulx":
            try:
                from adapters import soulx_adapter as _sx
                soulx_real = _sx.available()
            except Exception:  # noqa: BLE001 — import failure degrades to fake anyway
                soulx_real = False
        if adapter_id in ("fake", "transform") or (adapter_id == "soulx" and not soulx_real):
            # Stepped progress for the cheap stub (debounced renders are slow IRL).
            for step in range(1, 6):
                with _lock:
                    if _jobs[job_id].get("cancel"):
                        _jobs[job_id]["status"] = "cancelled"
                        return
                    _jobs[job_id]["progress"] = step / 6.0
                time.sleep(0.05)
        else:
            with _lock:
                _jobs[job_id]["progress"] = 0.3   # coarse: real model render is one shot

        ad = _adapter_for(adapter_id)
        # Honor a cancel that arrived in the window between the last progress check
        # and this (potentially seconds-long) render — otherwise the job runs to
        # completion and writes output the user asked to discard.
        with _lock:
            if _jobs[job_id].get("cancel"):
                _jobs[job_id]["status"] = "cancelled"
                return
        manifest = ad.render(job["input_wav"], job["output_wav"], job["params"])
        os.makedirs(os.path.dirname(os.path.abspath(job["manifest"])), exist_ok=True)
        with open(job["manifest"], "w") as f:
            json.dump(manifest, f)
        with _lock:
            _jobs[job_id]["progress"] = 1.0
            _jobs[job_id]["status"] = "ready"
            _jobs[job_id]["result"] = manifest
    except Exception as e:  # noqa: BLE001
        with _lock:
            _jobs[job_id]["status"] = "error"
            _jobs[job_id]["error"] = str(e)


def _run_training_job(job_id: str) -> None:
    with _training_lock:
        job = _training_jobs[job_id]
        if job.get("cancel"):
            job["status"] = "cancelled"
            _record_training_job({
                "jobId": job_id, "status": "cancelled", "progress": job.get("progress", 0.0),
                "bundlePath": job.get("bundle_path", ""), "outputDir": job.get("output_dir", ""),
                "error": "", "updatedAt": time.time(),
            })
            return
        job["status"] = "running"
    try:
        for step in range(1, 6):
            with _training_lock:
                if _training_jobs[job_id].get("cancel"):
                    _training_jobs[job_id]["status"] = "cancelled"
                    _record_training_job({
                        "jobId": job_id, "status": "cancelled", "progress": _training_jobs[job_id].get("progress", 0.0),
                        "bundlePath": job.get("bundle_path", ""), "outputDir": job.get("output_dir", ""),
                        "error": "", "updatedAt": time.time(),
                    })
                    return
                _training_jobs[job_id]["progress"] = step / 6.0
            time.sleep(0.05)

        result = train_lora(job["bundle_path"], job["output_dir"], job["config"])
        with _training_lock:
            _training_jobs[job_id]["progress"] = 1.0
            _training_jobs[job_id]["status"] = "ready"
            _training_jobs[job_id]["result"] = result
        _record_training_job({
            "jobId": job_id,
            "status": "ready",
            "progress": 1.0,
            "bundlePath": job["bundle_path"],
            "outputDir": job["output_dir"],
            "artifactPath": result["artifact_path"],
            "manifestPath": result["manifest_path"],
            "bundleHash": result["bundle_hash"],
            "quality": result["quality"],
            "error": "",
            "updatedAt": time.time(),
        })
    except Exception as e:  # noqa: BLE001
        with _training_lock:
            _training_jobs[job_id]["status"] = "error"
            _training_jobs[job_id]["error"] = str(e)
        _record_training_job({
            "jobId": job_id, "status": "error", "progress": _training_jobs[job_id].get("progress", 0.0),
            "bundlePath": job.get("bundle_path", ""), "outputDir": job.get("output_dir", ""),
            "error": str(e), "updatedAt": time.time(),
        })


def _worker_loop() -> None:
    """The ONE thread that ever runs an adapter — serializes inference so the
    process-global MLX model is never touched concurrently (05 §6 priority queue)."""
    while True:
        _prio, _seq_n, job_id = _job_q.get()
        try:
            _run_job(job_id)
        finally:
            _job_q.task_done()


def _training_worker_loop() -> None:
    while True:
        _prio, _seq_n, job_id = _training_q.get()
        try:
            _run_training_job(job_id)
        finally:
            _training_q.task_done()


def _normalize_training_submit(data: dict) -> dict:
    corpus_bundle = str(data.get("corpusBundle", data.get("corpus_bundle", ""))).strip()
    priority = data.get("priority", 5)
    output_dir = str(data.get("outputDir", "")).strip()
    if not output_dir:
        output_dir = str(data.get("output_dir", "")).strip()
    config = data.get("config", {})
    bundle_payload = data.get("bundle", {})
    if isinstance(bundle_payload, dict):
        bundle_path = str(bundle_payload.get("bundle_path", "")).strip()
        if bundle_path:
            corpus_bundle = corpus_bundle or bundle_path
    try:
        priority = int(priority)
    except Exception:
        priority = 5
    return {
        "corpus_bundle": corpus_bundle,
        "output_dir": output_dir,
        "config": config,
        "priority": priority,
    }


def _resolve_training_status_url(host: str, job_id: str) -> str:
    host = host.strip()
    if host and not host.startswith("http://") and not host.startswith("https://"):
        return f"http://{host}/training/jobs/{job_id}"
    return f"{host.rstrip('/')}/training/jobs/{job_id}"


def _create_training_job_record(data: dict, host: str) -> dict:
    normalized = _normalize_training_submit(data)
    bundle_path = normalized["corpus_bundle"]
    if not bundle_path or not os.path.isdir(bundle_path):
        return {"error": "corpusBundle missing", "status_code": 400}
    job_id = uuid.uuid4().hex[:12]
    output_dir = normalized["output_dir"]
    if not output_dir:
        output_dir = os.path.join(bundle_path, "training-output", job_id)
    os.makedirs(output_dir, exist_ok=True)
    config = normalized["config"]
    with _training_lock:
        _training_jobs[job_id] = {
            "status": "queued",
            "progress": 0.0,
            "bundle_path": bundle_path,
            "output_dir": output_dir,
            "config": config,
            "cancel": False,
            "error": "",
        }
    _record_training_job({
        "jobId": job_id,
        "status": "queued",
        "progress": 0.0,
        "bundlePath": bundle_path,
        "outputDir": output_dir,
        "error": "",
        "updatedAt": time.time(),
    })
    _training_q.put((int(normalized["priority"]), next(_training_seq), job_id))
    return {
        "ok": True,
        "jobId": job_id,
        "status_url": _resolve_training_status_url(host, job_id),
        "bundlePath": bundle_path,
        "outputDir": output_dir,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = f"MoshService/{SERVICE_VERSION}"

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        """Parse the POST body as JSON.

        Returns a dict on success — or {} for an empty or malformed-JSON body,
        which callers already treat as "no fields" and 400 on the missing args
        (PR #297). Returns None when the request was already answered here with a
        definitive 400/413 (a non-numeric or oversized Content-Length); do_POST
        must stop when it sees None.
        """
        # _json_malformed lets a route distinguish a garbled body from a legitimately
        # empty one (both otherwise return {}); routes that mutate on the body (e.g.
        # /training/import-registry) reject the former with 400 instead of applying {}.
        self._json_malformed = False
        try:
            n = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            self._send(400, {"ok": False, "error": "invalid Content-Length"})
            return None
        if n <= 0:
            return {}
        if n > MAX_BODY_BYTES:
            # Reject BEFORE reading — never allocate/hang on a huge claimed length.
            self._send(413, {"ok": False,
                             "error": f"request body too large (max {MAX_BODY_BYTES} bytes)"})
            return None
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:  # noqa: BLE001
            self._json_malformed = True
            return {}

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        query = {}
        if "?" in self.path:
            for kv in self.path.split("?", 1)[1].split("&"):
                if "=" in kv:
                    k, v = kv.split("=", 1)
                    query[k] = v

        if path == "/health":
            adapters = ["fake", "transform", "soulx"] + (["stable_audio3"] if SA3_ENABLED else [])
            self._send(200, {"ok": True, "service": "mosh-generative",
                             "version": SERVICE_VERSION, "build": SERVICE_BUILD,
                             "uptime_s": round(time.time() - START_TIME, 1),
                             "adapters": adapters, "transcribe": _transcribe_available(),
                             "sketch": _sketch_available(),
                             "whisper": _whisper_available(),
                             "skeleton": _skeleton_available(),
                             "phonology": _phonology_available(),
                             "compiler": True,
                             "bestofn": True})
        elif path == "/capabilities":
            adapters = [FAKE_ADAPTER, TRANSFORM_ADAPTER, SOULX_ADAPTER] + ([_sa3_descriptor()] if SA3_ENABLED else [])
            training = [_training_descriptor()] if TRAINING_ENABLED else []
            self._send(200, {"ok": True, "adapters": adapters, "training": training,
                             "transcribe": {"available": _transcribe_available(), "modes": ["mono", "poly"]},
                             "sketch": {"available": _sketch_available(), "vocab": ["kick", "snare", "hat"],
                                        "grid": "16th", "bars": [1, 2]},
                             "whisper": {"available": _whisper_available()},
                             # Parity with /health, which already reports these two (guest-
                             # degradation pass): a guest Mac without the skeleton/phonology
                             # venvs still gets a full, honest /capabilities response.
                             "skeleton": {"available": _skeleton_available()},
                             "phonology": {"available": _phonology_available()},
                             "service_build": SERVICE_BUILD})
        elif path == "/colors":
            try:
                from colors import runtime as CR
                self._send(200, {"ok": True, "colors": CR.descriptor(),
                                 "lab_alpha_max": CR._meta().get("lab_alpha_max", 0.4)})
            except Exception as e:  # noqa: BLE001
                self._send(503, {"ok": False, "error": f"colors unavailable: {e}", "colors": []})
        elif path == "/loras":
            # LoRA rack discovery (drop-in library dir, RAVE_MODEL_DIR posture).
            try:
                from loras import registry as LORA_R
                self._send(200, {"ok": True, "loras": [
                    {k: v for k, v in e.items() if k != "file"}
                    for e in LORA_R.list_loras()
                ], "maxActive": LORA_R.MAX_ACTIVE})
            except Exception as e:  # noqa: BLE001
                self._send(503, {"ok": False, "error": f"loras unavailable: {e}", "loras": []})
        elif path == "/transform_targets":
            # Route C discovery: when the REAL RAVE backend is installed, list the
            # installed .ts model stems (concrete targets, no free-text). Otherwise the
            # Route B curated fake list + free-text.
            #
            # `capabilities` (guest-degradation pass, 2026-07-16): the native
            # `list_transform_targets` command forwards this whole object to the frontend
            # verbatim, so it doubles as the one generic "what's actually installed on this
            # Mac" carrier the UI loads lazily (ui/src/store.ts loadCapabilities, triggered
            # on first clip-menu/Gen-drawer open — never at startup) — see
            # _guest_capability_summary()'s docstring for why this endpoint specifically.
            # (The transform tier's own real-vs-fake bit lives at capabilities.transformReal;
            # no separate top-level field — the frontend only ever reads the nested one.)
            from adapters import transform_adapter as _tx
            caps = _guest_capability_summary()
            if _tx.available():
                self._send(200, {"ok": True, "targets": _tx.installed_targets(), "freeText": False,
                                 "capabilities": caps})
            else:
                self._send(200, {"ok": True,
                                 "targets": ["violin", "flute", "choir", "strings",
                                             "orchestra", "synth pad", "music box", "brass"],
                                 "freeText": True, "capabilities": caps})
        elif path == "/training/health":
            self._send(200, {
                "ok": True,
                "service": "mosh-training",
                "version": SERVICE_VERSION,
                "build": SERVICE_BUILD,
                "uptime_s": round(time.time() - START_TIME, 1),
                "backend": lora_trainer_adapter.backend_name(),
                "available": TRAINING_ENABLED,
            })
        elif path == "/training/capabilities":
            self._send(200, {"ok": True, "training": _training_descriptor(), "service_build": SERVICE_BUILD})
        elif path == "/training/sources":
            registry = load_registry(_training_registry_path())
            self._send(200, {"ok": True, "registry": registry, "sources": registry.get("sources", [])})
        elif path == "/training/state":
            self._send(200, {"ok": True, "state": _load_training_state()})
        elif path == "/status":
            jid = query.get("jobId", "")
            with _lock:
                job = _jobs.get(jid)
                if job is None:
                    self._send(404, {"ok": False, "error": "unknown jobId"})
                    return
                self._send(200, {"ok": True, "jobId": jid, "status": job["status"],
                                 "progress": job.get("progress", 0.0),
                                 "outputWav": job["output_wav"],
                                 "error": job.get("error"),
                                 "manifest": job.get("result")})
        elif path == "/training/status":
            jid = query.get("jobId", "")
            with _training_lock:
                job = _training_jobs.get(jid)
                if job is None:
                    self._send(404, {"ok": False, "error": "unknown jobId"})
                    return
                self._send(200, {
                    "ok": True,
                    "jobId": jid,
                    "status": job["status"],
                    "progress": job.get("progress", 0.0),
                    "outputDir": job.get("output_dir", ""),
                    "error": job.get("error"),
                    "result": job.get("result"),
                })
        elif path.startswith("/training/jobs/"):
            jid = path.rsplit("/", 1)[-1]
            with _training_lock:
                job = _training_jobs.get(jid)
                if job is None:
                    self._send(404, {"ok": False, "error": "unknown jobId"})
                    return
                self._send(200, {
                    "ok": True,
                    "jobId": jid,
                    "status": job["status"],
                    "progress": job.get("progress", 0.0),
                    "outputDir": job.get("output_dir", ""),
                    "error": job.get("error"),
                    "result": job.get("result"),
                })
        else:
            self._send(404, {"ok": False, "error": f"unknown path: {path}"})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        data = self._read_json()
        if data is None:  # a 400/413 was already sent for a bad/oversized Content-Length
            return
        if path == "/submit":
            adapter_id = data.get("adapter", "fake")
            if adapter_id in ("stable_audio3", "sa3") and not SA3_ENABLED:
                self._send(503, {"ok": False, "error": "stable_audio3 unavailable "
                                 "(model/venv absent or MOSH_ENABLE_SA3 not set)"})
                return
            input_wav = data.get("inputWav", "")
            output_wav = data.get("outputWav", "")
            if not input_wav or not os.path.exists(input_wav):
                self._send(400, {"ok": False, "error": "inputWav missing"})
                return
            job_id = uuid.uuid4().hex[:12]
            with _lock:
                _jobs[job_id] = {
                    "status": "queued", "progress": 0.0, "adapter": adapter_id,
                    "input_wav": input_wav, "output_wav": output_wav,
                    "manifest": data.get("manifest", output_wav + ".manifest.json"),
                    "params": data.get("params", {}), "cancel": False,
                }
            _job_q.put((int(data.get("priority", 5)), next(_seq), job_id))
            self._send(200, {"ok": True, "jobId": job_id})
        elif path == "/cancel":
            jid = data.get("jobId", "")
            with _lock:
                if jid in _jobs:
                    _jobs[jid]["cancel"] = True
            self._send(200, {"ok": True})
        elif path == "/stitch_windows":
            # Render-ahead primitive (Lane A): overlap-add crossfade a set of already-rendered
            # window WAVs into ONE continuous file, reusing the exact owner-measured-gapless
            # stitch.stitch_windows (1ms equal-power default). Pure + hermetic (stdlib wave) —
            # the native RenderAheadScheduler calls this after each new window completes to
            # extend the growing render-ahead file. Byte-stable: appending a window never
            # perturbs earlier seams (each seam depends only on its two neighbours), so the
            # region the playhead is reading stays identical across an extend.
            wins = data.get("windows", []) or []
            out = data.get("outPath", "")
            if not wins or not out:
                self._send(400, {"ok": False, "error": "windows[] and outPath required"})
                return
            missing = [w for w in wins if not (isinstance(w, str) and os.path.exists(w))]
            if missing:
                self._send(400, {"ok": False, "error": f"window(s) missing: {missing[:3]}"})
                return
            try:
                target = float(data.get("targetSeconds") or 0.0)
                if target <= 0.0:
                    target = sum(stitch.wav_duration(w) for w in wins)
                xfade = float(data.get("xfadeMs") or 1.0)
                stitch.stitch_windows(wins, out, target, xfade_ms=xfade)
                self._send(200, {"ok": True, "outPath": out,
                                 "durationSeconds": round(stitch.wav_duration(out), 3),
                                 "windows": len(wins), "xfadeMs": xfade})
            except Exception as e:  # noqa: BLE001
                self._send(500, {"ok": False, "error": f"stitch failed: {e}"})
        elif path == "/transcribe":
            # Audio -> MIDI via Basic Pitch, run as a subprocess under the dedicated
            # transcribe venv so its deps stay isolated. Synchronous: the server is
            # threaded (ThreadingHTTPServer), so one transcription doesn't block other
            # requests, and inference on a short clip is ~1-3s. Returns notes in SECONDS.
            input_wav = data.get("inputWav", "")
            mode = data.get("mode", "mono")
            if mode not in ("mono", "poly"):
                mode = "mono"
            if not input_wav or not os.path.exists(input_wav):
                self._send(400, {"ok": False, "error": "inputWav missing or not found"})
                return
            py = _basic_pitch_py()
            if not os.path.isfile(py):
                self._send(503, {"ok": False, "error": "transcription_unavailable "
                                 "(run service/transcribe/setup-transcribe.sh)"})
                return
            cli = os.path.join(SERVICE_DIR, "transcribe", "transcribe_cli.py")
            try:
                proc = subprocess.run([py, cli, input_wav, mode],
                                      capture_output=True, text=True, timeout=180)
            except subprocess.TimeoutExpired:
                self._send(504, {"ok": False, "error": "transcription timed out"})
                return
            except OSError as e:  # bad interpreter / unexecutable cli / spawn failure
                self._send(500, {"ok": False, "error": f"transcription failed to start: {e}"})
                return
            out = (proc.stdout or "").strip()
            try:
                payload = json.loads(out)
            except (json.JSONDecodeError, ValueError):
                tail = (proc.stderr or "").strip()[-400:]
                self._send(500, {"ok": False, "error": f"transcription failed: {tail or 'no output'}"})
                return
            self._send(200 if payload.get("ok") else 500, payload)
        elif path == "/transcribe_words":
            # Word-level speech transcription via Whisper (the mumble-take word path), run as
            # a subprocess under the dedicated whisper venv. Returns words with per-word
            # confidence (times in SECONDS). When the venv is ABSENT we degrade to EMPTY
            # words (NOT a 503, NOT invented words): the mumble-take rhythm sheet still builds
            # and every slot becomes a gap the loop fills — misrecognized lyrics would be
            # worse than gaps.
            input_wav = data.get("inputWav", "")
            if not input_wav or not os.path.exists(input_wav):
                self._send(400, {"ok": False, "error": "inputWav missing or not found"})
                return
            py = _whisper_py()
            if not os.path.isfile(py):
                self._send(200, {"ok": True, "words": [], "backend": "unavailable"})
                return
            cli = os.path.join(SERVICE_DIR, "whisper", "whisper_cli.py")
            try:
                proc = subprocess.run([py, cli, input_wav], capture_output=True, text=True, timeout=180)
            except subprocess.TimeoutExpired:
                self._send(504, {"ok": False, "error": "word transcription timed out"})
                return
            except OSError as e:
                self._send(500, {"ok": False, "error": f"word transcription failed to start: {e}"})
                return
            wout = (proc.stdout or "").strip()
            try:
                payload = json.loads(wout)
            except (json.JSONDecodeError, ValueError):
                tail = (proc.stderr or "").strip()[-400:]
                self._send(500, {"ok": False, "error": f"word transcription failed: {tail or 'no output'}"})
                return
            if payload.get("ok"):
                payload.setdefault("backend", "whisper")
            self._send(200 if payload.get("ok") else 500, payload)
        elif path == "/mumble_spec":
            # Mumble-take spec builder (Finish-My-Song Phase 3): note onsets + confidence-gated
            # words → a lyric constraint spec (syllables/bar + stress + word anchors/gaps).
            # IN-PROCESS + deterministic (stdlib note/word math). The native side already has
            # the notes (Basic Pitch) + words (Whisper); this only does the binning.
            try:
                from lyrics import mumble
                notes = data.get("notes", []) or []
                words = data.get("words", []) or []
                bpm = float(data.get("bpm", 120) or 120)
                ts = data.get("timeSig", [4, 4]) or [4, 4]
                conf = float(data.get("confThreshold", 0.6) or 0.6)
                grid = str(data.get("grid", "1/16") or "1/16")
                self._send(200, mumble.build_spec_from_take(
                    notes, words, bpm, time_sig=(int(ts[0]), int(ts[1])),
                    conf_threshold=conf, grid=grid,
                    topic=str(data.get("topic", "")), mood=str(data.get("mood", ""))))
            except Exception as e:  # noqa: BLE001
                self._send(500, {"ok": False, "error": f"mumble spec error: {e}"})
        elif path == "/skeleton_spec":
            # Phase-2 mumble -> rhythmic SKELETON (roadmap §2): a hummed/mumbled take -> notes
            # (+ optional F0) -> a WORDLESS, editable lyric LineSpec (syllable grid + stress; the
            # Phase-1 engine fills the words). The binning runs IN-PROCESS + deterministic (stdlib
            # skeleton.core, golden-covered); only the signal extraction is subprocessed.
            # GRACEFUL DEGRADATION: the FCPE venv (notes + F0, finer nuclei) is an UPGRADE — when
            # absent we reuse the Basic-Pitch /transcribe venv (notes only, f0=None) -> #178-quality
            # rhythm with ZERO new install; genuinely zero notes detected -> a clean
            # no_melody_detected. Guest-degradation pass: those two "no notes" causes used to
            # collapse into the SAME no_melody_detected string even when Basic Pitch was simply
            # NOT INSTALLED (a guest Mac with no ~/Library/Mosh/venvs/transcribe) — telling a
            # tester "no melody detected in the take" about a take that plainly has melody is
            # actively misleading. The native side (MoshOps.cpp cmdBuildSkeletonFromClip's
            # `land`) only special-cases the EXACT string "no_melody_detected"; any other
            # non-empty `error` is shown to the user verbatim, so the message below IS the
            # user-facing text.
            input_wav = data.get("inputWav", "")
            if not input_wav or not os.path.exists(input_wav):
                self._send(400, {"ok": False, "error": "inputWav missing or not found"})
                return
            try:
                bpm = float(data.get("bpm", 120) or 120)
            except (TypeError, ValueError):
                bpm = 120.0
            ts = data.get("timeSig", [4, 4]) or [4, 4]
            grid = str(data.get("grid", "1/16") or "1/16")
            # NOTES come from Basic Pitch (the robust onset detector) — the rhythm, always. The
            # FCPE venv is the UPGRADE: it adds an F0 contour so a re-articulated sustained note
            # splits into multiple syllable nuclei. Absent FCPE → f0=None → identity nuclei.
            notes: list = []
            bp_py = _basic_pitch_py()
            if os.path.isfile(bp_py):
                cli = os.path.join(SERVICE_DIR, "transcribe", "transcribe_cli.py")
                try:
                    proc = subprocess.run([bp_py, cli, input_wav, "mono"],
                                          capture_output=True, text=True, timeout=180)
                    bp = json.loads((proc.stdout or "").strip())
                    if bp.get("ok"):
                        notes = bp.get("notes", []) or []
                except (subprocess.TimeoutExpired, OSError, json.JSONDecodeError, ValueError):
                    pass
            if not notes:
                if not os.path.isfile(bp_py):
                    self._send(200, {"ok": False,
                                     "error": "audio-to-MIDI transcription isn't installed on this "
                                              "Mac (run setup-guest.sh, or setup-transcribe.sh, to "
                                              "enable Build flow / Build lyrics / Convert to MIDI)",
                                     "lines": []})
                else:
                    self._send(200, {"ok": False, "error": "no_melody_detected", "lines": []})
                return
            f0 = None
            sk_py = _skeleton_py()
            if os.path.isfile(sk_py):     # UPGRADE: FCPE F0 contour for sub-note nuclei splitting
                cli = os.path.join(SERVICE_DIR, "skeleton", "skeleton_cli.py")
                try:
                    proc = subprocess.run([sk_py, cli, input_wav],
                                          capture_output=True, text=True, timeout=185)
                    payload = json.loads((proc.stdout or "").strip())
                    if payload.get("ok"):
                        f0 = payload.get("f0")
                except (subprocess.TimeoutExpired, OSError, json.JSONDecodeError, ValueError):
                    pass
            # Stage-1 upgrade (kill-shot B GO 2026-07-04): an in-process energy envelope turns
            # the v1 nuclei into evidence-pruned, melisma-grouped v3 slots; generous ASR words
            # (whisper venv present) add v4 per-phrase syllable budgets. Every rung DEGRADES:
            # non-PCM/unreadable audio -> env=None -> today's v1 lines byte-identical (the
            # fmt-tag==1 guard in read_pcm_mono keeps that ladder deterministic across
            # interpreters — afconvert's WAVE_EXTENSIBLE reads on 3.12+ but not 3.11).
            try:
                from skeleton import core as skel
                env = None
                try:
                    pcm = skel.read_pcm_mono(input_wav)
                    if pcm and pcm[0]:
                        env = skel.energy_envelope(pcm[0], pcm[1]) or None  # [] (sub-window take) -> v1 floor
                except Exception as e:  # noqa: BLE001 — the envelope is an upgrade, never a breaker
                    env = None
                    print(f"[skeleton_spec] envelope skipped: {e}", file=sys.stderr)
                words = None
                wh_py = _whisper_py()
                if env and bool(data.get("asr", True)) and os.path.isfile(wh_py):
                    # Generous decode (model `small`, the KS-B validated config). The SAME
                    # word list feeds two consumers: the v4 syllable budgets (start/end/syl,
                    # ungated) AND — pipeline correction 2026-07-04 — lyric EXTRACTION
                    # (word/confidence): his real words must be detected and PRESERVED,
                    # never overwritten by generation. The 0.6-confidence lyric-anchor gate
                    # in /mumble_spec is untouched.
                    cli = os.path.join(SERVICE_DIR, "whisper", "whisper_cli.py")
                    try:
                        proc = subprocess.run([wh_py, cli, input_wav, "small"],
                                              capture_output=True, text=True, timeout=180)
                        payload = json.loads((proc.stdout or "").strip())
                        if payload.get("ok"):
                            from phonology import core as ph
                            pron = ph.Pronouncer()
                            ws = []
                            for w in payload.get("words", []) or []:
                                c = str(w.get("word", "")).strip(" .,!?'\"-").lower()
                                if not any(ch.isalpha() for ch in c):
                                    continue
                                try:  # one malformed word must not discard the rest
                                    ws.append({"word": str(w.get("word", "")).strip(),
                                               "start": float(w["start"]), "end": float(w["end"]),
                                               "confidence": float(w.get("confidence", 0) or 0),
                                               "syl": pron.syllables(c) or 1})
                                except (KeyError, TypeError, ValueError):
                                    continue
                            words = ws or None
                    except Exception as e:  # noqa: BLE001 — ASR is an upgrade, never a breaker
                        print(f"[skeleton_spec] ASR budget skipped: {e}", file=sys.stderr)
                self._send(200, skel.build_skeleton_spec(
                    notes, f0=f0, bpm=bpm, time_sig=(int(ts[0]), int(ts[1])), grid=grid,
                    topic=str(data.get("topic", "")), mood=str(data.get("mood", "")),
                    env=env, words=words,
                    extract_lyrics=bool(data.get("extract", True)),
                    extract_use_llm=bool(data.get("extractLlm", True))))
            except Exception as e:  # noqa: BLE001
                self._send(500, {"ok": False, "error": f"skeleton spec error: {e}"})
        elif path == "/sketch":
            # Sketch Phase 0: beatbox WAV -> 3-class drum hits on a 16th grid, run as a
            # subprocess under the dedicated sketch venv so librosa's deps stay isolated.
            # Synchronous (ThreadingHTTPServer => other requests are unaffected); onset
            # analysis on a 1-2 bar take is sub-second. DETERMINISTIC for (wav, bpm, bars).
            input_wav = data.get("inputWav", "")
            try:
                bpm = float(data.get("bpm", 0))
            except (TypeError, ValueError):
                bpm = 0.0
            try:
                bars = int(data.get("bars", 1) or 1)
            except (TypeError, ValueError):
                bars = 1
            if not input_wav or not os.path.exists(input_wav):
                self._send(400, {"ok": False, "error": "inputWav missing or not found"})
                return
            if bpm < 20.0 or bpm > 300.0:
                self._send(400, {"ok": False, "error": "bpm must be 20-300 (known tempo)"})
                return
            py = _sketch_py()
            if not os.path.isfile(py):
                self._send(503, {"ok": False, "error": "sketch_unavailable "
                                 "(run service/sketch/setup-sketch.sh)"})
                return
            cli = os.path.join(SERVICE_DIR, "sketch", "beatbox_cli.py")
            try:
                proc = subprocess.run([py, cli, input_wav, repr(bpm), str(bars)],
                                      capture_output=True, text=True, timeout=120)
            except subprocess.TimeoutExpired:
                self._send(504, {"ok": False, "error": "sketch analysis timed out"})
                return
            except OSError as e:  # bad interpreter / unexecutable cli / spawn failure
                self._send(500, {"ok": False, "error": f"sketch failed to start: {e}"})
                return
            out = (proc.stdout or "").strip()
            try:
                payload = json.loads(out)
            except (json.JSONDecodeError, ValueError):
                tail = (proc.stderr or "").strip()[-400:]
                self._send(500, {"ok": False, "error": f"sketch failed: {tail or 'no output'}"})
                return
            self._send(200 if payload.get("ok") else 500, payload)
        elif path == "/generate_recipe":
            try:
                self._send(200, _generate_recipe_payload(data))
            except RuntimeError as e:
                self._send(400, {"ok": False, "error": str(e)})
            except Exception as e:  # noqa: BLE001
                self._send(500, {"ok": False, "error": f"recipe generation error: {e}"})
        elif path == "/get_rhymes":
            # Phonology rhyme search (Finish-My-Song rung 1). Fast + deterministic; no
            # LLM. Prefer the dedicated phonology venv (so the precise cmudict path works
            # even when the service interpreter lacks it); otherwise run the core
            # in-process (precise if cmudict is importable here, else a stdlib heuristic).
            word = str(data.get("word", "")).strip()
            if not word:
                self._send(400, {"ok": False, "error": "word missing"})
                return
            clean = bool(data.get("clean", False))   # Bar IQ D — raw by default; clean filters profanity
            strictness = data.get("strictness", "slant")
            if strictness not in ("perfect", "slant", "free"):
                strictness = "slant"
            try:
                max_n = int(data.get("maxN", 50))
            except (TypeError, ValueError):
                max_n = 50
            max_n = max(1, min(max_n, 200))
            syllables = data.get("syllables", None)
            try:
                syllables = int(syllables) if syllables not in (None, "", 0) else None
            except (TypeError, ValueError):
                syllables = None
            py = _phonology_py()
            if os.path.isfile(py):
                cli = os.path.join(SERVICE_DIR, "phonology", "phonology_cli.py")
                argv = [py, cli, "get_rhymes", word, strictness, str(max_n),
                        str(syllables if syllables is not None else "")]
                try:
                    proc = subprocess.run(argv, capture_output=True, text=True, timeout=60)
                except subprocess.TimeoutExpired:
                    self._send(504, {"ok": False, "error": "rhyme lookup timed out"})
                    return
                except OSError as e:
                    self._send(500, {"ok": False, "error": f"rhyme lookup failed to start: {e}"})
                    return
                out = (proc.stdout or "").strip()
                try:
                    payload = json.loads(out)
                except (json.JSONDecodeError, ValueError):
                    tail = (proc.stderr or "").strip()[-400:]
                    self._send(500, {"ok": False, "error": f"rhyme lookup failed: {tail or 'no output'}"})
                    return
                self._send(200 if payload.get("ok") else 500,
                           _merge_palette_rhymes(payload, clean) if payload.get("ok") else payload)
            else:
                try:
                    from phonology import core as _ph
                    payload = _ph.get_rhymes(word, strictness=strictness,
                                             max_n=max_n, syllables=syllables)
                    self._send(200, _merge_palette_rhymes(payload, clean))
                except Exception as e:  # noqa: BLE001
                    self._send(500, {"ok": False, "error": f"phonology error: {e}"})
        elif path in ("/complete_lyrics", "/fill_lyric_gap", "/suggest_next_line"):
            # Lyric generation loop (Finish-My-Song L2, fake-first): propose →
            # validate(phonology) → retry → rank → top-N. Runs IN-PROCESS (the core is
            # stdlib + the phonology core); deterministic with the fake backend. The
            # native side builds `spec` from the lyric sheet and lands the proposals.
            spec = data.get("spec", {})
            if not isinstance(spec, dict) or not spec.get("lines"):
                self._send(400, {"ok": False, "error": "spec.lines required"})
                return
            regen = {}
            for k, v in (data.get("regen", {}) or {}).items():
                try:
                    regen[int(k)] = int(v)
                except (TypeError, ValueError):
                    pass
            try:
                from lyrics import core as lyr
                if path == "/complete_lyrics":
                    payload = lyr.complete(spec, regen=regen)
                elif path == "/fill_lyric_gap":
                    payload = lyr.fill_gap(spec, int(data.get("lineIndex", 0)), regen=regen)
                else:
                    payload = lyr.suggest_next_line(spec, int(data.get("afterIndex", -1)), regen=regen)
                self._send(200, payload)
            except Exception as e:  # noqa: BLE001
                self._send(500, {"ok": False, "error": f"lyric generation error: {e}"})
        elif path == "/compile_render":
            # Prompt compiler (generative-only v1): a loose instruction → a VALIDATED
            # Stable-Audio render envelope (prompt + nl + colours + lab + seed, or a
            # transform target+strength). Runs IN-PROCESS (stdlib + colors.json); the
            # FAKE backend is deterministic, the real LLM (brain_client) swaps in behind
            # the same seam. The native side applies the envelope via set_render_param.
            instruction = str(data.get("instruction", "")).strip()
            if not instruction:
                self._send(400, {"ok": False, "error": "instruction required"})
                return
            intensity = data.get("intensity", None)
            try:
                intensity = int(intensity) if intensity not in (None, "") else None
            except (TypeError, ValueError):
                intensity = None
            backend = data.get("backend") if data.get("backend") in ("fake", "llm") else None
            try:
                from compiler import core as comp
                self._send(200, comp.compile(instruction, intensity=intensity, backend=backend))
            except Exception as e:  # noqa: BLE001
                self._send(500, {"ok": False, "error": f"compile error: {e}"})
        elif path == "/analyze_lyrics":
            # Precise per-line phonology (Finish-My-Song L1): syllables, stress contour,
            # rhyme grade vs the group anchor, per-word slots — the flow-visualizer feed.
            # IN-PROCESS, deterministic, no LLM. Reuses the same gate as generation.
            spec = data.get("spec", {})
            if not isinstance(spec, dict) or not spec.get("lines"):
                self._send(400, {"ok": False, "error": "spec.lines required"})
                return
            try:
                from lyrics import core as lyr
                self._send(200, lyr.analyze(spec))
            except Exception as e:  # noqa: BLE001
                self._send(500, {"ok": False, "error": f"lyric analysis error: {e}"})
        elif path == "/escalate_candidates":
            # WP-11 best-of-n serving (escalate-only — the UI already holds its
            # single-shot reply as candidate #0 and re-executes it on degraded/error,
            # so failure here never costs an extra cloud call). Draws n-1 more
            # candidates via brain_client (parallel, budgeted), scores them against
            # the POSTED id-manifest + catalog (verifiable checks), ranks, and
            # archives the chosen/rejected set as DPO fuel. MOSH_ENABLE_BESTOFN=0
            # pins the deterministic fake backend.
            try:
                from bestofn import runtime as bofn
                if not isinstance(data.get("first"), dict):
                    self._send(400, {"ok": False, "error": "first (single-shot reply) required"})
                    return
                self._send(200, bofn.escalate(data))
            except Exception as e:  # noqa: BLE001
                self._send(500, {"ok": False, "error": f"escalate error: {e}"})
        elif path == "/archive_pair":
            # WP-11 — corrective validator-retry pairs (failed original vs corrected
            # retry) ride the same best-effort DPO appender. Never fatal by contract.
            try:
                from bestofn import runtime as bofn
                row = dict(data)
                row["source"] = str(row.get("source") or "corrective-retry")
                self._send(200, {"ok": True, "archived": bofn.archive_append(row)})
            except Exception as e:  # noqa: BLE001
                self._send(500, {"ok": False, "error": f"archive error: {e}"})
        elif path == "/style_corpus":
            # §7 style-RAG flywheel — the user-owned voice corpus (backend-only management).
            # action: "add" (the artist's OWN lyrics) | "stats" (counts only) | "clear".
            # In-process, deterministic; retrieval/biasing happens inside the gen loop.
            try:
                from lyrics import style_corpus
                action = str(data.get("action", "stats"))
                sc = style_corpus.StyleCorpus()
                if action == "add":
                    lines = [str(x) for x in (data.get("lines", []) or [])]
                    added = sc.add_lines(lines, meta={"source": str(data.get("source", "user"))})
                    # Bar IQ B — the flywheel ALSO feeds the vocabulary palette: harvest the
                    # accepted lines' content words (pronounced via the venv so slang gets real
                    # phones). Best-effort — never break the corpus add.
                    try:
                        from lyrics.vocab import VocabPalette
                        from lyrics.style_corpus import _content_tokens
                        toks = sorted({t for ln in lines for t in _content_tokens(ln)})
                        VocabPalette().harvest_from_corpus(lines, phones_map=_pronounce_words(toks))
                    except Exception as e:  # noqa: BLE001
                        sys.stderr.write(f"[service] vocab harvest skipped (additive, non-fatal): {e}\n")
                    self._send(200, {"ok": True, "added": added, **sc.stats()})
                elif action == "clear":
                    sc.clear()
                    self._send(200, {"ok": True, "lines": 0})
                else:
                    self._send(200, sc.stats())
            except Exception as e:  # noqa: BLE001
                self._send(500, {"ok": False, "error": f"style corpus error: {e}"})
        elif path == "/vocab":
            # Bar IQ B — the vocabulary palette (backend-only). action: "add" (manual words +
            # register) | "harvest" (content words from lines) | "seed" (load the bundled open
            # seed) | "stats" (counts only). Words are pronounced via the phonology venv so
            # slang gets real g2p phones. Copyright-clean: words + pronunciations, never lines.
            try:
                from lyrics.vocab import VocabPalette, seed_words
                action = str(data.get("action", "stats"))
                pal = VocabPalette()
                if action == "add":
                    words = [str(x) for x in (data.get("words", []) or [])]
                    register = str(data.get("register", "slang"))
                    added = pal.add_words(words, register=register, phones_map=_pronounce_words(words))
                    self._send(200, {"ok": True, "added": added, **pal.stats()})
                elif action == "harvest":
                    lines = [str(x) for x in (data.get("lines", []) or [])]
                    from lyrics.style_corpus import _content_tokens
                    toks = sorted({t for ln in lines for t in _content_tokens(ln)})
                    added = pal.harvest_from_corpus(lines, phones_map=_pronounce_words(toks))
                    self._send(200, {"ok": True, "added": added, **pal.stats()})
                elif action == "seed":
                    by_reg: dict = {}
                    for w, r in seed_words():
                        by_reg.setdefault(r, []).append(w)
                    total = 0
                    for r, ws in by_reg.items():
                        total += pal.add_words(ws, register=r, phones_map=_pronounce_words(ws))
                    self._send(200, {"ok": True, "added": total, **pal.stats()})
                else:
                    self._send(200, pal.stats())
            except Exception as e:  # noqa: BLE001
                self._send(500, {"ok": False, "error": f"vocab error: {e}"})
        elif path == "/training/submit" or path == "/training/jobs":
            if not TRAINING_ENABLED:
                self._send(503, {"ok": False, "error": "lora trainer unavailable"})
                return
            host = self.headers.get("Host", "") or f"{os.environ.get('MOSH_SERVICE_HOST', '127.0.0.1')}:{os.environ.get('MOSH_SERVICE_PORT', '8770')}"
            record = _create_training_job_record(data, host)
            if record.pop("status_code", 0):
                code = record.pop("status_code", 500)
                self._send(code, record)
                return
            self._send(200, record)
        elif path == "/training/cancel":
            jid = data.get("jobId", "")
            with _training_lock:
                if jid in _training_jobs:
                    _training_jobs[jid]["cancel"] = True
            self._send(200, {"ok": True})
        elif path == "/training/import-registry":
            # A garbled, empty, or registry-less body must NOT clobber the rights
            # registry: reject it with 400 and leave the on-disk registry untouched.
            # An empty POST body (Content-Length 0) decodes to {} with
            # _json_malformed=False, same as a well-formed object missing the
            # "registry" key entirely -- both must be rejected explicitly rather
            # than silently defaulting to {} (which would wipe the registry). A
            # body that spells out "registry": {} still clears it, on purpose.
            if (
                getattr(self, "_json_malformed", False)
                or not isinstance(data, dict)
                or "registry" not in data
            ):
                self._send(400, {"ok": False, "error": "malformed JSON body"})
                return
            registry = data.get("registry")
            if not isinstance(registry, dict):
                self._send(400, {"ok": False, "error": "registry must be an object"})
                return
            save_registry(_training_registry_path(), registry)
            self._send(200, {"ok": True})
        elif path == "/training/activate":
            state = _load_training_state()
            state["activeAdapterId"] = str(data.get("adapterId", "")).strip()
            state["activeAdapterPath"] = str(data.get("adapterPath", "")).strip()
            state["activeCorpusHash"] = str(data.get("corpusHash", "")).strip()
            _save_training_state(state)
            self._send(200, {"ok": True, "state": state})
        else:
            self._send(404, {"ok": False, "error": f"unknown path: {path}"})

    def log_message(self, fmt: str, *args) -> None:
        if os.environ.get("MOSH_SERVICE_LOG_HTTP", "0") != "1":
            return
        try:
            sys.stderr.write("[service] " + (fmt % args) + "\n")
        except OSError:
            pass


def _write_quietly(path: str, text: str) -> None:
    if not path:
        return
    try:
        with open(path, "w") as f:
            f.write(text)
    except OSError:
        pass


def _bind_with_fallback(host: str, port: int, tries: int = 10):
    """Bind ThreadingHTTPServer on `port`, falling back to the next few ports on collision
    (a non-Mosh squatter we must not kill). Returns (httpd, actual_port)."""
    last = None
    for p in range(port, port + tries):
        try:
            return ThreadingHTTPServer((host, p), Handler), p
        except OSError as e:  # EADDRINUSE (and friends) → try the next port
            last = e
    raise last


def main() -> int:
    host = os.environ.get("MOSH_SERVICE_HOST", "127.0.0.1")
    port = int(os.environ.get("MOSH_SERVICE_PORT", "8770"))
    threading.Thread(target=_worker_loop, daemon=True).start()
    threading.Thread(target=_training_worker_loop, daemon=True).start()
    if SA3_ENABLED and stable_audio3_adapter.backend_name() == "mlx":
        # Pre-load the judge model off the worker thread so the first render's QA
        # is ~1–2s, not ~25s. Background + best-effort: never blocks /health.
        from sa3 import qa  # noqa: PLC0415
        threading.Thread(target=qa.warm, daemon=True).start()
    httpd, port = _bind_with_fallback(host, port)
    # C3 — tell the host which port we actually bound (it may differ from the requested one
    # if a non-Mosh process held it). The host adopts this for its base URL.
    _write_quietly(os.environ.get("MOSH_SERVICE_PORTFILE", "").strip(), str(port))
    # C2 — record our PID *and bound port* so a future Mosh launch can REAP us if we're
    # orphaned/wedged (a crashed Mosh leaves a multi-GB MLX process squatting the port). The
    # port lets the reaper kill ONLY a stale service on the port it actually needs (so a
    # second instance on a different port never kills a healthy one). Removed on exit.
    pidfile = os.environ.get("MOSH_SERVICE_PIDFILE", "").strip()
    if pidfile:
        _write_quietly(pidfile, f"{os.getpid()} {port}")
        import atexit  # noqa: PLC0415
        atexit.register(lambda: os.path.exists(pidfile) and os.remove(pidfile))
    mode = "FakeAdapter + StableAudio3" if SA3_ENABLED else "FakeAdapter"
    sys.stderr.write(f"[service] Mosh generative service v{SERVICE_VERSION} "
                     f"on http://{host}:{port} ({mode}) build={SERVICE_BUILD}\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
