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
import os
import queue
import subprocess
import sys
import threading
import time
import uuid
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
from adapters import fake_adapter  # noqa: E402
from adapters import stable_audio3_adapter  # noqa: E402  (path-only checks; heavy imports stay lazy)
from training import lora_trainer_adapter  # noqa: E402
from training.corpus_bundle import build_corpus_bundle  # noqa: E402
from training.rights import load_registry, save_registry, write_json  # noqa: E402
from training.trainer_job import train as train_lora  # noqa: E402

SERVICE_VERSION = "0.3.0"
START_TIME = time.time()
SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
SA3_ENABLED = os.environ.get("MOSH_ENABLE_SA3", "1") == "1" and stable_audio3_adapter.available()
TRAINING_ENABLED = lora_trainer_adapter.available()


def _basic_pitch_py() -> str:
    """The dedicated transcribe venv's python (set by setup-transcribe.sh via
    .transcribe.env -> BASIC_PITCH_PY), else the conventional default path."""
    env = os.environ.get("BASIC_PITCH_PY", "").strip()
    return env or os.path.join(SERVICE_DIR, "transcribe", ".venv", "bin", "python")


def _transcribe_available() -> bool:
    """True when the Basic Pitch venv exists (checked live so a freshly-run setup
    works without a service restart). The /transcribe endpoint surfaces any deeper
    import error from the subprocess itself."""
    return os.path.isfile(_basic_pitch_py())


def _colorrack_hash() -> str:
    try:
        from colors import runtime as CR
        return hashlib.md5(json.dumps(CR.registry(), sort_keys=True).encode()).hexdigest()[:8]
    except Exception:  # noqa: BLE001
        return "none"


# service_build feeds the native render-cache fingerprint: changing the engine/colors
# must invalidate cached renders, so it encodes the carve identity.
if SA3_ENABLED:
    SERVICE_BUILD = (f"sa3-1.0.0+{stable_audio3_adapter.backend_name()}"
                     f"+colors{_colorrack_hash()}+sec{os.environ.get('SA3_SECONDS', '8.0')}")
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
    data = {}
    try:
        with open(_training_state_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}
    data.setdefault("activeAdapterId", "")
    data.setdefault("activeAdapterPath", "")
    data.setdefault("activeCorpusHash", "")
    data.setdefault("jobs", [])
    data.setdefault("adapters", [])
    return data


def _save_training_state(state: dict) -> None:
    write_json(_training_state_path(), state)


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
        if adapter_id == "fake":
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
        manifest = ad.render(job["input_wav"], job["output_wav"], job["params"])
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

    def _read_json(self) -> dict:
        n = int(self.headers.get("Content-Length", 0))
        if n <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:  # noqa: BLE001
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
            adapters = ["fake"] + (["stable_audio3"] if SA3_ENABLED else [])
            self._send(200, {"ok": True, "service": "mosh-generative",
                             "version": SERVICE_VERSION, "build": SERVICE_BUILD,
                             "uptime_s": round(time.time() - START_TIME, 1),
                             "adapters": adapters, "transcribe": _transcribe_available()})
        elif path == "/capabilities":
            adapters = [FAKE_ADAPTER] + ([_sa3_descriptor()] if SA3_ENABLED else [])
            training = [_training_descriptor()] if TRAINING_ENABLED else []
            self._send(200, {"ok": True, "adapters": adapters, "training": training,
                             "transcribe": {"available": _transcribe_available(), "modes": ["mono", "poly"]},
                             "service_build": SERVICE_BUILD})
        elif path == "/colors":
            try:
                from colors import runtime as CR
                self._send(200, {"ok": True, "colors": CR.descriptor(),
                                 "lab_alpha_max": CR._meta().get("lab_alpha_max", 0.4)})
            except Exception as e:  # noqa: BLE001
                self._send(503, {"ok": False, "error": f"colors unavailable: {e}", "colors": []})
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
            out = (proc.stdout or "").strip()
            try:
                payload = json.loads(out)
            except (json.JSONDecodeError, ValueError):
                tail = (proc.stderr or "").strip()[-400:]
                self._send(500, {"ok": False, "error": f"transcription failed: {tail or 'no output'}"})
                return
            self._send(200 if payload.get("ok") else 500, payload)
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
            registry = data.get("registry", {})
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
        sys.stderr.write("[service] " + (fmt % args) + "\n")


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
    httpd = ThreadingHTTPServer((host, port), Handler)
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
