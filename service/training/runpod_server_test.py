"""Hermetic golden for the RunPod training server ⇄ _remote_train client contract.

Starts service/training/runpod_server.py (FORCED fake backend — no GPU), then drives the
REAL client (service/training/trainer_job.py::_remote_train, via MOSH_TRAINING_BACKEND=
remote_http) against it end to end: submit a corpus bundle → poll → pull the artifact.
Asserts the returned `.safetensors` is a VALID dora-rows LoRA that service/loras/install.py
would enroll into the rack (so train→rack→Live closes). Stdlib + numpy-free; 3× deterministic.

Run via gate.sh run_py_tests (named *_test.py).
"""
import base64
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent          # service/training
SERVICE = HERE.parent                            # service
sys.path.insert(0, str(SERVICE))


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _tiny_wav(path: Path) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100)
        w.writeframes(struct.pack("<" + "h" * 441, *([0] * 441)))   # 0.01s silence


def _make_bundle(root: Path) -> Path:
    (root / "sources").mkdir(parents=True, exist_ok=True)
    _tiny_wav(root / "sources" / "000-demo-a.wav")
    _tiny_wav(root / "sources" / "001-demo-b.wav")
    (root / "corpus.manifest.json").write_text(json.dumps({
        "schema_version": 1, "bundle_id": root.name, "bundle_hash": "deadbeef1234",
        "source_count": 2, "sources": [{"source_id": "demo-a"}, {"source_id": "demo-b"}],
    }), encoding="utf-8")
    return root


def _wait_health(url: str, timeout: float = 15.0) -> dict:
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(0.2)
    raise RuntimeError(f"server never became healthy: {last}")


def main() -> None:
    port = _free_port()
    env = dict(os.environ, MOSH_TRAINER_IMPL="fake", MOSH_TRAINER_PORT=str(port),
               MOSH_TRAINER_WORK=tempfile.mkdtemp(prefix="rp-work-"))
    proc = subprocess.Popen(
        [sys.executable, str(HERE / "runpod_server.py"), "--port", str(port), "--host", "127.0.0.1"],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        health = _wait_health(f"http://127.0.0.1:{port}/health")
        assert health["ok"] and health["backend"] == "fake", f"health: {health}"

        td = Path(tempfile.mkdtemp(prefix="rp-client-"))
        bundle = _make_bundle(td / "corpus-abc")
        out = td / "out"

        # drive the REAL client against the server
        os.environ["MOSH_TRAINING_BACKEND"] = "remote_http"
        os.environ["MOSH_TRAINING_REMOTE_URL"] = f"http://127.0.0.1:{port}"
        os.environ["MOSH_TRAINING_REMOTE_POLL_SECONDS"] = "0.2"
        os.environ["MOSH_TRAINING_REMOTE_TIMEOUT_SECONDS"] = "60"
        from training.trainer_job import train, backend_name  # noqa: E402
        assert backend_name() == "remote_http", backend_name()

        res = train(str(bundle), str(out), {"rank": 16, "steps": 10, "base_model": "medium-base"})
        assert res.get("ok") and res.get("backend") == "remote_http", res
        assert res.get("remote_job_id"), "no remote_job_id"
        art = Path(res["artifact_path"])
        man = Path(res["manifest_path"])
        assert art.is_file() and man.is_file(), (art, man)

        # the returned artifact is a REAL, install.py-acceptable dora-rows LoRA
        from sa3 import lora_merge as LM  # noqa: E402
        tensors, meta = LM.read_safetensors(str(art))
        cfg = json.loads(meta.get("lora_config", "{}"))
        assert cfg.get("adapter_type") == "dora-rows", cfg
        groups = LM.group_lora(tensors)
        assert groups, "no LoRA modules in the returned artifact"
        for module, parts in groups.items():
            assert {"lora_A", "lora_B", "magnitude"} <= set(parts), (module, list(parts))

        from loras import install as INSTALL  # noqa: E402
        adapter_type, n_modules = INSTALL._validate(str(art))
        assert adapter_type == "dora-rows" and n_modules >= 1, (adapter_type, n_modules)

        # the manifest round-tripped from the server
        mj = json.loads(man.read_text())
        assert mj.get("bundle_hash") == "deadbeef1234", mj

        # error path: unknown job id → 404 with an error
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/training/jobs/nope")
            raise AssertionError("expected 404 for unknown job")
        except urllib.error.HTTPError as e:
            assert e.code == 404, e.code

        print(f"runpod_server_test: OK (submit→poll→artifact; dora-rows {n_modules} module(s), "
              f"install-valid; manifest round-trip; 404 on unknown job)")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    main()
