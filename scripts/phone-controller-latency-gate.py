#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import signal
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_APP = ROOT / "build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh"
DEFAULT_ARTIFACT_ROOT = ROOT / "_preserved_artifacts" / (
    f"{datetime.now().strftime('%Y-%m-%d')}-phone-controller-latency-gate"
)
DEFAULT_URL = "http://127.0.0.1:47873"
DEFAULT_UI_URL = "http://127.0.0.1:8770"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Launch Mosh's native companion server and measure phone-controller /command latency.",
    )
    parser.add_argument("--app", default=os.environ.get("MOSH_APP_BIN", str(DEFAULT_APP)))
    parser.add_argument("--url", default=os.environ.get("MOSH_PHONE_LATENCY_URL", DEFAULT_URL))
    parser.add_argument("--token", default=os.environ.get("MOSH_PHONE_LATENCY_TOKEN", "codex-latency"))
    parser.add_argument(
        "--samples",
        type=int,
        default=int(os.environ.get("MOSH_PHONE_LATENCY_SAMPLES", "10")),
        help="Measured samples to collect.",
    )
    parser.add_argument(
        "--warmup",
        type=int,
        default=int(os.environ.get("MOSH_PHONE_LATENCY_WARMUP", "0")),
        help="Unreported warmup commands to send before measured samples.",
    )
    parser.add_argument(
        "--startup-timeout",
        type=float,
        default=float(os.environ.get("MOSH_PHONE_LATENCY_STARTUP_TIMEOUT", "12")),
        help="Seconds to wait for /health when launching Mosh.",
    )
    parser.add_argument(
        "--artifact-root",
        default=os.environ.get("MOSH_PHONE_LATENCY_ARTIFACTS", str(DEFAULT_ARTIFACT_ROOT)),
    )
    parser.add_argument(
        "--reuse-server",
        action="store_true",
        help="Do not launch Mosh; measure an already-running server at --url.",
    )
    parser.add_argument(
        "--skip-ui-server",
        action="store_true",
        help="Do not start the local UI dev server before launching Mosh.",
    )
    parser.add_argument(
        "--ui-url",
        default=os.environ.get("MOSH_PHONE_LATENCY_UI_URL", DEFAULT_UI_URL),
        help="UI dev server URL used by the debug Mosh app.",
    )
    parser.add_argument(
        "--max-median-ms",
        type=float,
        default=None,
        help="Optional failure threshold for median command latency.",
    )
    parser.add_argument(
        "--max-p95-ms",
        type=float,
        default=None,
        help="Optional failure threshold for p95 command latency.",
    )
    return parser.parse_args()


def percentile(values: list[float], percent: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = (len(ordered) - 1) * (percent / 100.0)
    lower = int(rank)
    upper = min(lower + 1, len(ordered) - 1)
    weight = rank - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def post_json(url: str, payload: dict[str, Any], timeout: float = 5.0) -> tuple[int, Any]:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = response.read().decode("utf-8", errors="replace")
        return response.status, json.loads(data)


def get_json(url: str, timeout: float = 2.0) -> tuple[int, Any]:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        data = response.read().decode("utf-8", errors="replace")
        return response.status, json.loads(data)


def http_ready(url: str, timeout: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return 200 <= response.status < 500
    except OSError:
        return False


def wait_for_http(url: str, timeout_seconds: float) -> bool:
    started = time.monotonic()
    while time.monotonic() - started < timeout_seconds:
        if http_ready(url):
            return True
        time.sleep(0.1)
    return False


def wait_for_health(base_url: str, timeout_seconds: float) -> tuple[bool, float, str | None]:
    started = time.monotonic()
    last_error = None
    while time.monotonic() - started < timeout_seconds:
        try:
            status, body = get_json(f"{base_url}/health")
            running = False
            if isinstance(body, dict):
                running = body.get("running") is True
                data = body.get("data")
                if isinstance(data, dict):
                    running = running or data.get("running") is True
            if status == 200 and running:
                return True, (time.monotonic() - started) * 1000.0, None
            last_error = f"unexpected /health response: status={status} body={body}"
        except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
            last_error = str(exc)
        time.sleep(0.1)
    return False, (time.monotonic() - started) * 1000.0, last_error


def launch_ui_server(log_path: Path, ui_url: str) -> subprocess.Popen[bytes] | None:
    if http_ready(ui_url):
        return None
    log_file = log_path.open("wb")
    return subprocess.Popen(
        ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", "8770"],
        cwd=str(ROOT / "ui"),
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )


def launch_mosh(app: Path, token: str, log_path: Path) -> subprocess.Popen[bytes]:
    if not app.exists() or not os.access(app, os.X_OK):
        raise SystemExit(f"missing executable Mosh app binary: {app}")

    env = os.environ.copy()
    env.update(
        {
            "MOSH_ENABLE_SA3": "0",
            "MOSH_LAB_FEED": "1",
            "MOSH_LAB_TOKEN": token,
            "MOSH_NO_AUDIO": "1",
        }
    )
    log_file = log_path.open("wb")
    return subprocess.Popen(
        [str(app)],
        cwd=str(ROOT),
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )


def command_payload(token: str, sample_index: int, warmup: bool) -> dict[str, Any]:
    return {
        "token": token,
        "command": {
            "command": "set_transport",
            "args": {
                "action": "stop",
                "controllerEvent": "TRANSPORT_TOGGLE",
                "issuedAtPhoneMs": time.time() * 1000.0,
                "latencyGate": True,
                "sampleIndex": sample_index,
                "source": "phone_controller",
                "warmup": warmup,
            },
        },
    }


def measure_command(base_url: str, token: str, sample_index: int, warmup: bool) -> dict[str, Any]:
    started = time.perf_counter_ns()
    result: dict[str, Any] = {
        "command": "set_transport",
        "controllerEvent": "TRANSPORT_TOGGLE",
        "sampleIndex": sample_index,
        "warmup": warmup,
    }
    try:
        status, body = post_json(f"{base_url}/command", command_payload(token, sample_index, warmup))
        elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000.0
        command_result = body.get("data") if isinstance(body, dict) else None
        command_ok = isinstance(command_result, dict) and bool(command_result.get("ok", False))
        envelope_ok = isinstance(body, dict) and bool(body.get("ok", False))
        result.update(
            {
                "elapsedMs": elapsed_ms,
                "envelopeOk": envelope_ok,
                "error": None,
                "httpStatus": status,
                "ok": status == 200 and envelope_ok and command_ok,
                "response": body,
            }
        )
    except Exception as exc:
        elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000.0
        result.update(
            {
                "elapsedMs": elapsed_ms,
                "envelopeOk": False,
                "error": str(exc),
                "httpStatus": None,
                "ok": False,
                "response": None,
            }
        )
    return result


def terminate_process(process: subprocess.Popen[bytes] | None) -> int | None:
    if process is None:
        return None
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)
    return process.returncode


def main() -> int:
    args = parse_args()
    if args.samples <= 0:
        raise SystemExit("--samples must be positive")
    if args.warmup < 0:
        raise SystemExit("--warmup cannot be negative")

    run_id = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = Path(args.artifact_root).resolve() / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    artifact = out_dir / "phone-controller-latency.json"
    launch_log = out_dir / "mosh-latency-launch.log"
    ui_log = out_dir / "ui-dev-server.log"

    process: subprocess.Popen[bytes] | None = None
    ui_process: subprocess.Popen[bytes] | None = None
    if not args.reuse_server:
        if not args.skip_ui_server:
            ui_process = launch_ui_server(ui_log, args.ui_url)
            if ui_process is not None and not wait_for_http(args.ui_url, args.startup_timeout):
                terminate_process(ui_process)
                raise SystemExit(f"timed out waiting for UI server at {args.ui_url}")
        process = launch_mosh(Path(args.app), args.token, launch_log)

    def stop_from_signal(signum: int, _frame: Any) -> None:
        terminate_process(process)
        terminate_process(ui_process)
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, stop_from_signal)
    signal.signal(signal.SIGINT, stop_from_signal)

    health_ok, health_wait_ms, health_error = wait_for_health(args.url, args.startup_timeout)
    warmup_samples: list[dict[str, Any]] = []
    samples: list[dict[str, Any]] = []

    if health_ok:
        for sample_index in range(args.warmup):
            warmup_samples.append(measure_command(args.url, args.token, sample_index, True))
        for sample_index in range(args.samples):
            samples.append(measure_command(args.url, args.token, sample_index, False))

    latencies = [float(sample["elapsedMs"]) for sample in samples if sample.get("ok") is True]
    errors = [sample for sample in samples + warmup_samples if sample.get("ok") is not True]
    thresholds: dict[str, Any] = {
        "maxMedianMs": args.max_median_ms,
        "maxP95Ms": args.max_p95_ms,
        "violations": [],
    }
    latency_ms = {
        "max": max(latencies) if latencies else None,
        "median": statistics.median(latencies) if latencies else None,
        "min": min(latencies) if latencies else None,
        "p95": percentile(latencies, 95) if latencies else None,
    }

    if args.max_median_ms is not None and latency_ms["median"] is not None:
        if latency_ms["median"] > args.max_median_ms:
            thresholds["violations"].append(
                f"median {latency_ms['median']:.3f} ms exceeds {args.max_median_ms:.3f} ms"
            )
    if args.max_p95_ms is not None and latency_ms["p95"] is not None:
        if latency_ms["p95"] > args.max_p95_ms:
            thresholds["violations"].append(
                f"p95 {latency_ms['p95']:.3f} ms exceeds {args.max_p95_ms:.3f} ms"
            )

    return_code = terminate_process(process)
    ui_return_code = terminate_process(ui_process)
    status = "passed"
    if not health_ok or errors or thresholds["violations"]:
        status = "failed"

    report = {
        "artifact": str(artifact),
        "errorCount": len(errors),
        "errors": errors,
        "latencyMs": latency_ms,
        "launch": {
            "healthError": health_error,
            "healthOk": health_ok,
            "healthWaitMs": health_wait_ms,
            "log": str(launch_log),
            "processReturnCode": return_code,
            "reuseServer": bool(args.reuse_server),
        },
        "sampleCount": len(samples),
        "samples": samples,
        "status": status,
        "successCount": len(latencies),
        "target": {
            "command": "set_transport",
            "controllerEvent": "TRANSPORT_TOGGLE",
            "launchEnv": {
                "MOSH_ENABLE_SA3": "0",
                "MOSH_LAB_FEED": "1",
                "MOSH_NO_AUDIO": "1",
            },
            "server": "native Mosh RemoteCompanionServer",
            "token": args.token,
            "url": f"{args.url}/command",
        },
        "thresholds": thresholds,
        "uiServer": {
            "log": str(ui_log),
            "processReturnCode": ui_return_code,
            "started": ui_process is not None,
            "url": args.ui_url,
        },
        "warmupCount": len(warmup_samples),
        "warmupSamples": warmup_samples,
    }
    artifact.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if status == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
