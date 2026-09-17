"""Deterministic direct-render protocol checks; fixture audio is not model evidence.

Run: python3 -m pytest -q service/scripts/direct_render_test.py
"""
from __future__ import annotations

import hashlib
import http.client
import json
import os
import sys
import threading
import wave
from contextlib import closing
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["MOSH_ENABLE_SA3"] = "0"
import server  # noqa: E402
from direct_render import JsonMap  # noqa: E402


@pytest.fixture
def http_service(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(server, "SA3_ENABLED", True)
    monkeypatch.setattr(server.stable_audio3_adapter, "backend_name", lambda: "mlx")
    monkeypatch.delenv("MOSH_DIRECT_RENDER_TEST_FIXTURE", raising=False)
    monkeypatch.setattr(server, "_jobs", {})
    monkeypatch.setattr(server, "_maybe_release_sa3", lambda _: None)
    with ThreadingHTTPServer(("127.0.0.1", 0), server.Handler) as listener:
        thread = threading.Thread(target=listener.serve_forever)
        thread.start()
        try:
            yield listener.server_port
        finally:
            listener.shutdown()
            thread.join(timeout=5)


def request(port: int, endpoint: str, payload: JsonMap | None = None) -> tuple[int, JsonMap]:
    with closing(http.client.HTTPConnection("127.0.0.1", port, timeout=5)) as client:
        client.request("GET" if payload is None else "POST", endpoint,
                       body=None if payload is None else json.dumps(payload),
                       headers={"Content-Type": "application/json"})
        response = client.getresponse()
        return response.status, json.loads(response.read())


@pytest.fixture
def submission(tmp_path: Path) -> JsonMap:
    source = tmp_path / "synthetic-source.wav"
    with wave.open(str(source), "wb") as audio:
        audio.setparams((2, 2, 8000, 32, "NONE", "not compressed"))
        audio.writeframes(b"\x01\x00\x02\x00" * 32)
    return {"adapter": "stable_audio3", "inputWav": str(source),
            "outputWav": str(tmp_path / "fixture-result.wav"),
            "params": {"decision_policy": "explicit", "request_id": "fixture-request-1",
                       "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                       "prompt": "test fixture", "seed": 0, "nl": 0.4, "lab": False,
                       "colors": [], "loras": [], "duration_s": 0.004}}


@pytest.mark.parametrize("adapter", ["fake", "sa3", "unknown"])
def test_explicit_request_rejects_noncanonical_adapter(http_service: int, submission: dict, adapter: str) -> None:
    # Given an explicit request with an adapter that can otherwise fall back to fake.
    submission["adapter"] = adapter
    # When it reaches the real HTTP boundary.
    status, body = request(http_service, "/submit", submission)
    # Then it is rejected without enqueueing work.
    assert status == 400 and body["ok"] is False
    assert not server._jobs


@pytest.mark.parametrize("key,value", [("request_id", ""), ("source_sha256", "wrong"),
                                      ("nl", float("nan")), ("lab", True),
                                      ("duration_s", -1), ("prompt", ["wrong"]), ("seed", 1.5)])
def test_explicit_request_rejects_malformed_identity_or_settings(http_service: int, submission: dict, key: str, value) -> None:
    # Given malformed direct settings.
    submission["params"][key] = value
    # When submitted over HTTP.
    status, body = request(http_service, "/submit", submission)
    # Then no render enters the queue.
    assert status == 400 and body["ok"] is False
    assert not server._jobs


def test_unknown_cancel_is_acknowledged_truthfully(http_service: int) -> None:
    # Given no job with this ID. When cancelled.
    status, body = request(http_service, "/cancel", {"jobId": "missing"})
    # Then legacy acknowledgement survives, but no cancellation is claimed.
    assert status == 200 and body["ok"] is True
    assert body["known"] is False and body["cancelRequested"] is False
    assert body["inferenceRunning"] is False


def test_cancel_during_render_preserves_assets_without_becoming_ready(http_service: int, submission: dict,
                                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    # Given a model-boundary fixture whose computation cannot be interrupted.
    entered, finish = threading.Event(), threading.Event()

    class FixtureAdapter:
        @staticmethod
        def render(input_wav: str, output_wav: str, params: JsonMap) -> JsonMap:
            entered.set()
            assert finish.wait(timeout=5)
            Path(output_wav).write_bytes(Path(input_wav).read_bytes())
            return {"ok": True, "adapter": "stable_audio3", "backend": "mlx",
                    "model_variant": "sa3-medium", "test_fixture": True}

    monkeypatch.setattr(server, "_adapter_for", lambda _: FixtureAdapter)
    _, submitted = request(http_service, "/submit", submission)
    job_id = submitted["jobId"]
    worker = threading.Thread(target=server._run_job, args=(job_id,))
    worker.start()
    try:
        assert entered.wait(timeout=5)
        # When cancellation arrives while the fixture is still computing.
        _, cancelled = request(http_service, "/cancel", {"jobId": job_id})
    finally:
        finish.set()
        worker.join(timeout=5)
    # Then cancellation does not claim stopped inference and completion stays cancelled.
    assert cancelled["known"] is True and cancelled["cancelRequested"] is True
    assert cancelled["inferenceRunning"] is True and cancelled["inferenceInterrupted"] is False
    _, status = request(http_service, f"/status?jobId={job_id}")
    assert status["status"] == "cancelled" and status["inferenceRunning"] is False
    assert Path(submission["outputWav"]).is_file()
    saved = json.loads(Path(submission["outputWav"] + ".manifest.json").read_text())
    assert saved["test_fixture"] is True
    assert saved["request_id"] == "fixture-request-1"
    assert saved["source_sha256"] == submission["params"]["source_sha256"]


def test_same_size_changed_source_fails_before_adapter(http_service: int, submission: dict,
                                                    monkeypatch: pytest.MonkeyPatch) -> None:
    # Given a queued source whose bytes change without its size changing.
    _, submitted = request(http_service, "/submit", submission)
    source = Path(submission["inputWav"])
    previous = source.read_bytes()
    source.write_bytes(previous[:-1] + b"\x03")
    called: list[str] = []
    monkeypatch.setattr(server, "_adapter_for", lambda name: called.append(name))
    # When the worker starts the job.
    server._run_job(submitted["jobId"])
    # Then the changed source cannot reach inference.
    _, status = request(http_service, f"/status?jobId={submitted['jobId']}")
    assert status["status"] == "error" and not called
    assert not Path(submission["outputWav"]).exists()


@pytest.mark.parametrize("manifest", [{"ok": True, "adapter": "fake", "test_fixture": True},
                                     {"ok": True, "adapter": "stable_audio3", "backend": "mlx",
                                      "model_variant": "sa3-medium", "test_fixture": True}])
def test_direct_job_rejects_false_manifest_or_missing_audio(http_service: int, submission: dict,
                                                         monkeypatch: pytest.MonkeyPatch,
                                                         manifest: JsonMap) -> None:
    # Given a broken adapter returning a fake manifest.
    class BrokenAdapter:
        @staticmethod
        def render(input_wav: str, output_wav: str, params: JsonMap) -> JsonMap:
            return manifest

    monkeypatch.setattr(server, "_adapter_for", lambda _: BrokenAdapter)
    _, submitted = request(http_service, "/submit", submission)
    # When the job completes.
    server._run_job(submitted["jobId"])
    # Then it is failed, never reported as an SA3 render.
    _, status = request(http_service, f"/status?jobId={submitted['jobId']}")
    assert status["status"] == "error"
    saved = json.loads(Path(submission["outputWav"] + ".manifest.json").read_text())
    assert saved == manifest


def test_fake_direct_render_requires_explicit_test_harness(http_service: int, submission: dict,
                                                         monkeypatch: pytest.MonkeyPatch) -> None:
    # Given an explicitly enabled disposable fixture harness, never a production default.
    monkeypatch.setenv("MOSH_DIRECT_RENDER_TEST_FIXTURE", "1")
    submission["adapter"] = "fake"
    # When the real job worker processes a direct fixture request.
    _, submitted = request(http_service, "/submit", submission)
    server._run_job(submitted["jobId"])
    # Then the result carries fixture identity and no evaluation.
    _, status = request(http_service, f"/status?jobId={submitted['jobId']}")
    manifest = status["manifest"]
    assert status["status"] == "ready"
    assert manifest["adapter"] == "fake" and manifest["backend"] == "fixture"
    assert manifest["test_fixture"] is True and manifest["evaluation"] == "disabled"
    assert manifest.get("pq") is None and not manifest.get("reasoning")


def test_queued_cancel_prevents_inference(http_service: int, submission: dict,
                                        monkeypatch: pytest.MonkeyPatch) -> None:
    # Given a queued request.
    _, submitted = request(http_service, "/submit", submission)
    called: list[str] = []
    monkeypatch.setattr(server, "_adapter_for", lambda name: called.append(name))
    # When cancelled before its worker begins.
    _, cancel = request(http_service, "/cancel", {"jobId": submitted["jobId"]})
    server._run_job(submitted["jobId"])
    # Then it remains cancelled and never enters inference.
    assert cancel["status"] == "cancelled" and cancel["inferenceRunning"] is False
    assert not called and not Path(submission["outputWav"]).exists()


@pytest.mark.parametrize("status", ["ready", "error"])
def test_terminal_job_cancel_reports_no_new_cancellation(http_service: int, submission: dict, status: str) -> None:
    # Given a completed job.
    _, submitted = request(http_service, "/submit", submission)
    server._jobs[submitted["jobId"]]["status"] = status
    # When cancellation arrives too late.
    _, cancel = request(http_service, "/cancel", {"jobId": submitted["jobId"]})
    # Then the response preserves its terminal state without claiming success.
    assert cancel["known"] is True and cancel["cancelRequested"] is False
    assert cancel["status"] == status


@pytest.mark.parametrize("available,backend", [(False, "unavailable"), (True, "cuda")])
def test_unavailable_direct_backend_is_reported_before_enqueue(http_service: int, submission: dict,
                                                             monkeypatch: pytest.MonkeyPatch,
                                                             available: bool, backend: str) -> None:
    # Given no supported local direct backend.
    monkeypatch.setattr(server, "SA3_ENABLED", available)
    monkeypatch.setattr(server.stable_audio3_adapter, "backend_name", lambda: backend)
    # When submitted.
    code, body = request(http_service, "/submit", submission)
    # Then the response is unavailable and no fallback enters the queue.
    assert code == 503 and body["ok"] is False and not server._jobs


def test_cancelled_inference_still_counts_as_active_service_work(monkeypatch: pytest.MonkeyPatch) -> None:
    # Given a cancelled result with inference still running.
    monkeypatch.setattr(server, "_jobs", {"fixture": {"status": "cancelled", "inference_running": True}})
    # When the idle-shutdown guard checks work.
    active = server._render_active()
    # Then the process must remain alive to preserve the returned files.
    assert active is True


def test_colors_handshake_advertises_direct_decisions(http_service: int) -> None:
    code, body = request(http_service, "/colors")
    assert code == 200 and body["explicitRenderDecision"] is True
